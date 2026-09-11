#!/usr/bin/env node
// Deterministische Unit-Tests fuer die bahn.de-Anbindung — am ECHTEN Code
// (chrome/background.js + utils.js in einer vm-Sandbox) mit simuliertem fetch.
// Kein Netz. Prueft alles, was tests.html (Kopien einzelner Funktionen) nicht
// abdecken kann: Request-Reihenfolge, Zeitfenster, Retry/Backoff, Host-Fallback,
// Wrong-Train-Guard, kaputte Antworten, fernbahn-Fallback und die Extraktion des
// journeyHint aus dem bahn.de-Sitzplatzdialog (popup.js).
//
// Usage: node test-bahnde-unit.mjs        (Exit 0 = alles gruen)

import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = path.join(__dirname, 'chrome');
const bgSrc = fs.readFileSync(path.join(CHROME, 'background.js'), 'utf8')
  .replace(/importScripts\([^)]*\);/g, '')
  .replace(/chrome\.runtime\.onMessage[\s\S]*?\}\);\n/, '');
const utilsSrc = fs.readFileSync(path.join(CHROME, 'utils.js'), 'utf8');
const popupSrc = fs.readFileSync(path.join(CHROME, 'popup.js'), 'utf8');

let passed = 0, failed = 0;
function assert(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else { failed++; console.log(`  FAIL: ${desc}\n        got ${JSON.stringify(actual)}\n        exp ${JSON.stringify(expected)}`); }
}
function group(name) { console.log(`\n${name}`); }

// ---- Sandbox mit steuerbarem fetch ------------------------------------------
// routes: Array von { match: RegExp|fn, reply: fn(url, opts, callNo) -> {status, json|text|headers} }
function makeCtx(routes, { fastSleep = true } = {}) {
  const calls = [];
  const fetchMock = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const r of routes) {
      const hit = typeof r.match === 'function' ? r.match(url) : r.match.test(url);
      if (!hit) continue;
      const rep = await r.reply(url, opts, calls.filter(c => (typeof r.match === 'function' ? r.match(c.url) : r.match.test(c.url))).length);
      if (rep instanceof Error) throw rep;
      const status = rep.status ?? 200;
      const body = rep.text != null ? rep.text : JSON.stringify(rep.json ?? null);
      return {
        ok: status >= 200 && status < 300, status, url: rep.url || url,
        headers: { get: k => (rep.headers || {})[k.toLowerCase()] ?? null },
        text: async () => body, json: async () => JSON.parse(body),
      };
    }
    throw new Error('unrouted fetch: ' + url);
  };
  const ctx = {
    fetch: fetchMock, calls,
    console: { log() {}, warn() {}, error() {} },
    chrome: { runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} }, getURL: p => p }, tabs: { create() {} } },
    URLSearchParams, TextDecoder, DataView, Uint8Array, AbortSignal,
    setTimeout: fastSleep ? (fn) => { fn(); return 0; } : setTimeout, clearTimeout,
    Date, JSON, Math, String, Array, Object, Number, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
  };
  vm.createContext(ctx);
  vm.runInContext(utilsSrc, ctx);
  vm.runInContext(bgSrc, ctx);
  return ctx;
}

// ---- Fixtures -----------------------------------------------------------------
const FERNBAHN_HTML = `
<div class="reihungsverzeichnis-eintrag"><div class="zugnr">ICE 1005</div>
<div class="vonbis">Berlin-Gesundbrunnen &ndash; München Hbf</div>
<div class="richtungswechsel"><img src="/images/pfeillinks.svg"> Berlin-Gesundbrunnen &ndash; München Hbf<br></div>
<div class="wagenreihung"><div class="wagen"><span class="wagen-nummer">21</span></div><div class="wagen"><span class="wagen-nummer">29</span></div></div>
<div class="zugname">Reihung gültig tgl</div><a href="?zug_id=20260101005">ansehen</a>
<!-- reihungsverzeichnis-eintrag -->`;
const FERNBAHN_DETAIL = `<span id="zls-daten-bahnhof-start">Berlin-Gesundbrunnen</span><span id="zls-daten-bahnhof-via1">Berlin Hbf - Halle(Saale)</span><span id="zls-daten-bahnhof-ziel">München</span>`;
const ENTRY = (name, zeit, id) => ({ zeit, journeyId: id, verkehrmittel: { name } });
const RUN = { zugName: 'ICE 1005', halte: [
  { name: 'Berlin Gesundbrunnen', extId: '8011102', abfahrt: { sollzeit: '2026-09-12T08:26:00' } },
  { name: 'Berlin Hbf', extId: '8098160', ankunft: { sollzeit: '2026-09-12T08:32:00' }, abfahrt: { sollzeit: '2026-09-12T08:36:00' } },
  { name: 'Halle(Saale)Hbf', extId: '8010159', ankunft: { sollzeit: '2026-09-12T09:43:00' }, abfahrt: { sollzeit: '2026-09-12T09:45:00' } },
  { name: 'München Hbf', extId: '8000261', ankunft: { sollzeit: '2026-09-12T12:46:00' } },
] };
const HINT = { trainNumber: '1005', departureEva: '8098160', departureTime: '2026-09-12T08:36:00' };
const qs = url => Object.fromEntries(new URL(url).searchParams);
const fernbahnRoutes = [
  { match: /fernbahn\.de\/datenbank\/suche\/\?fahrplan_jahr/, reply: () => ({ text: FERNBAHN_HTML }) },
  { match: /fernbahn\.de\/datenbank\/suche\/\?zug_id/, reply: () => ({ text: FERNBAHN_DETAIL }) },
];
const baseReq = { trainType: 'ICE', trainNumber: '1005', fromStation: 'Berlin Hbf', toStation: 'München Hbf', travelDate: '2026-09-12' };

// ==============================================================================
group('Hint-Pfad: ein Abfahrtstafel-Aufruf am exakten Bahnhof/Zeitpunkt');
{
  const ctx = makeCtx([...fernbahnRoutes,
    { match: /abfahrten/, reply: url => ({ json: { entries: [ENTRY('ICE 371', '2026-09-12T08:31:00', 'j371'), ENTRY('ICE 1005', '2026-09-12T08:36:00', 'j1005')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: RUN }) },
  ]);
  const r = await ctx.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  const board = ctx.calls.filter(c => /abfahrten/.test(c.url));
  assert('genau ein Abfahrtstafel-Aufruf', board.length, 1);
  assert('am gehinteten Bahnhof', qs(board[0].url).ortExtId, '8098160');
  assert('Fenster beginnt 2 Minuten vor Abfahrt', qs(board[0].url).zeit, '08:34:00');
  assert('Datum aus dem Hint', qs(board[0].url).datum, '2026-09-12');
  assert('Produktfilter ICE/EC_IC/IR gesetzt', new URL(board[0].url).searchParams.getAll('verkehrsmittel[]'), ['ICE', 'EC_IC', 'IR']);
  assert('journeyId des Namens-UND-Minuten-Treffers wird fuer fahrt genutzt', qs(ctx.calls.find(c => /fahrt\?/.test(c.url)).url).journeyId, 'j1005');
  assert('Stationsliste aus dem Zuglauf', r.stationOrder.map(s => s.name), ['Berlin Gesundbrunnen', 'Berlin Hbf', 'Halle(Saale)Hbf', 'München Hbf']);
  assert('Zeiten uebernommen', [r.stationOrder[1].arr, r.stationOrder[1].dep], ['2026-09-12T08:32:00', '2026-09-12T08:36:00']);
  assert('stationSource = bahn.de', r.stationSource, 'bahn.de');
  assert('kein fernbahn-Detailabruf noetig', ctx.calls.some(c => /zug_id/.test(c.url)), false);
  assert('Segmentzuordnung from/to', [r.fromSegmentIdx, r.toSegmentIdx], [0, 0]);
  assert('fernbahn-Teil unveraendert', [r.route, r.wagonNumbers, r.segments[0].direction], ['Berlin-Gesundbrunnen – München Hbf', ['21', '29'], 'left']);
}

group('Hint-Pfad: Minute bevorzugt, sonst Name; zweites Fenster T-45');
{
  // Zwei Laeufe mit gleichem Namen: der zur gehinteten Minute gewinnt
  const ctx = makeCtx([...fernbahnRoutes,
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('ICE 1005', '2026-09-12T08:05:00', 'early'), ENTRY('ICE 1005', '2026-09-12T08:36:00', 'exact')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: RUN }) },
  ]);
  await ctx.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  assert('exakte Minute gewinnt', qs(ctx.calls.find(c => /fahrt\?/.test(c.url)).url).journeyId, 'exact');

  // Erstes Fenster leer -> zweites Fenster 45 min frueher, Namenstreffer reicht
  const ctx2 = makeCtx([...fernbahnRoutes,
    { match: /abfahrten/, reply: (url, o, n) => ({ json: { entries: n === 1 ? [] : [ENTRY('ICE 1005', '2026-09-12T08:30:00', 'late-window')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: RUN }) },
  ]);
  const r2 = await ctx2.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  const b2 = ctx2.calls.filter(c => /abfahrten/.test(c.url));
  assert('zwei Fenster probiert', b2.length, 2);
  assert('zweites Fenster = T-45', qs(b2[1].url).zeit, '07:51:00');
  assert('Namenstreffer ohne Minute akzeptiert', r2.stationSource, 'bahn.de');

  // Gleiche Nummer, andere Fernverkehrsgattung (fernbahn "ICE", bahn.de "IC"): wird genommen
  const ctx3 = makeCtx([...fernbahnRoutes,
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('IC 1005', '2026-09-12T08:36:00', 'ic')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: RUN }) },
  ]);
  const r3 = await ctx3.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  assert('IC 1005 wird fuer ICE 1005 akzeptiert (gleiche Nummer, Fernverkehr)', [r3.stationSource, qs(ctx3.calls.find(c => /fahrt\?/.test(c.url)).url).journeyId], ['bahn.de', 'ic']);

  // S-Bahn/Bus gleicher Nummer: NICHT nehmen -> Scan -> fernbahn-Fallback
  const ctx3b = makeCtx([...fernbahnRoutes,
    { match: /abfahrten|ankuenfte/, reply: () => ({ json: { entries: [ENTRY('S 1005', '2026-09-12T08:36:00', 's'), ENTRY('Bus 1005', '2026-09-12T08:36:00', 'bus')] } }) },
    { match: /orte/, reply: () => ({ json: [] }) },
  ]);
  const r3b = await ctx3b.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  assert('S 1005 / Bus 1005 werden nicht als ICE 1005 genommen -> fernbahn-Fallback', r3b.stationSource, 'fernbahn');
  assert('Fallback-Liste von der fernbahn-Detailseite', r3b.stationOrder.map(s => s.name), ['Berlin-Gesundbrunnen', 'Berlin Hbf', 'Halle(Saale)', 'München']);
  assert('Fallback-Liste ohne Zeiten', r3b.stationOrder.every(s => !s.dep && !s.arr), true);
}

group('Scan-Pfad ohne Hint: Startbahnhof aufloesen, stundenweise ab 04:00, dann Endbahnhof-Ankuenfte');
{
  const seen = [];
  const ctx = makeCtx([...fernbahnRoutes,
    { match: /orte/, reply: url => ({ json: [{ type: 'ST', extId: qs(url).suchbegriff.startsWith('Berlin') ? '8011102' : '8000261', name: qs(url).suchbegriff, products: ['ICE'] }] }) },
    { match: /abfahrten/, reply: url => { seen.push(qs(url).zeit); return { json: { entries: qs(url).zeit === '13:00:00' ? [ENTRY('ICE 1005', '2026-09-12T13:09:00', 'scan-hit')] : [] } }; } },
    { match: /fahrt\?/, reply: () => ({ json: RUN }) },
  ]);
  const r = await ctx.handleFetchFernbahn(baseReq);
  assert('Startbahnhof aus fernbahn-Route aufgeloest', qs(ctx.calls.find(c => /orte/.test(c.url)).url).suchbegriff, 'Berlin-Gesundbrunnen');
  assert('Scan beginnt 04:00 und stoppt beim Treffer 13:00', seen, ['04:00:00', '05:00:00', '06:00:00', '07:00:00', '08:00:00', '09:00:00', '10:00:00', '11:00:00', '12:00:00', '13:00:00']);
  assert('Treffer-journeyId genutzt', qs(ctx.calls.find(c => /fahrt\?/.test(c.url)).url).journeyId, 'scan-hit');
  assert('Ergebnis via bahn.de', r.stationSource, 'bahn.de');

  // Nirgends gefunden: alle 24 Stunden am Start, dann 24 am Ziel (ankuenfte), dann fernbahn-Fallback
  const ctx2 = makeCtx([...fernbahnRoutes,
    { match: /orte/, reply: url => ({ json: [{ type: 'ST', extId: qs(url).suchbegriff.startsWith('Berlin') ? '8011102' : '8000261', name: qs(url).suchbegriff }] }) },
    { match: /abfahrten|ankuenfte/, reply: () => ({ json: { entries: [] } }) },
  ]);
  const r2 = await ctx2.handleFetchFernbahn(baseReq);
  assert('24 Abfahrten-Fenster am Start', ctx2.calls.filter(c => /abfahrten/.test(c.url)).length, 24);
  assert('24 Ankunfts-Fenster am Ziel', ctx2.calls.filter(c => /ankuenfte/.test(c.url)).length, 24);
  assert('Ankuenfte am Endbahnhof', qs(ctx2.calls.find(c => /ankuenfte/.test(c.url)).url).ortExtId, '8000261');
  assert('dann fernbahn-Fallback', r2.stationSource, 'fernbahn');
}

group('Robustheit: 429/5xx-Backoff, Host-Fallback, kaputte Antworten');
{
  // 429 zweimal, dann ok — gleicher Host
  const ctx = makeCtx([...fernbahnRoutes,
    { match: /abfahrten/, reply: (u, o, n) => n <= 2 ? { status: 429, text: '' } : { json: { entries: [ENTRY('ICE 1005', '2026-09-12T08:36:00', 'ok')] } } },
    { match: /fahrt\?/, reply: () => ({ json: RUN }) },
  ]);
  const r = await ctx.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  assert('nach zwei 429 beim dritten Versuch erfolgreich', r.stationSource, 'bahn.de');
  assert('alle Versuche auf www.bahn.de', ctx.calls.filter(c => /abfahrten/.test(c.url)).every(c => c.url.startsWith('https://www.bahn.de')), true);

  // www dauerhaft 503 -> int.bahn.de uebernimmt
  const ctx2 = makeCtx([...fernbahnRoutes,
    { match: /www\.bahn\.de.*abfahrten/, reply: () => ({ status: 503, text: '' }) },
    { match: /int\.bahn\.de.*abfahrten/, reply: () => ({ json: { entries: [ENTRY('ICE 1005', '2026-09-12T08:36:00', 'int')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: RUN }) },
  ]);
  const r2 = await ctx2.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  assert('www 3x versucht, dann int.bahn.de', [ctx2.calls.filter(c => /www\.bahn\.de.*abfahrten/.test(c.url)).length, ctx2.calls.filter(c => /int\.bahn\.de.*abfahrten/.test(c.url)).length], [3, 1]);
  assert('Ergebnis via int.bahn.de', r2.stationSource, 'bahn.de');

  // 403 (Akamai) ist kein Retry-Fall: sofort weiter zum naechsten Host, dann Fallback
  const ctx3 = makeCtx([...fernbahnRoutes,
    { match: /abfahrten/, reply: () => ({ status: 403, text: '{"code":"OPS_BLOCKED"}' }) },
    { match: /orte/, reply: () => ({ status: 403, text: '' }) },
  ]);
  const r3 = await ctx3.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  assert('403 -> fernbahn-Fallback, Popup zeigt trotzdem Richtung', [r3.stationSource, r3.segments.length], ['fernbahn', 1]);
  assert('403 wird pro Host genau einmal probiert (www + int), kein sinnloser Retry', ctx3.calls.filter(c => /abfahrten/.test(c.url)).length, 2);

  // HTML statt JSON (z.B. Wartungsseite) -> kein Absturz, Fallback
  const ctx4 = makeCtx([...fernbahnRoutes,
    { match: /abfahrten/, reply: () => ({ text: '<html>Wartung</html>' }) },
    { match: /orte/, reply: () => ({ text: '<html>Wartung</html>' }) },
  ]);
  const r4 = await ctx4.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  assert('HTML-Antwort -> fernbahn-Fallback', r4.stationSource, 'fernbahn');

  // Zuglauf ohne halte -> Fallback
  const ctx5 = makeCtx([...fernbahnRoutes,
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('ICE 1005', '2026-09-12T08:36:00', 'x')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: { zugName: 'ICE 1005', halte: [] } }) },
  ]);
  assert('leerer Zuglauf -> fernbahn-Fallback', (await ctx5.handleFetchFernbahn({ ...baseReq, journeyHint: HINT })).stationSource, 'fernbahn');

  // Netzwerkfehler (fetch wirft) -> Fallback, kein Absturz
  const ctx6 = makeCtx([...fernbahnRoutes,
    { match: /bahn\.de/, reply: () => new Error('ECONNRESET') },
  ]);
  assert('Netzwerkfehler -> fernbahn-Fallback', (await ctx6.handleFetchFernbahn({ ...baseReq, journeyHint: HINT })).stationSource, 'fernbahn');

  // fernbahn selbst down -> klarer Fehler (wie vorher)
  const ctx7 = makeCtx([{ match: /fernbahn/, reply: () => ({ status: 504, text: '' }) }]);
  let msg = '';
  try { await ctx7.handleFetchFernbahn(baseReq); } catch (e) { msg = e.message; }
  assert('fernbahn 504 -> Fehler "fernbahn.de returned 504"', msg, 'fernbahn.de returned 504');
}

group('Wrong-Train-Guard: Liste ohne Bezug zur fernbahn-Route wird verworfen');
{
  const ctx = makeCtx([...fernbahnRoutes,
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('ICE 1005', '2026-09-12T08:36:00', 'wrong')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: { zugName: 'ICE 1005', halte: [
      { name: 'Milano Centrale', abfahrt: { sollzeit: '2026-09-12T08:36:00' } }, { name: 'Zürich HB', ankunft: { sollzeit: '2026-09-12T12:00:00' } }] } }) },
  ]);
  const r = await ctx.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  assert('verworfen -> fernbahn-Fallback', r.stationSource, 'fernbahn');
}

group('Zeitmathematik: Dauer aus lokalen bahn.de-Zeiten wie frueher aus UTC');
{
  const ctx = makeCtx([]);
  const local = [{ name: 'A', dep: '2026-09-12T08:36:00' }, { name: 'B', arr: '2026-09-12T12:46:00' }];
  const utc = [{ name: 'A', dep: '2026-09-12T06:36:00.000Z' }, { name: 'B', arr: '2026-09-12T10:46:00.000Z' }];
  assert('lokal', ctx.computeSegmentDuration('A', 'B', local), { hours: 4, minutes: 10 });
  assert('UTC (alte Quelle)', ctx.computeSegmentDuration('A', 'B', utc), { hours: 4, minutes: 10 });
  const overnight = [{ name: 'A', dep: '2026-09-12T23:50:00' }, { name: 'B', arr: '2026-09-13T00:34:00' }];
  assert('ueber Mitternacht', ctx.computeSegmentDuration('A', 'B', overnight), { hours: 0, minutes: 44 });
}

// ==============================================================================
group('popup.js: journeyHint aus dem GSD-Sitzplatzdialog');
{
  // extractTrainInfoFromPage laeuft im Seitenkontext; wir simulieren location/document
  const gsdData = { displayinformation: { zugbezeichnung: 'ICE 1005', abfahrtsbahnhof: 'Berlin Hbf', ankunftsbahnhof: 'München Hbf' },
    buchungskontext: { quellSystem: 'SIMA', buchungsKontextDaten: { zugnummer: '1005', zugfahrtKey: '20260912-c5526da9', abfahrtHalt: { locationId: '8098160', abfahrtZeit: '2026-09-12T08:36:00' }, ankunftHalt: { locationId: '8000261', ankunftZeit: '2026-09-12T12:46:00' } } } };
  const href = 'https://www.bahn.de/web/api/gsd/gsd_v3?data=' + encodeURIComponent(JSON.stringify(gsdData));
  const fnSrc = popupSrc.slice(popupSrc.indexOf('function extractTrainInfoFromPage()'), popupSrc.indexOf('function showStatus('));
  const pageCtx = { URL, JSON, String, location: { href }, document: { body: { innerText: 'Sitzplatz ICE 1005 Do. 12. September 2026', children: [], shadowRoot: null } } };
  vm.createContext(pageCtx);
  const info = vm.runInContext(fnSrc + '\nextractTrainInfoFromPage()', pageCtx);
  assert('Zug aus dem Dialog', info.dialogTrain, 'ICE 1005');
  assert('journeyHint vollstaendig', info.journeyHint, { trainNumber: '1005', departureEva: '8098160', departureTime: '2026-09-12T08:36:00', arrivalEva: '8000261', arrivalTime: '2026-09-12T12:46:00', zugfahrtKey: '20260912-c5526da9' });
  assert('Reisedatum aus Seitentext', info.travelDate, '2026-09-12');
  assert('from/to aus displayinformation', [info.fromStation, info.toStation], ['Berlin Hbf', 'München Hbf']);

  // Ohne buchungskontext (aeltere/andere Dialoge): kein Hint, Rest wie bisher
  const href2 = 'https://www.bahn.de/web/api/gsd/gsd_v3?data=' + encodeURIComponent(JSON.stringify({ displayinformation: gsdData.displayinformation }));
  const pageCtx2 = { URL, JSON, String, location: { href: href2 }, document: { body: { innerText: '', children: [], shadowRoot: null } } };
  vm.createContext(pageCtx2);
  const info2 = vm.runInContext(fnSrc + '\nextractTrainInfoFromPage()', pageCtx2);
  assert('ohne buchungskontext: journeyHint null', info2.journeyHint, null);
  assert('ohne buchungskontext: Zug trotzdem erkannt', info2.dialogTrain, 'ICE 1005');

  // Datum: buchungskontext liefert es auch ohne Seitentext
  const pageCtx3 = { URL, JSON, String, location: { href }, document: { body: { innerText: '', children: [], shadowRoot: null } } };
  vm.createContext(pageCtx3);
  assert('Reisedatum aus abfahrtZeit, wenn kein Seitentext', vm.runInContext(fnSrc + '\nextractTrainInfoFromPage()', pageCtx3).travelDate, '2026-09-12');
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
