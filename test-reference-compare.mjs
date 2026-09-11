#!/usr/bin/env node
// Vorher/Nachher-Vergleich: neuer Extension-Code gegen die Referenz-Datenbasis.
//
// Liest reference/<source>-<date>.json (aufgezeichnet mit dem ALTEN Code via
// test-reference-record.mjs) und laesst fuer jeden Zug desselben Datums die
// Stationslisten-Quelle des AKTUELLEN chrome/background.js laufen
// (fetchBahnDeStations). fernbahn.de wird dabei NICHT erneut angefragt — der
// fernbahn-Teil (Route/Segmente/Wagen) ist unveraenderter Code und kommt aus der
// Referenz; so belasten ~1150 Zuege nur die neue Quelle. Verglichen wird:
//
//   1. Stationsliste der neuen Quelle vs. alte Quelle (normalisierte Namen, Zeiten)
//   2. Wrong-Train-Guard (stationOrderMatchesEntry) muss die neue Liste akzeptieren
//   3. Abgeleitete Ergebnisse, die der Nutzer sieht: fuer JEDES Stationspaar
//      (Einstieg/Ausstieg) die Segment-Zuordnung (fromSegmentIdx/toSegmentIdx)
//      und fuer jedes Segment die Fahrtdauer — alt vs. neu
//
// Zwei Pfade werden geprueft:
//   --mode hint  (Default): mit journeyHint (Abfahrts-EVA + Zeit aus der Referenz,
//                 wie ihn die Extension aus dem Sitzplatzdialog bekommt)
//   --mode scan : ohne Hint (reine Nummernsuche wie Website/E2E)
//   --sample N  : nur jeden N-ten Zug (fuer den teuren scan-Modus)
//
// Exit 0 = keine relevanten Abweichungen, 1 = Abweichungen (siehe Report),
// Report: reference/compare-<mode>-<date>.json

import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';
import { throttledCurlFetch, proxyActive } from './test-lib/curl-fetch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = path.join(__dirname, 'chrome');
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const MODE = arg('--mode', 'hint');
const SAMPLE = Number(arg('--sample', MODE === 'scan' ? 10 : 1));
const CONCURRENCY = Number(arg('--concurrency', 6));
const LIMIT = Number(arg('--limit', 0));
const ONLY = arg('--only', '').split(',').map(s => s.trim()).filter(Boolean);
const REF_FILE = arg('--ref', '');

// ---- Extension-Logik laden ---------------------------------------------------
const bg = fs.readFileSync(path.join(CHROME, 'background.js'), 'utf8')
  .replace(/importScripts\([^)]*\);/g, '')
  .replace(/chrome\.runtime\.onMessage[\s\S]*?\}\);\n/, '');
const utils = fs.readFileSync(path.join(CHROME, 'utils.js'), 'utf8');
// Takt zwischen Requests (ms). Ueber den rotierenden Proxy (viele IPs) darf es
// zuegiger gehen; ohne Proxy konservativ bleiben.
const GAP_MS = Number(arg('--gap', proxyActive ? 150 : 1800));
const fetchImpl = throttledCurlFetch(GAP_MS);
let requestCount = 0;
const ctx = {
  fetch: (u, o) => { requestCount++; return fetchImpl(u, o); },
  console: { log() {}, warn() {}, error() {} },
  chrome: { runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} }, getURL: p => p }, tabs: { create() {} } },
  URLSearchParams, TextDecoder, DataView, Uint8Array, AbortSignal, setTimeout, clearTimeout,
  Date, JSON, Math, String, Array, Object, Number, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
};
vm.createContext(ctx);
vm.runInContext(utils, ctx);
vm.runInContext(bg, ctx);

// ---- Referenz laden ----------------------------------------------------------
function findRefFile() {
  if (REF_FILE) return REF_FILE;
  const dir = path.join(__dirname, 'reference');
  const wantDate = arg('--date', '');
  const files = fs.readdirSync(dir).filter(f => /^bahnexpert-\d{4}-\d{2}-\d{2}\.json$/.test(f) && (!wantDate || f.includes(wantDate))).sort();
  if (!files.length) throw new Error('Keine Referenzdatei in reference/ — zuerst test-reference-record.mjs laufen lassen');
  return path.join(dir, files[files.length - 1]);
}
const refPath = findRefFile();
const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
const DATE = ref.date;

// ---- Hilfsfunktionen ---------------------------------------------------------
const norm = s => ctx.normalizeStation(s);
const names = so => (so || []).map(s => (typeof s === 'string' ? s : s.name));

// bahn.expert lieferte UTC ("...Z"), bahn.de liefert lokale Zeit ohne Zone.
// Beides auf lokale Minute (Europe/Berlin, "HH:MM") bringen.
const berlinFmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false });
const berlinDateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function localMinute(iso) {
  if (!iso) return null;
  if (/Z$|[+-]\d{2}:\d{2}$/.test(iso)) return berlinFmt.format(new Date(iso)).replace('.', ':');
  return iso.slice(11, 16);
}
function localIso(iso) {
  if (!iso) return null;
  if (/Z$|[+-]\d{2}:\d{2}$/.test(iso)) return berlinDateFmt.format(new Date(iso)).replace(' ', 'T');
  return iso.slice(0, 19);
}
function toLocalStations(so) {
  return (so || []).map(s => ({ name: s.name, dep: localIso(s.dep), arr: localIso(s.arr) }));
}

// Alle abgeleiteten Ergebnisse fuer eine Stationsliste: Segmentindex jeder
// Station + Dauer jedes Segments (das ist, was das Popup anzeigt).
function derive(segments, stationOrder) {
  const st = toLocalStations(stationOrder);
  const segIdx = {};
  for (const n of names(st)) segIdx[norm(n)] = ctx.findSegmentForStation(segments, n, st);
  const durations = segments.map(seg => {
    const d = ctx.computeSegmentDuration(seg.from, seg.to, st);
    return d ? d.hours * 60 + d.minutes : null;
  });
  return { segIdx, durations };
}

const evaCache = new Map();
const stationInfoCache = new Map();   // name -> { extId, products } der ersten Station (fuer Plausibilitaet der ALTEN Liste)
async function evaFor(name) {
  if (!evaCache.has(name)) evaCache.set(name, await ctx.resolveStationEva(name).catch(() => null));
  return evaCache.get(name);
}
// Hatte die ALTE Quelle ueberhaupt einen Fernverkehrszug geliefert? bahn.expert
// gab bei manchen Nummern Busse/Ersatzverkehr/S-Bahnen zurueck (z.B. "ICE 1700"
// = Buslinie ab "Lattenkamp (Sporthalle), Hamburg"). Dann ist ein "not found" der
// neuen Quelle kein Rueckschritt, sondern die Korrektur.
async function oldFirstStopIsLongDistance(name) {
  if (!stationInfoCache.has(name)) {
    let ok = null;
    try {
      const data = await ctx.bahnDeGetJson('/web/api/reiseloesung/orte', { suchbegriff: name, typ: 'ALL', limit: '5' });
      const st = (Array.isArray(data) ? data : []).find(o => o?.type === 'ST');
      ok = st ? (st.products || []).some(p => p === 'ICE' || p === 'EC_IC' || p === 'IR') : false;
    } catch { ok = null; }
    stationInfoCache.set(name, ok);
  }
  return stationInfoCache.get(name);
}

// ---- Vergleich eines Zuges ---------------------------------------------------
async function compareTrain(rec) {
  const old = rec.result;
  const out = { key: rec.key, categories: [], notes: [] };
  const req = { trainType: rec.trainType, trainNumber: rec.trainNumber, fromStation: '', toStation: '', travelDate: DATE };

  if (MODE === 'hint') {
    const first = old.stationOrder?.[0];
    const dep = first ? localIso(first.dep || first.arr) : null;
    const eva = first ? await evaFor(first.name) : null;
    if (eva && dep) req.journeyHint = { trainNumber: rec.trainNumber, departureEva: eva, departureTime: dep };
    else {
      // Ohne Zeit in der Referenz hatte schon die ALTE Quelle keine Daten (fernbahn-
      // Fallback). Der Hint-Pfad ist dann nicht pruefbar; der teure Tages-Scan
      // gehoert in --mode scan. Hier ohne Requests ueberspringen.
      out.categories.push(eva ? 'NO_HINT_OLD_SOURCE_FAILED' : 'NO_HINT_EVA_UNRESOLVED');
      return out;
    }
  }

  if (!old.ok) { out.categories.push('OLD_FAIL'); return out; }
  const entry = { route: old.route, segments: old.segments };

  let neuStations;
  try {
    neuStations = await ctx.fetchBahnDeStations(rec.trainType, rec.trainNumber, DATE, { journeyHint: req.journeyHint, route: old.route });
  } catch (e) {
    const firstOld = old.stationOrder?.[0]?.name;
    const oldHadTimes = (old.stationOrder || []).some(s => s.dep || s.arr);
    if (!oldHadTimes) {
      // Auch die alte Quelle hatte fuer diesen Zug/Tag nichts (fernbahn-Fallback
      // ohne Zeiten) — beide Quellen kennen den Zug an diesem Tag nicht.
      out.categories.push('BOTH_NO_DATA');
      out.notes.push('neu: ' + e.message + ' — alte Quelle hatte ebenfalls keine Daten');
      return out;
    }
    const plausible = firstOld ? await oldFirstStopIsLongDistance(firstOld) : null;
    out.categories.push(plausible === false ? 'OLD_WRONG_TRAIN' : 'NEW_FAIL');
    out.notes.push('neu: ' + e.message + (plausible === false ? ` — alte Liste begann an "${firstOld}" (kein Fernverkehrshalt), alte Quelle hatte den falschen Zug` : ''));
    return out;
  }
  // Fehlt eine Segmentgrenze in der bahn.de-Liste (Betriebshalt ohne Fahrgast-
  // wechsel), fuegt die Pipeline sie aus der fernbahn-Reihenfolge ein. Das
  // braucht die zug_id von der fernbahn-Suchseite -> in diesem seltenen Fall den
  // vollen Pipeline-Pfad fahren (ein fernbahn-Request).
  const neuNorm = neuStations.map(s => ctx.normalizeStation(s.name));
  const isNight = ['NJ', 'EN', 'D'].includes(rec.trainType);
  const interior = (old.segments || []).slice(0, -1).map(seg => seg.to).filter(Boolean);
  const boundaryMissing = isNight && interior.some(b => ctx.findSegBoundary(b, neuNorm) < 0);
  if (boundaryMissing) {
    try {
      const full = await ctx.handleFetchFernbahn(req);
      if (full.stationSource === 'bahn.de') {
        neuStations = full.stationOrder;
        out.notes.push('Grenzstation fehlte auf bahn.de -> geometrisch eingefuegt: ' + full.stationOrder.filter(s => s.inferred).map(s => s.name).join(', '));
      }
    } catch (e) { out.notes.push('voller Pipeline-Pfad fehlgeschlagen: ' + e.message); }
  }
  // Guard wie in handleFetchFernbahn: Liste muss zur fernbahn-Route passen
  const guardOk = ctx.stationOrderMatchesEntry(neuStations, entry);
  const neu = { segments: old.segments, stationOrder: guardOk ? neuStations : [], stationSource: guardOk ? 'bahn.de' : 'guard-rejected' };
  if (!guardOk) { out.categories.push('GUARD_REJECT'); out.notes.push('neu (verworfen): ' + names(neuStations).join(' > ')); }

  // 2. Stationsliste
  const oldNames = names(old.stationOrder).map(norm);
  const newNames = names(neu.stationOrder).map(norm);
  out.stationSource = neu.stationSource;
  out.oldHadTimes = (old.stationOrder || []).some(s => s.dep || s.arr);
  if (oldNames.join('|') !== newNames.join('|')) {
    out.categories.push('STATIONS_DIFF');
    out.notes.push(`alt: ${names(old.stationOrder).join(' > ')}`);
    out.notes.push(`neu: ${names(neu.stationOrder).join(' > ')}`);
  } else if (out.oldHadTimes) {
    const tOld = old.stationOrder.map(s => `${localMinute(s.arr) || ''}/${localMinute(s.dep) || ''}`);
    const tNew = neu.stationOrder.map(s => `${localMinute(s.arr) || ''}/${localMinute(s.dep) || ''}`);
    if (tOld.join(',') !== tNew.join(',')) {
      out.categories.push('TIMES_DIFF');
      out.notes.push(`zeiten alt: ${tOld.join(' ')}`);
      out.notes.push(`zeiten neu: ${tNew.join(' ')}`);
    }
  }

  // 3. Abgeleitete Ergebnisse (Segment-Zuordnung je Station, Dauer je Segment)
  const dOld = derive(old.segments, old.stationOrder);
  const dNew = derive(neu.segments, neu.stationOrder);
  const common = Object.keys(dOld.segIdx).filter(k => k in dNew.segIdx);
  const segDiffs = common.filter(k => dOld.segIdx[k] !== dNew.segIdx[k]);
  out.pairsChecked = (common.length * (common.length - 1)) / 2;   // jedes Einstieg/Ausstieg-Paar
  out.stationsChecked = common.length;
  if (segDiffs.length) {
    out.categories.push('SEGMENT_DIFF');
    out.notes.push('Segment-Zuordnung anders fuer: ' + segDiffs.map(k => `${k}(${dOld.segIdx[k]}->${dNew.segIdx[k]})`).join(', '));
  }
  if (out.oldHadTimes && JSON.stringify(dOld.durations) !== JSON.stringify(dNew.durations)) {
    // Eine Dauer, die neu NICHT mehr angezeigt wird (null), ist gewollt: an
    // geometrisch eingefuegten Grenzstationen gibt es keine Zeiten. Nur eine
    // ANDERE Dauer ist eine echte Abweichung.
    const realDiff = dOld.durations.some((d, i) => d != null && dNew.durations[i] != null && d !== dNew.durations[i]);
    out.categories.push(realDiff ? 'DURATION_DIFF' : 'DURATION_MISSING');
    out.notes.push(`dauer alt: ${dOld.durations.join(',')} neu: ${dNew.durations.join(',')}`);
  }
  return out;
}

// ---- Main --------------------------------------------------------------------
async function main() {
  let trains = ref.trains.filter(t => !t.result?.noData);
  if (ONLY.length) trains = trains.filter(t => ONLY.includes(t.key));
  if (SAMPLE > 1) trains = trains.filter((_, i) => i % SAMPLE === 0);
  if (LIMIT) trains = trains.slice(0, LIMIT);

  console.log(`Vergleich ${MODE}-Modus — Referenz ${path.basename(refPath)} (${ref.trains.length} Zuege, Quelle ${ref.source}), Datum ${DATE}`);
  console.log(`${trains.length} Zuege zu pruefen, Concurrency ${CONCURRENCY}, Takt ${GAP_MS} ms, Proxy ${proxyActive ? 'aktiv' : 'AUS (eigene IP!)'}\n`);

  const results = [];
  let idx = 0, done = 0;
  const started = Date.now();
  async function worker() {
    while (idx < trains.length) {
      const t = trains[idx++];
      let r;
      try { r = await compareTrain(t); } catch (e) { r = { key: t.key, categories: ['HARNESS_ERROR'], notes: [e.message] }; }
      results.push(r);
      done++;
      const tag = r.categories.length ? '✗ ' + r.categories.join(',') : '✓';
      console.log(`[${done}/${trains.length}] ${t.key}: ${tag}${r.pairsChecked ? ` (${r.stationsChecked} Stationen, ${r.pairsChecked} Paare)` : ''}`);
      if (r.notes.length && r.categories.length) r.notes.forEach(n => console.log('      ' + n));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const count = {};
  for (const r of results) for (const c of r.categories) count[c] = (count[c] || 0) + 1;
  const clean = results.filter(r => !r.categories.length).length;
  const stations = results.reduce((n, r) => n + (r.stationsChecked || 0), 0);
  const pairs = results.reduce((n, r) => n + (r.pairsChecked || 0), 0);

  const report = { mode: MODE, date: DATE, reference: path.basename(refPath), ranAt: new Date().toISOString(),
    trains: results.length, clean, categories: count, stationsChecked: stations, pairsChecked: pairs,
    requests: requestCount, seconds: Math.round((Date.now() - started) / 1000), results };
  // Teil-Laeufe (--only/--limit) duerfen den vollstaendigen Report nicht ueberschreiben
  const partial = ONLY.length || LIMIT ? '-partial' : '';
  const outFile = path.join(__dirname, 'reference', `compare-${MODE}-${DATE}${partial}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1));

  console.log('\n' + '─'.repeat(60));
  console.log(`${results.length} Zuege, ${clean} ohne Abweichung | ${stations} Stationen, ${pairs} Einstieg/Ausstieg-Paare verglichen | ${requestCount} Requests, ${report.seconds}s`);
  for (const [c, n] of Object.entries(count).sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);
  console.log(`Report: ${outFile}`);

  // Relevante Abweichungen = alles, was der Nutzer im Popup anders saehe oder
  // ein Ausfall der neuen Quelle, wo die alte lieferte.
  const bad = (count.SEGMENT_DIFF || 0) + (count.DURATION_DIFF || 0) + (count.GUARD_REJECT || 0) + (count.NEW_FAIL || 0) + (count.HARNESS_ERROR || 0);
  console.log(bad ? `COMPARE-RESULT: FAIL — ${bad} Zug/Zuege mit relevanten Abweichungen` : 'COMPARE-RESULT: PASS');
  process.exit(bad ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
