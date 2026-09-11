// fetch()-Ersatz fuer Node-Testharnesse, der ueber das curl-Binary geht.
//
// Warum: bahn.de sitzt hinter Akamai, das Node/undici am TLS-Fingerprint
// erkennt und mit 403 "OPS_BLOCKED" abweist — unabhaengig von User-Agent oder
// Headern. curl (und natuerlich Chrome, wo die Extension laeuft) kommen durch.
// Die Extension selbst nutzt das normale fetch() des Browsers; dieser Transport
// ist NUR fuer Tests/Recorder/Compare unter Node.
//
// Liefert ein minimales Response-aehnliches Objekt: ok, status, url, headers.get,
// text(), json(), arrayBuffer().

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Optionaler Proxy (z.B. Decodo rotating: neue Ausgangs-IP pro Request), damit
// Massenlaeufe (Recorder/Compare) nicht die eigene IP bei bahn.de/fernbahn.de
// verbrennen. Konfiguration: FAHRTRICHTUNG_PROXY=http://user:pass@host:port —
// als Env-Variable oder in .env.local im Repo-Root (gitignored).
function loadProxy() {
  if (process.env.FAHRTRICHTUNG_PROXY) return process.env.FAHRTRICHTUNG_PROXY;
  try {
    const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
    const m = fs.readFileSync(envFile, 'utf8').match(/^FAHRTRICHTUNG_PROXY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
const PROXY = loadProxy();
export const proxyActive = Boolean(PROXY);

const DEFAULT_HEADERS = {
  'Accept': 'application/json, text/html;q=0.9, */*;q=0.8',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'de-DE,de;q=0.9',
};

const META = '\n__CURL_META__ ';

export function curlFetch(url, opts = {}) {
  const headers = { ...DEFAULT_HEADERS, ...(opts.headers || {}) };
  const args = ['-s', '-S', '-L', '--compressed', '--max-time', String(opts.timeoutSec || 30),
    '-w', `${META}%{http_code} %{url_effective} %{content_type}`];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (PROXY && !opts.noProxy) args.push('-x', PROXY);
  if (opts.method && opts.method.toUpperCase() !== 'GET') args.push('-X', opts.method.toUpperCase());
  if (opts.body != null) args.push('--data-binary', typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
  args.push(url);

  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err && !stdout?.length) return reject(new Error(`curl failed: ${stderr?.toString() || err.message}`));
      const raw = stdout.toString('utf8');
      const metaIdx = raw.lastIndexOf(META);
      if (metaIdx < 0) return reject(new Error(`curl: no meta trailer (${stderr?.toString().trim()})`));
      const body = raw.slice(0, metaIdx);
      const [code, effUrl, contentType] = raw.slice(metaIdx + META.length).trim().split(' ');
      const status = Number(code) || 0;
      const bodyBuf = stdout.subarray(0, Buffer.byteLength(body, 'utf8'));
      resolve({
        ok: status >= 200 && status < 300,
        status,
        url: effUrl || url,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType || null : null) },
        text: async () => body,
        json: async () => JSON.parse(body),
        arrayBuffer: async () => bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength),
      });
    });
  });
}

// Drosselung: bahn.de nicht mit Anfragen fluten. Mindestabstand zwischen zwei
// Requests (global fuer den Prozess), damit auch bei Concurrency > 1 ein
// gleichmaessiger Takt entsteht.
let nextSlot = 0;
export function throttledCurlFetch(minGapMs = 150) {
  return async (url, opts) => {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + minGapMs;
    if (slot > now) await new Promise(r => setTimeout(r, slot - now));
    return curlFetch(url, opts);
  };
}
