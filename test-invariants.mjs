#!/usr/bin/env node
// Invarianten-Test über ALLE Züge der lokalen Referenz (reference/bahnexpert-*.json,
// fernbahn-Reihungen + Tages-Stationslisten). Prüft nicht Einzelfälle, sondern
// physikalische Regeln, die für jeden Zug gelten müssen — und simuliert für jeden
// Wende-Bahnhof eine Umleitung (Bahnhof fehlt in der Tagesliste), weil genau dort
// Fehler entstanden sind (ICE 594/677, 2026-10-17).
//
// Regeln:
//  R1  An jeder angezeigten Abschnittsgrenze wendet der Zug → benachbarte Abschnitte
//      haben IMMER entgegengesetzte Richtung und entgegengesetzten Frontwagen.
//  R2  Fällt eine Wende aus (Umleitung), steht der Zug danach andersherum:
//      Ausrichtung jedes angezeigten Abschnitts = Ausrichtung des ersten fernbahn-
//      Abschnitts darin, gekippt um die Zahl der davor ausgelassenen Wenden.
//  R3  Fahrzeiten: kein Abschnitt länger als die ganze Fahrt; bei mehreren Abschnitten
//      hat nie mehr als einer die volle Gesamtzeit; Summe ≤ Gesamtzeit (+1 min Rundung).
//
// Läuft nur lokal (Referenz ist gitignored, Datenbankschutz fernbahn.de). Ohne
// Referenz: Hinweis und Exit 0, damit CI nicht bricht.
//   node test-invariants.mjs [reference/bahnexpert-2026-09-11.json]

import fs from 'node:fs';
import vm from 'node:vm';

const refFile = process.argv[2] || 'reference/bahnexpert-2026-09-11.json';
if (!fs.existsSync(refFile)) {
  console.log(`(übersprungen: ${refFile} nicht vorhanden — Referenz liegt nur lokal)`);
  process.exit(0);
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('chrome/utils.js', 'utf8'), ctx);
const { mergeBypassedBoundaries, missingInnerBoundaries, isBoundaryOnRoute, computeSegmentDuration, normalizeStation, findInStationList } = ctx;

// Koordinaten aus dem freien DB-Fernverkehrs-GTFS (die Referenz hat keine) —
// gleiche Rolle wie lat/lon aus bahn.de bzw. reiseloesung/orte in der Extension
const coordTable = JSON.parse(fs.readFileSync('test-lib/station-coords.json', 'utf8')).stations;
const coordIndex = Object.entries(coordTable).map(([n, c]) => [normalizeStation(n), c]);
function coordsOf(name) {
  const norm = normalizeStation(name);
  const exact = coordIndex.find(([n]) => n === norm);
  const hit = exact || coordIndex.find(([n]) => n.includes(norm) || norm.includes(n));
  return hit ? { lat: hit[1][0], lon: hit[1][1] } : null;
}
const withCoords = so => so.map(s => ({ ...s, ...(coordsOf(s.name) || {}) }));
// Wie background.js: fehlende innere Grenzen, die geometrisch auf der Route liegen
const bypassedOf = (segments, so) => missingInnerBoundaries(segments, so).filter(b => isBoundaryOnRoute(so, coordsOf(b)));

const trains = JSON.parse(fs.readFileSync(refFile, 'utf8')).trains;
const NIGHT = /^(NJ|EN|D) /;
let checked = 0, scenarios = 0, noCoords = 0, notRecognised = 0, frankfurtCases = 0;
const failures = [];
const fail = (key, msg) => { if (failures.length < 200) failures.push(`${key}: ${msg}`); };

const minutes = d => d ? d.hours * 60 + d.minutes : null;
const names = so => so.map(s => s.name);

function checkResult(key, label, orig, out, stationOrder, removed) {
  // R1: benachbarte angezeigte Abschnitte wechseln immer
  for (let i = 1; i < out.length; i++) {
    if (out[i].direction === out[i - 1].direction || out[i].firstWagonIsFront === out[i - 1].firstWagonIsFront) {
      fail(key, `${label}: R1 verletzt — „${out[i - 1].from}–${out[i - 1].to}“ und „${out[i].from}–${out[i].to}“ gleiche Ausrichtung`);
    }
  }
  // R2: erwartete Ausrichtung je angezeigtem Abschnitt = fernbahn-Ausrichtung,
  //     gekippt um die Zahl der davor umfahrenen Wenden (removed = Grenz-Indizes k)
  for (const seg of out) {
    const j = orig.findIndex(o => o.from === seg.from);
    if (j < 0) { fail(key, `${label}: R2 Abschnitt „${seg.from}“ unbekannt`); continue; }
    const skippedBefore = removed.filter(k => k < j).length;
    const expectFront = skippedBefore % 2 ? !orig[j].firstWagonIsFront : orig[j].firstWagonIsFront;
    if (seg.firstWagonIsFront !== expectFront) {
      fail(key, `${label}: R2 verletzt — „${seg.from}–${seg.to}“ Frontwagen falsch (${removed.length} Wende(n) umfahren)`);
    }
  }
  // R3: Fahrzeiten
  const timed = stationOrder.filter(s => s.dep || s.arr);
  if (timed.length >= 2 && out.length >= 1) {
    const total = minutes(computeSegmentDuration(stationOrder[0].name, stationOrder[stationOrder.length - 1].name, stationOrder));
    const inner = out.slice(0, -1).map(s => s.to);
    const durs = out.map(s => minutes(computeSegmentDuration(s.from, s.to, stationOrder, inner)));
    if (total != null) {
      if (durs.some(d => d != null && d > total + 1)) fail(key, `${label}: R3 Abschnitt länger als Gesamtfahrt`);
      if (out.length > 1 && durs.filter(d => d != null && Math.abs(d - total) <= 1).length > 1) fail(key, `${label}: R3 mehrere Abschnitte mit voller Gesamtzeit (${durs.join('/')} von ${total})`);
    }
  }
}

for (const t of trains) {
  const r = t.result;
  if (!r?.ok || !Array.isArray(r.segments) || r.segments.length < 2 || !r.stationOrder?.length) continue;
  if (NIGHT.test(t.key)) continue;   // Nachtzüge: eigene Logik (insertMissingBoundaries)
  checked++;
  const orig = r.segments;

  const route = withCoords(r.stationOrder);
  const idxOfBoundary = b => orig.findIndex((s, k) => k < orig.length - 1 && normalizeStation(s.to) === normalizeStation(b));

  // a) Tagesroute wie aufgezeichnet
  const byp = bypassedOf(orig, route);
  checkResult(t.key, 'Tagesroute', orig, mergeBypassedBoundaries(orig, byp), route, byp.map(idxOfBoundary));
  scenarios++;

  // b) Umleitung simulieren: jeden vorhandenen inneren Wende-Bahnhof einzeln aus der
  //    Tagesroute entfernen (Zug faehrt dort vorbei, ohne zu halten/wenden)
  for (let k = 0; k < orig.length - 1; k++) {
    const idx = findInStationList(normalizeStation(orig[k].to), route.map(s => normalizeStation(s.name)));
    if (idx <= 0 || idx >= route.length - 1) continue;
    const detour = route.filter((_, i) => i !== idx);
    const bypD = bypassedOf(orig, detour);
    if (!coordsOf(orig[k].to)) { noCoords++; continue; }   // Testdaten-Luecke, keine Aussage moeglich
    if (!bypD.some(b => idxOfBoundary(b) === k)) { notRecognised++; continue; }   // z. B. Halt weit abseits der Nachbarhalte — keine echte Umleitung
    checkResult(t.key, `Umleitung an ${orig[k].to}`, orig, mergeBypassedBoundaries(orig, bypD), detour, bypD.map(idxOfBoundary));
    scenarios++;
  }

  // c) HART: reale Umleitung Frankfurt Hbf → Frankfurt(Main)Sued (ICE 594/677 am
  //    17./29.10.2026) muss bei JEDEM Zug mit Wende in Frankfurt Hbf erkannt werden
  const kF = orig.findIndex((s, k) => k < orig.length - 1 && /frankfurtmainhauptbahnhof/.test(normalizeStation(s.to)));
  const iF = kF >= 0 ? findInStationList(normalizeStation(orig[kF].to), route.map(s => normalizeStation(s.name))) : -1;
  if (iF > 0 && iF < route.length - 1) {
    const sued = { name: 'Frankfurt(Main)Süd', lat: 50.0991, lon: 8.6866 };
    const viaSued = route.map((s, i) => i === iF ? { ...s, ...sued } : s);
    const bypS = bypassedOf(orig, viaSued);
    if (!bypS.some(b => idxOfBoundary(b) === kF)) fail(t.key, 'Umleitung Frankfurt Süd: NICHT als umfahren erkannt');
    else checkResult(t.key, 'Umleitung Frankfurt Süd', orig, mergeBypassedBoundaries(orig, bypS), viaSued, bypS.map(idxOfBoundary));
    scenarios++; frankfurtCases++;
  }
}

console.log(`Invarianten: ${checked} Tageszüge mit Richtungswechsel, ${scenarios} Szenarien (Tagesroute + simulierte Umleitungen), ${noCoords} ohne Koordinaten, ${notRecognised} Simulationen ohne echte Umleitung; davon ${frankfurtCases} harte Frankfurt-Süd-Fälle`);
const kinds = {}; for (const f of failures) { const m = f.match(/R\d|nicht als umfahren/); kinds[m ? m[0] : 'sonst'] = (kinds[m ? m[0] : 'sonst'] || 0) + 1; }
if (failures.length) {
  console.log(`✗ ${failures.length} Verstöße:`, JSON.stringify(kinds));
  for (const f of failures.slice(0, 40)) console.log('  - ' + f);
  process.exit(1);
}
console.log('✓ alle Regeln eingehalten');
