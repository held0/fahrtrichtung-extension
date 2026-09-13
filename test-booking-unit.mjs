#!/usr/bin/env node
// Unit-Tests fuer den lokalen Erfolgszaehler: Erkennung der Buchungsbestaetigung
// (chrome/booking.js, reine Funktionen) und Abgleich mit den zuletzt im Popup
// angezeigten Zuegen (chrome/background.js: matchBookingToLookups, dueTrips).
// Kein Netz, kein DOM. Usage: node test-booking-unit.mjs

import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = path.join(__dirname, 'chrome');
let passed = 0, failed = 0;
function assert(desc, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++; else { failed++; console.log(`  FAIL: ${desc}\n        got ${JSON.stringify(actual)}\n        exp ${JSON.stringify(expected)}`); }
}
function group(n) { console.log(`\n${n}`); }

// booking.js ohne document/chrome -> nur die reinen Funktionen werden definiert
const bookingCtx = { console };
vm.createContext(bookingCtx);
vm.runInContext(fs.readFileSync(path.join(CHROME, 'booking.js'), 'utf8'), bookingCtx);

// background.js mit Stubs (kein fetch noetig)
const bgSrc = fs.readFileSync(path.join(CHROME, 'background.js'), 'utf8').replace(/importScripts\([^)]*\);/g, '');
const bgCtx = {
  console: { log() {}, warn() {}, error() {} }, fetch: async () => { throw new Error('no net'); },
  chrome: { runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} }, getURL: p => p },
    tabs: { create() {} }, alarms: { create() {}, onAlarm: { addListener() {} } }, storage: { local: { get: async () => ({}), set: async () => {} } }, action: {} },
  URLSearchParams, TextDecoder, DataView, Uint8Array, AbortSignal, setTimeout, clearTimeout,
  Date, JSON, Math, String, Array, Object, Number, parseInt, isNaN, encodeURIComponent, decodeURIComponent,
};
vm.createContext(bgCtx);
vm.runInContext(fs.readFileSync(path.join(CHROME, 'utils.js'), 'utf8'), bgCtx);
vm.runInContext(bgSrc, bgCtx);

const { detectBookingConfirmation, extractDates, extractTrains } = bookingCtx;
const { matchBookingToLookups, dueTrips } = bgCtx;

group('detectBookingConfirmation()');
{
  const page = `Vielen Dank für Ihre Buchung! Ihre Buchung war erfolgreich. Auftragsnummer: AB12CD34
    Hinfahrt Sa. 12. Sep. 2026 ICE 1005 Berlin Hbf – München Hbf 08:36 – 12:46 Sitzplatz Wagen 25 Platz 14`;
  const r = detectBookingConfirmation(page, 'https://www.bahn.de/buchung/bestaetigung');
  assert('erkannt', r.isConfirmation, true);
  assert('Auftragsnummer', r.orderNumber, 'AB12CD34');
  assert('Zug erkannt', r.trains, ['ICE 1005']);
  assert('Reisedatum erkannt (Sa. 12. Sep. 2026)', r.travelDates, ['2026-09-12']);

  assert('Suchseite mit Zuegen, aber ohne Auftragsnummer -> keine Buchung',
    detectBookingConfirmation('ICE 1005 Berlin Hbf – München Hbf 08:36 Weiter Buchung erfolgreich?', 'https://www.bahn.de/buchung/fahrplan/suche').isConfirmation, false);
  assert('Auftragsnummer ohne Erfolgsformulierung und ohne URL-Hinweis -> keine Buchung',
    detectBookingConfirmation('Auftragsnummer: XY98765Z eingeben, um Ihre Buchung zu finden', 'https://www.bahn.de/buchung/auftragssuche').isConfirmation, false);
  assert('Auftragsnummer + URL-Hinweis reicht', detectBookingConfirmation('Auftragsnummer XY98765Z', 'https://www.bahn.de/buchung/bestaetigung').isConfirmation, true);
  assert('englische Seite', detectBookingConfirmation('Thank you for your booking. Order number: QWERTY99 ICE 77 Sat 12 Sep 2026', 'https://int.bahn.de/en/booking/x').orderNumber, 'QWERTY99');
  assert('Auftragsnummer wird gross geschrieben', detectBookingConfirmation('Buchung erfolgreich. Buchungsnummer: ab12cd34', '').orderNumber, 'AB12CD34');
  assert('Reservierung bestaetigt zaehlt', detectBookingConfirmation('Ihre Reservierung wurde bestätigt. Auftrags-Nr. 12345678', '').isConfirmation, true);
}

group('extractDates() / extractTrains()');
{
  assert('numerisch', extractDates('Reise am 12.09.2026 und zurück 3.10.2026'), ['2026-09-12', '2026-10-03']);
  assert('Monatsname lang', extractDates('Do. 16. Juli 2026'), ['2026-07-16']);
  assert('Monatsname kurz mit Punkt', extractDates('Sa. 12. Sep. 2026'), ['2026-09-12']);
  assert('ungueltiger Monat ignoriert', extractDates('99.99.2026 und 31.13.2026'), []);
  assert('Duplikate einmal', extractDates('12.09.2026 12.09.2026'), ['2026-09-12']);
  assert('Zuege dedupliziert, Reihenfolge erhalten', extractTrains('ICE 1005, dann ICE1005 und IC 2375, RJX 251'), ['ICE 1005', 'IC 2375', 'RJX 251']);
  assert('Bus/S-Bahn nicht als Zug', extractTrains('Bus 5 und S 1 fahren auch'), []);
}

group('matchBookingToLookups()');
{
  const now = Date.parse('2026-09-11T14:00:00');
  const H = 60 * 60 * 1000;
  const lookups = [
    { trainFull: 'ICE 1005', from: 'Berlin Hbf', to: 'München Hbf', travelDate: '2026-09-12', direction: '→', ts: now - 1 * H },
    { trainFull: 'ICE 77', from: 'Hamburg Hbf', to: 'Basel SBB', travelDate: '2026-09-20', direction: '←→', ts: now - 8 * H },   // zu alt
  ];
  const b = { orderNumber: 'AB12CD34', trains: ['ICE 1005'], travelDates: ['2026-09-12'] };
  const created = matchBookingToLookups(b, lookups, [], now);
  assert('ein Trip aus passendem Lookup', created.length, 1);
  assert('Trip-Felder', [created[0].trainFull, created[0].from, created[0].to, created[0].travelDate, created[0].direction, created[0].orderNumber, created[0].feedback],
    ['ICE 1005', 'Berlin Hbf', 'München Hbf', '2026-09-12', '→', 'AB12CD34', null]);
  assert('zu alter Lookup (8 h) matcht nicht', matchBookingToLookups({ trains: ['ICE 77'], travelDates: [] }, lookups, [], now).length, 0);
  assert('Zug nicht angezeigt worden -> kein Trip', matchBookingToLookups({ trains: ['ICE 9999'], travelDates: [] }, lookups, [], now).length, 0);
  assert('Datum auf der Seite widerspricht dem Lookup -> kein Trip', matchBookingToLookups({ trains: ['ICE 1005'], travelDates: ['2026-10-01'] }, lookups, [], now).length, 0);
  assert('Duplikat (gleicher Zug, gleicher Tag) wird nicht doppelt angelegt', matchBookingToLookups(b, lookups, created, now).length, 0);
  assert('Duplikat per Auftragsnummer', matchBookingToLookups({ orderNumber: 'AB12CD34', trains: ['ICE 1005'], travelDates: [] }, lookups, [{ trainFull: 'ICE 1005', travelDate: '2026-09-12', orderNumber: 'AB12CD34' }], now).length, 0);
  assert('ohne Zugname auf der Seite: juengster Lookup (<2 h) zaehlt', matchBookingToLookups({ trains: [], travelDates: [] }, lookups, [], now)[0]?.trainFull, 'ICE 1005');
  assert('ohne Zugname und Lookup aelter als 2 h: nichts', matchBookingToLookups({ trains: [], travelDates: [] }, [{ ...lookups[0], ts: now - 3 * H }], [], now).length, 0);
  assert('keine Lookups -> nichts', matchBookingToLookups(b, [], [], now).length, 0);
}

group('dueTrips()');
{
  const trips = [
    { id: 'a', travelDate: '2026-09-10', feedback: null },
    { id: 'b', travelDate: '2026-09-12', feedback: null },    // heute -> noch nicht
    { id: 'c', travelDate: '2026-09-01', feedback: 'right' },
    { id: 'd', travelDate: '', feedback: null },
  ];
  assert('nur vergangene, unbeantwortete Fahrten', dueTrips(trips, '2026-09-12').map(t => t.id), ['a']);
  assert('am Folgetag ist auch b faellig', dueTrips(trips, '2026-09-13').map(t => t.id), ['a', 'b']);
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
