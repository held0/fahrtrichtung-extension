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

group('Fehlende Segmentgrenze (bahn.de ohne Betriebshalt) wird geometrisch eingefuegt');
{
  // Nachtzug: fernbahn kennt Wechsel in Frankfurt, bahn.de listet Frankfurt nicht (kein Fahrgastwechsel)
  const NJ_HTML = `<div class="reihungsverzeichnis-eintrag"><div class="zugnr">NJ 403</div>
<div class="vonbis">Amsterdam Centraal &ndash; Zürich HB</div>
<div class="richtungswechsel"><img src="pfeilrechts.svg"> Amsterdam Centraal &ndash; Frankfurt(M)Hbf<br><img src="pfeillinks.svg"> Frankfurt(M)Hbf &ndash; Zürich HB<br></div>
<div class="wagenreihung"><span class="wagen-nummer">1</span><span class="wagen-nummer">9</span></div>
<div class="zugname">Reihung gültig tgl</div><a href="?zug_id=403">x</a><!-- reihungsverzeichnis-eintrag -->`;
  const NJ_DETAIL = `<span id="zls-daten-bahnhof-start">Amsterdam Centraal</span><span id="zls-daten-bahnhof-via1">Köln - Bonn - Koblenz - Frankfurt(Main) - Mannheim - Offenburg</span><span id="zls-daten-bahnhof-ziel">Zürich HB</span>`;
  const id = (n, lon, lat) => `A=1@O=${n}@X=${Math.round(lon * 1e6)}@Y=${Math.round(lat * 1e6)}@U=80@L=1@`;
  const NJ_RUN = { zugName: 'NJ 403', halte: [
    { name: 'Amsterdam Centraal', id: id('Amsterdam Centraal', 4.9003, 52.3791), abfahrt: { sollzeit: '2026-09-18T21:01:00' } },
    { name: 'Köln Hbf', id: id('Köln Hbf', 6.9588, 50.9430), ankunft: { sollzeit: '2026-09-19T00:00:00' }, abfahrt: { sollzeit: '2026-09-19T00:05:00' } },
    { name: 'Bonn Hbf', id: id('Bonn Hbf', 7.0970, 50.7320), ankunft: { sollzeit: '2026-09-19T00:41:00' }, abfahrt: { sollzeit: '2026-09-19T00:43:00' } },
    { name: 'Offenburg', id: id('Offenburg', 7.9469, 48.4764), ankunft: { sollzeit: '2026-09-19T05:13:00' }, abfahrt: { sollzeit: '2026-09-19T05:15:00' } },
    { name: 'Zürich HB', id: id('Zürich HB', 8.5402, 47.3779), ankunft: { sollzeit: '2026-09-19T08:05:00' } },
  ] };
  const njHint = { departureEva: '8400058', departureTime: '2026-09-18T21:01:00' };
  const ctx = makeCtx([
    { match: /fernbahn\.de\/datenbank\/suche\/\?fahrplan_jahr/, reply: () => ({ text: NJ_HTML }) },
    { match: /fernbahn\.de\/datenbank\/suche\/\?zug_id/, reply: () => ({ text: NJ_DETAIL }) },
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('NJ 403', '2026-09-18T21:01:00', 'nj')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: NJ_RUN }) },
    { match: /orte/, reply: url => ({ json: [{ type: 'ST', extId: '8000105', name: 'Frankfurt (Main) Hbf', lat: 50.1070, lon: 8.6632 }] }) },
  ]);
  const r = await ctx.handleFetchFernbahn({ trainType: 'NJ', trainNumber: '403', fromStation: 'Amsterdam Centraal', toStation: 'Zürich HB', travelDate: '2026-09-18', journeyHint: njHint });
  assert('Quelle bleibt bahn.de', r.stationSource, 'bahn.de');
  assert('Frankfurt geometrisch zwischen Bonn und Offenburg eingefuegt', r.stationOrder.map(s => s.name), ['Amsterdam Centraal', 'Köln Hbf', 'Bonn Hbf', 'Frankfurt(M)Hbf', 'Offenburg', 'Zürich HB']);
  assert('eingefuegter Halt ohne Zeiten, markiert', [r.stationOrder[3].dep, r.stationOrder[3].arr, r.stationOrder[3].inferred], [null, null, true]);
  assert('Richtungswechsel bleibt sichtbar: Start in Segment 0, Ziel in Segment 1', [r.fromSegmentIdx, r.toSegmentIdx], [0, 1]);
  assert('Offenburg liegt hinter dem Wechsel (Segment 1)', ctx.findSegmentForStation(r.segments, 'Offenburg', r.stationOrder), 1);
  assert('Köln liegt vor dem Wechsel (Segment 0)', ctx.findSegmentForStation(r.segments, 'Köln Hbf', r.stationOrder), 0);
  assert('kein fernbahn-Detailabruf noetig (Koordinaten statt Reihenfolge)', ctx.calls.filter(c => /zug_id/.test(c.url)).length, 0);
  assert('genau eine Ortssuche fuer die fehlende Grenze', ctx.calls.filter(c => /orte/.test(c.url)).length, 1);

  // Sind alle Grenzen vorhanden, wird die Detailseite NICHT geholt
  const ctx2 = makeCtx([...fernbahnRoutes,
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('ICE 1005', '2026-09-12T08:36:00', 'x')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: RUN }) },
  ]);
  await ctx2.handleFetchFernbahn({ ...baseReq, journeyHint: HINT });
  assert('ohne fehlende Grenze keine Ortssuche', ctx2.calls.filter(c => /orte/.test(c.url)).length, 0);

  // Halte ohne Koordinaten (id fehlt): keine Einfuegung, kein Absturz, Liste unveraendert
  const NJ_RUN_NOGEO = { zugName: 'NJ 403', halte: NJ_RUN.halte.map(h => ({ ...h, id: undefined })) };
  const ctx3 = makeCtx([
    { match: /fernbahn\.de\/datenbank\/suche\/\?fahrplan_jahr/, reply: () => ({ text: NJ_HTML }) },
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('NJ 403', '2026-09-18T21:01:00', 'nj')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: NJ_RUN_NOGEO }) },
    { match: /orte/, reply: () => ({ json: [{ type: 'ST', extId: '8000105', name: 'Frankfurt (Main) Hbf', lat: 50.1070, lon: 8.6632 }] }) },
  ]);
  const r3 = await ctx3.handleFetchFernbahn({ trainType: 'NJ', trainNumber: '403', fromStation: '', toStation: '', travelDate: '2026-09-18', journeyHint: njHint });
  assert('ohne Koordinaten bleibt die Liste unveraendert', r3.stationOrder.map(s => s.name), ['Amsterdam Centraal', 'Köln Hbf', 'Bonn Hbf', 'Offenburg', 'Zürich HB']);
  // Ortssuche scheitert (bahn.de 500): Liste unveraendert, kein Absturz
  const ctx4 = makeCtx([
    { match: /fernbahn\.de\/datenbank\/suche\/\?fahrplan_jahr/, reply: () => ({ text: NJ_HTML }) },
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('NJ 403', '2026-09-18T21:01:00', 'nj')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: NJ_RUN }) },
    { match: /orte/, reply: () => ({ status: 500, text: '' }) },
  ]);
  const r4 = await ctx4.handleFetchFernbahn({ trainType: 'NJ', trainNumber: '403', fromStation: '', toStation: '', travelDate: '2026-09-18', journeyHint: njHint });
  assert('Ortssuche kaputt -> Liste unveraendert, Quelle bahn.de', [r4.stationSource, r4.stationOrder.length], ['bahn.de', 5]);

  // Tageszug (ICE) mit fehlender Kopfbahnhof-Grenze = Umleitung, kein Richtungswechsel:
  // KEINE Einfuegung, alte Kanten-Logik (eine Richtung) bleibt
  const ICE_HTML = NJ_HTML.replace(/NJ 403/g, 'ICE 403');
  const ctx4b = makeCtx([
    { match: /fernbahn\.de\/datenbank\/suche\/\?fahrplan_jahr/, reply: () => ({ text: ICE_HTML }) },
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('ICE 403', '2026-09-18T21:01:00', 'ice')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: { ...NJ_RUN, zugName: 'ICE 403' } }) },
    { match: /orte/, reply: () => ({ json: [{ type: 'ST', extId: '8000105', name: 'Frankfurt (Main) Hbf', lat: 50.1070, lon: 8.6632 }] }) },
  ]);
  const r4b = await ctx4b.handleFetchFernbahn({ trainType: 'ICE', trainNumber: '403', fromStation: 'Amsterdam Centraal', toStation: 'Zürich HB', travelDate: '2026-09-18', journeyHint: njHint });
  assert('ICE: fehlende Grenze wird NICHT eingefuegt', r4b.stationOrder.map(s => s.name), ['Amsterdam Centraal', 'Köln Hbf', 'Bonn Hbf', 'Offenburg', 'Zürich HB']);
  assert('ICE: keine Ortssuche', ctx4b.calls.filter(c => /orte/.test(c.url)).length, 0);
  assert('ICE: Kanten-Logik -> eine Richtung fuer die ganze Fahrt', [r4b.fromSegmentIdx, r4b.toSegmentIdx], [0, 0]);

  // Grenzstation liegt gar nicht auf der Tagesroute (Zug endet frueher / Umleitung):
  // grosser Umweg -> NICHT einfuegen
  const NJ_HTML_WIEN = NJ_HTML.replace(/Frankfurt\(M\)Hbf/g, 'Wien Hbf');
  const ctx5 = makeCtx([
    { match: /fernbahn\.de\/datenbank\/suche\/\?fahrplan_jahr/, reply: () => ({ text: NJ_HTML_WIEN }) },
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('NJ 403', '2026-09-18T21:01:00', 'nj')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: NJ_RUN }) },
    { match: /orte/, reply: () => ({ json: [{ type: 'ST', extId: '8103000', name: 'Wien Hbf', lat: 48.1850, lon: 16.3760 }] }) },
  ]);
  const r5 = await ctx5.handleFetchFernbahn({ trainType: 'NJ', trainNumber: '403', fromStation: '', toStation: '', travelDate: '2026-09-18', journeyHint: njHint });
  assert('Grenze abseits der Route (Wien) wird nicht eingefuegt', r5.stationOrder.map(s => s.name), ['Amsterdam Centraal', 'Köln Hbf', 'Bonn Hbf', 'Offenburg', 'Zürich HB']);
  // Kleiner Umweg (Frankfurt zwischen Bonn und Offenburg: ~58 km auf ~260 km) wird akzeptiert
  const bonn = { lat: 50.7320, lon: 7.0970 }, off = { lat: 48.4764, lon: 7.9469 }, ffm = { lat: 50.1070, lon: 8.6632 };
  const detour = ctx5.geoDistance(bonn, ffm) + ctx5.geoDistance(ffm, off) - ctx5.geoDistance(bonn, off);
  assert('Umweg Frankfurt innerhalb der Schranke', detour < 0.3 * ctx5.geoDistance(bonn, off), true);
  // Endpunkt-Grenze (Route endet laut fernbahn in Zürich, heute schon in Offenburg): nie einfuegen
  const NJ_RUN_SHORT = { zugName: 'NJ 403', halte: NJ_RUN.halte.slice(0, 4) };   // bis Offenburg
  const ctx6 = makeCtx([
    { match: /fernbahn\.de\/datenbank\/suche\/\?fahrplan_jahr/, reply: () => ({ text: NJ_HTML }) },
    { match: /abfahrten/, reply: () => ({ json: { entries: [ENTRY('NJ 403', '2026-09-18T21:01:00', 'nj')] } }) },
    { match: /fahrt\?/, reply: () => ({ json: NJ_RUN_SHORT }) },
    { match: /orte/, reply: url => ({ json: [/Frankfurt/.test(qs(url).suchbegriff) ? { type: 'ST', extId: '8000105', name: 'Frankfurt (Main) Hbf', lat: 50.1070, lon: 8.6632 } : { type: 'ST', extId: '8503000', name: 'Zürich HB', lat: 47.3779, lon: 8.5402 }] }) },
  ]);
  const r6 = await ctx6.handleFetchFernbahn({ trainType: 'NJ', trainNumber: '403', fromStation: '', toStation: '', travelDate: '2026-09-18', journeyHint: njHint });
  assert('innere Grenze Frankfurt eingefuegt, Endpunkt Zürich nicht', r6.stationOrder.map(s => s.name), ['Amsterdam Centraal', 'Köln Hbf', 'Bonn Hbf', 'Frankfurt(M)Hbf', 'Offenburg']);
  // Projektion: Punkt JENSEITS des zweiten Halts (Dammtor liegt noerdlich von Hamburg Hbf,
  // in Verlaengerung Harburg->Hbf) wird nicht in die Luecke Harburg–Hbf gesetzt
  const harburg = { lat: 53.4560, lon: 9.9916 }, hbf = { lat: 53.5527, lon: 10.0065 }, dammtor = { lat: 53.5606, lon: 9.9897 };
  assert('Projektion Dammtor liegt hinter Hbf (t > 1)', ctx6.projectionParam(harburg, hbf, dammtor) > 1, true);
  assert('kein Einfuegen jenseits des zweiten Halts', ctx6.bestInsertIndex([{ ...harburg }, { ...hbf }], dammtor), -1);
  assert('Frankfurt projiziert zwischen Bonn und Offenburg', (t => t > 0 && t < 1)(ctx6.projectionParam(bonn, off, ffm)), true);
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
