#!/usr/bin/env node
// Zeichnet eine Referenz-Datenbasis mit dem AKTUELLEN Extension-Code auf.
//
// Zweck: Vor dem Austausch der Stationslisten-Quelle (bahn.expert -> bahn.de)
// wird fuer JEDEN Fernverkehrszug mit Wagenreihung auf fernbahn.de das komplette
// Pipeline-Ergebnis (handleFetchFernbahn) plus die rohe Stationsliste der
// Quelle festgehalten. test-reference-compare.mjs prueft danach, dass der neue
// Code fuer dieselben Zuege dieselben Ergebnisse liefert.
//
// Usage: node test-reference-record.mjs [--date YYYY-MM-DD] [--concurrency 3]
//                                       [--only ICE,IC] [--limit N] [--sample N] [--out file]
//                                       [--bg <background.js> --utils <utils.js>]
//   --bg/--utils: anderen Code laden (z.B. reference/old-code/background-bahnexpert.js,
//                 der letzte Stand mit bahn.expert), um NACHTRAEGLICH weitere Referenzen
//                 mit dem alten Code aufzuzeichnen. --sample 4 = jeder 4. Zug.
// Output: reference/<source>-<date>.json (wird alle 20 Zuege zwischengespeichert)

import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';
import { throttledCurlFetch } from './test-lib/curl-fetch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = path.join(__dirname, 'chrome');

// ---- Argumente -------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const DATE = arg('--date', today());
const CONCURRENCY = Number(arg('--concurrency', 3));
const ONLY = arg('--only', '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const LIMIT = Number(arg('--limit', 0));
const TRAIN_TYPES = ['ICE', 'ECE', 'IC', 'EC', 'RJX', 'RJ', 'TGV', 'EST', 'NJ', 'EN'];

// ---- Extension-Logik laden (wie test-e2e-live.mjs) --------------------------
const BG_FILE = arg('--bg', path.join(CHROME, 'background.js'));
const UTILS_FILE = arg('--utils', path.join(CHROME, 'utils.js'));
const SAMPLE = Number(arg('--sample', 1));
let bg = fs.readFileSync(BG_FILE, 'utf8')
  .replace(/importScripts\([^)]*\);/g, '')
  .replace(/chrome\.runtime\.onMessage[\s\S]*?\}\);\n/, '');
const utils = fs.readFileSync(UTILS_FILE, 'utf8');

// curl-Transport (bahn.de/Akamai blockt Node-fetch) mit sanftem Takt: fernbahn.de
// ist eine kleine private Seite — beim ersten Lauf (2026-09-11) gab es nach
// ~2400 Requests binnen einer Stunde 504/Timeouts. 1 Request/s ist die Obergrenze.
const browserFetch = throttledCurlFetch(1000);
const ctx = {
  fetch: browserFetch,
  console: { log() {}, warn() {}, error() {} },
  chrome: { runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} }, getURL: p => p }, tabs: { create() {} } },
  URLSearchParams, TextDecoder, DataView, Uint8Array, AbortSignal, setTimeout, clearTimeout,
  Date, JSON, Math, String, Array, Object, Number, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
};
vm.createContext(ctx);
vm.runInContext(utils, ctx);
vm.runInContext(bg, ctx);

// Welche Stationsquelle stellt der Code bereit? (vor dem Umbau: bahn.expert,
// danach: bahn.de). Wir haengen uns an die Funktion, um die ROHE Liste der
// Quelle unabhaengig vom Pipeline-Ergebnis mitzuschreiben.
const SOURCE_FN = ['fetchBahnDeStations', 'fetchBahnExpertStations'].find(n => typeof ctx[n] === 'function');
const SOURCE = SOURCE_FN === 'fetchBahnDeStations' ? 'bahnde' : 'bahnexpert';
const rawCapture = new Map();
const origSourceFn = ctx[SOURCE_FN];
vm.runInContext(`${SOURCE_FN} = (...a) => __sourceWrapper(...a)`, ctx);
ctx.__sourceWrapper = async (trainType, trainNumber, travelDate, ...rest) => {
  const key = `${trainType} ${trainNumber}`;
  try {
    const r = await origSourceFn(trainType, trainNumber, travelDate, ...rest);
    rawCapture.set(key, { ok: true, stops: r });
    return r;
  } catch (e) {
    rawCapture.set(key, { ok: false, error: e.message });
    throw e;
  }
};

// ---- Zuege enumerieren: alle Nummernbereiche mit Reihungsverzeichnis --------
const RANGES = ['2-99', '100-199', '200-299', '300-399', '400-499', '500-599', '600-699', '700-799', '800-899', '900-999',
  '1000-1099', '1100-1199', '1200-1299', '1300-1399', '1400-1499', '1500-1599', '1600-1699', '1700-1999', '2000-2099', '2100-2199',
  '2200-2299', '2300-2399', '2400-2499', '2500-2999', '3000-3999', '9500-9599'];

async function enumerateTrains() {
  const year = DATE.slice(0, 4);
  const trains = new Map();
  for (const range of RANGES) {
    const url = `https://www.fernbahn.de/datenbank/suche/?fahrplan_jahr=${year}&zug_nummer=${range}&filterview[]=1&filterview[]=2&fv_suche_reihungsverzeichnis=1`;
    let html = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try { const r = await browserFetch(url); if (r.ok) { html = await r.text(); break; } }
      catch (e) { /* retry */ }
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
    const entries = ctx.parseEntries(html);
    for (const e of entries) {
      const m = e.trainName.match(/^([A-Z]+)\s*(\d+)/);
      if (!m || !TRAIN_TYPES.includes(m[1])) continue;
      if (ONLY.length && !ONLY.includes(m[1])) continue;
      trains.set(`${m[1]} ${m[2]}`, { trainType: m[1], trainNumber: m[2] });
    }
    process.stdout.write(`  ${range}: ${entries.length} Eintraege, bisher ${trains.size} Zuege\n`);
  }
  return [...trains.values()];
}

// ---- Aufzeichnen -------------------------------------------------------------
async function recordTrain(t) {
  const key = `${t.trainType} ${t.trainNumber}`;
  rawCapture.delete(key);
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await ctx.handleFetchFernbahn({ ...t, fromStation: '', toStation: '', travelDate: DATE });
      result = { ok: true, ...r };
      break;
    } catch (e) {
      if (/Keine Wagenreihung/.test(e.message)) { result = { ok: false, error: e.message, noData: true }; break; }
      result = { ok: false, error: e.message };
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  return { ...t, key, result, source: rawCapture.get(key) || null };
}

async function main() {
  const outDir = path.join(__dirname, 'reference');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = arg('--out', path.join(outDir, `${SOURCE}-${DATE}.json`));

  console.log(`Referenz-Aufzeichnung — Quelle: ${SOURCE} (${SOURCE_FN}), Datum: ${DATE}`);
  console.log('Enumeriere Zuege auf fernbahn.de …');
  let trains = await enumerateTrains();
  if (SAMPLE > 1) trains = trains.filter((_, i) => i % SAMPLE === 0);
  if (LIMIT) trains = trains.slice(0, LIMIT);
  console.log(`${trains.length} Zuege. Starte Aufzeichnung (Concurrency ${CONCURRENCY}) …`);

  const records = [];
  let idx = 0, done = 0;
  const started = Date.now();
  const save = () => fs.writeFileSync(outFile, JSON.stringify({
    source: SOURCE, date: DATE, recordedAt: new Date().toISOString(), complete: done === trains.length, sample: SAMPLE, codeFile: path.basename(BG_FILE),
    trains: records.sort((a, b) => a.key.localeCompare(b.key, 'de', { numeric: true })),
  }, null, 1));

  async function worker() {
    while (idx < trains.length) {
      const t = trains[idx++];
      const rec = await recordTrain(t);
      records.push(rec);
      done++;
      const st = rec.result.ok ? `ok stops=${rec.result.stationOrder?.length} seg=${rec.result.segments?.length}` : (rec.result.noData ? 'keine Daten' : `FEHLER ${rec.result.error}`);
      console.log(`[${done}/${trains.length}] ${rec.key}: ${st}`);
      if (done % 20 === 0) save();
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  save();

  const ok = records.filter(r => r.result.ok).length;
  const noData = records.filter(r => r.result.noData).length;
  const err = records.length - ok - noData;
  const withTimes = records.filter(r => r.result.ok && r.result.stationOrder?.some(s => s.dep || s.arr)).length;
  console.log(`\nFertig in ${Math.round((Date.now() - started) / 1000)}s: ${ok} ok (${withTimes} mit Zeiten von der Quelle), ${noData} ohne Wagenreihung, ${err} Fehler → ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
