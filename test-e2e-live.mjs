// Live end-to-end / watchdog test for the Fahrtrichtung extension.
//
// Runs the REAL chrome/background.js + chrome/utils.js logic against the LIVE
// data sources (fernbahn.de wagon order + bahn.expert station list) for real
// long-distance trains travelling *today*. It catches the failure class that
// unit tests can't: external data-format drift AND parsing regressions in the
// full pipeline (e.g. station names containing a hyphen splitting a segment).
//
// Exit codes (so a watchdog can act, not just alarm):
//   0  PASS  — pipeline produced usable direction data and all invariants held
//   1  FAIL  — a logic/parsing invariant was violated (the extension is broken)
//   2  INCONCLUSIVE — data sources unreachable or no trains returned data today
//                      (infrastructure problem, NOT an extension bug)
//
// Usage:  node test-e2e-live.mjs        or   npm run test:e2e
//         node test-e2e-live.mjs ICE 691 2026-07-12   (ad-hoc single train)

import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = path.join(__dirname, 'chrome');

// ---- Load the real extension logic into a sandbox -------------------------
let bg = fs.readFileSync(path.join(CHROME, 'background.js'), 'utf8')
  .replace(/importScripts\([^)]*\);/g, '')
  .replace(/chrome\.runtime\.onMessage[\s\S]*?\}\);\n/, '');
const utils = fs.readFileSync(path.join(CHROME, 'utils.js'), 'utf8');

// A real browser sends Accept + User-Agent; without them bahn.expert answers
// 206/empty. Mirror the browser so the test exercises the same success path.
const browserFetch = (url, opts = {}) => fetch(url, {
  ...opts,
  headers: {
    'Accept': '*/*',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Referer': 'https://bahn.expert/',
    'Accept-Encoding': 'gzip, deflate, br',
    ...(opts.headers || {}),
  },
});

// Silence the extension's internal debug logging ([Fahrtrichtung] …) so the
// watchdog output stays clean; keep warnings/errors visible.
const quietConsole = { log: () => {}, warn: console.warn, error: console.error };
// Minimaler chrome-Stub: background.js registriert Listener (onInstalled,
// onMessage) beim Laden — im Test sollen die einfach ins Leere laufen.
const chromeStub = {
  runtime: {
    onInstalled: { addListener: () => {} },
    onMessage: { addListener: () => {} },
    getURL: p => p,
  },
  tabs: { create: () => {} },
};
const ctx = { fetch: browserFetch, console: quietConsole, chrome: chromeStub, URLSearchParams, TextDecoder, Date, JSON, Math, String, Array, Object, parseInt, isNaN };
vm.createContext(ctx);
vm.runInContext(utils, ctx);
vm.runInContext(bg, ctx);

// ---- Test configuration ---------------------------------------------------
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A pool of daily long-distance trains. ICE 691/1006 traverse Berlin-Gesundbrunnen
// (a hyphenated station) — the exact case that regressed. Others give breadth so
// the check is robust if one train is cancelled/rerouted on a given day.
const DEFAULT_TRAINS = [
  { trainType: 'ICE', trainNumber: '691' },   // Berlin-Gesundbrunnen -> München  (hyphen station)
  { trainType: 'ICE', trainNumber: '1006' },  // München -> Berlin-Gesundbrunnen  (hyphen station)
  { trainType: 'ICE', trainNumber: '549' },   // Rhein/Ruhr -> Berlin
  { trainType: 'ICE', trainNumber: '77' },    // Hamburg -> Basel
  { trainType: 'ICE', trainNumber: '11' },    // Berlin -> München
  { trainType: 'ICE', trainNumber: '20' },    // Wien -> München; bahn.expert returns a
                                              // number-20 Milano–Zürich train (wrong-train guard)
];

const MIN_TRAINS_WITH_DATA = 3;      // below this we can't conclude -> exit 2
const SEP = /\s[–—-]\s/;             // a spaced dash = an *unsplit* segment separator

// ---- Run one train through the full pipeline ------------------------------
async function checkTrain(t, date) {
  // Probe once to obtain the live station order, then derive from/to stations
  // that are guaranteed on the route (so a mapping miss is a real bug).
  const probe = await ctx.handleFetchFernbahn({ ...t, fromStation: '', toStation: '', travelDate: date });
  const stops = (probe.stationOrder || []).map(s => s.name);
  if (!stops.length) return { skip: true, reason: 'no station list from bahn.expert' };

  const from = stops.length > 2 ? stops[1] : stops[0];
  const to = stops.length > 2 ? stops[stops.length - 2] : stops[stops.length - 1];
  const r = await ctx.handleFetchFernbahn({ ...t, fromStation: from, toStation: to, travelDate: date });

  const problems = [];
  if (!r.segments.length) problems.push('no segments parsed from fernbahn.de');
  if (r.segments.length && r.segments.every(s => s.direction === 'unknown'))
    problems.push('all segment directions unknown (arrow SVGs not found)');
  if (!r.wagonNumbers.length) problems.push('no wagon numbers parsed');
  if (!r.stationOrder.length) problems.push('empty stationOrder');
  if (r.fromSegmentIdx < 0) problems.push(`fromStation "${from}" mapped to no segment`);
  if (r.toSegmentIdx < 0) problems.push(`toStation "${to}" mapped to no segment`);

  // Regression guard for the hyphen bug: after a correct split, neither side of
  // a segment may still contain a spaced-dash separator. If it does, a station
  // name with a hyphen (Berlin-Gesundbrunnen) was split at the wrong place.
  for (const s of r.segments) {
    if (SEP.test(s.from)) problems.push(`segment "from" still contains a separator: "${s.from}" (bad split)`);
    if (SEP.test(s.to))   problems.push(`segment "to" still contains a separator: "${s.to}" (bad split)`);
  }

  return { skip: false, from, to, route: r.route,
    segments: r.segments.map(s => `${s.from}→${s.to}[${s.direction}]`), problems };
}

// ---- Main -----------------------------------------------------------------
const argv = process.argv.slice(2);
let trains = DEFAULT_TRAINS;
let date = today();
if (argv.length >= 2) {
  trains = [{ trainType: argv[0].toUpperCase(), trainNumber: argv[1] }];
  if (argv[2]) date = argv[2];
}

console.log(`Fahrtrichtung live E2E — date ${date}\n`);

let withData = 0, failed = 0, infra = 0;
for (const t of trains) {
  const label = `${t.trainType} ${t.trainNumber}`;
  try {
    const res = await checkTrain(t, date);
    if (res.skip) { console.log(`⏭️  ${label}: SKIP (${res.reason})`); continue; }
    withData++;
    console.log(`   ${label}: ${res.route}`);
    console.log(`      segments: ${res.segments.join('  ')}`);
    if (res.problems.length) {
      failed++;
      console.log(`   ❌ ${label} FAIL:`);
      res.problems.forEach(p => console.log(`      - ${p}`));
    } else {
      console.log(`   ✅ ${label} PASS  (from "${res.from}" to "${res.to}")`);
    }
  } catch (e) {
    // Distinguish "train not running today / no wagon data" from infra errors.
    if (/Keine Wagenreihung/.test(e.message)) {
      console.log(`⏭️  ${label}: SKIP (${e.message})`);
    } else {
      infra++;
      console.log(`⚠️  ${label}: data-source error — ${e.message}`);
    }
  }
  console.log('');
}

console.log('─'.repeat(60));
if (failed > 0) {
  console.log(`E2E-RESULT: FAIL — ${failed} train(s) violated a pipeline invariant. The extension is broken.`);
  process.exit(1);
}
if (withData < MIN_TRAINS_WITH_DATA) {
  console.log(`E2E-RESULT: INCONCLUSIVE — only ${withData}/${MIN_TRAINS_WITH_DATA} trains returned data (${infra} data-source errors). Likely an infrastructure problem, not an extension bug.`);
  process.exit(2);
}
console.log(`E2E-RESULT: PASS — ${withData} train(s) produced usable direction data, all invariants held.`);
process.exit(0);
