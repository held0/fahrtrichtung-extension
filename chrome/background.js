// Service Worker for Fahrtrichtung Extension
// Fetches and parses fernbahn.de wagon order data
// Uses bahn.de's own timetable API for definitive station lists (with times)
// NOTE: DOMParser is NOT available in service workers, so we use regex parsing

importScripts('utils.js');

const BG_VERSION = 4;

// ---------------------------------------------------------------------------
// Dev-Kennung: Eine entpackt geladene Entwicklungsversion bekommt ein anderes
// Icon (gelbes DEV-Band), damit sie sich in der Symbolleiste von der Store-
// Version unterscheidet. Erkennung ohne Zusatzberechtigung: Store-Installationen
// haben eine injizierte update_url im Manifest bzw. eine der bekannten Store-IDs.
// ---------------------------------------------------------------------------
const STORE_IDS = new Set([
  'oeonipcihoehcheadnelfokabaihcggh',   // Chrome Web Store
  'pldcdckanhipjkgcbnjpacmihapgebci',   // Edge Add-ons
  'fahrtrichtung@extension',            // Firefox AMO (gecko id)
]);

function isDevInstall() {
  try {
    const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : null;
    if (manifest && manifest.update_url) return false;
    return !STORE_IDS.has(chrome.runtime.id);
  } catch (e) { return false; }
}

function applyDevIcon() {
  if (!isDevInstall() || !chrome.action?.setIcon) return;
  chrome.action.setIcon({ path: { 16: 'icon-dev16.png', 48: 'icon-dev48.png', 128: 'icon-dev128.png' } }).catch?.(() => {});
  chrome.action.setTitle?.({ title: 'Fahrtrichtung (DEV, entpackt geladen)' });
}
applyDevIcon();
chrome.runtime.onInstalled.addListener(applyDevIcon);
chrome.runtime.onStartup?.addListener(applyDevIcon);

// Nach der Erst-Installation einmalig die Onboarding-Tour öffnen.
// Bewusst NUR bei reason === 'install' — Updates und Browser-Starts
// dürfen kein Tab aufreißen.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'fetchFernbahn') {
    handleFetchFernbahn(request)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.type === 'bookingDetected') {
    recordBooking(request)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (request.type === 'updateBadge') {
    updateFeedbackBadge().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// ============================================================================
// Lokaler Erfolgszaehler: Buchungen, die mit der Extension gemacht wurden, und
// die nachtraegliche Rueckfrage "Hat die Fahrtrichtung gestimmt?".
// ALLES bleibt in chrome.storage.local auf dem Geraet — es gibt keinen Server.
//   recentLookups: Zuege, die das Popup zuletzt angezeigt hat (24 h)
//   trips:         erkannte Buchungen mit Feedback (null | 'right' | 'wrong')
// ============================================================================

const LOOKUP_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;   // Buchung folgt der Anzeige binnen 6 h
const FEEDBACK_ALARM = 'fahrtrichtung-feedback';

// Reine Abgleich-Logik (testbar): welche neuen Trips entstehen aus einer
// erkannten Buchung? Ein Trip pro passendem Lookup; Duplikate (gleiche
// Auftragsnummer oder gleicher Zug am gleichen Tag) werden nicht doppelt angelegt.
function matchBookingToLookups(booking, lookups, trips, now) {
  const fresh = (lookups || []).filter(l => now - (l.ts || 0) <= LOOKUP_MATCH_WINDOW_MS);
  if (!fresh.length) return [];
  const trains = (booking.trains || []).map(t => t.replace(/\s+/g, ' ').trim().toUpperCase());
  let candidates = trains.length ? fresh.filter(l => trains.includes(String(l.trainFull).toUpperCase())) : [];
  // Kein Zugname auf der Bestaetigungsseite erkennbar: den juengsten Lookup nehmen,
  // wenn er hoechstens 2 h alt ist.
  if (!candidates.length && !trains.length) {
    const latest = fresh.slice().sort((a, b) => b.ts - a.ts)[0];
    if (latest && now - latest.ts <= 2 * 60 * 60 * 1000) candidates = [latest];
  }
  const dates = booking.travelDates || [];
  const created = [];
  const seenKey = new Set();
  for (const l of candidates) {
    // Reisedatum: das des Lookups; wenn die Seite Daten nennt und das Lookup-Datum
    // nicht darunter ist, ist es wahrscheinlich eine andere Reise -> ueberspringen.
    if (dates.length && l.travelDate && !dates.includes(l.travelDate)) continue;
    const key = `${l.trainFull}|${l.travelDate}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    const dup = (trips || []).some(t => (booking.orderNumber && t.orderNumber === booking.orderNumber && t.trainFull === l.trainFull)
      || (t.trainFull === l.trainFull && t.travelDate === l.travelDate));
    if (dup) continue;
    created.push({
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      trainFull: l.trainFull,
      from: l.from || '',
      to: l.to || '',
      travelDate: l.travelDate || '',
      direction: l.direction || '',
      orderNumber: booking.orderNumber || null,
      bookedAt: now,
      feedback: null,
      answeredAt: null,
    });
  }
  return created;
}

async function recordBooking(booking) {
  const { recentLookups = [], trips = [] } = await chrome.storage.local.get({ recentLookups: [], trips: [] });
  const created = matchBookingToLookups(booking, recentLookups, trips, Date.now());
  if (created.length) {
    await chrome.storage.local.set({ trips: trips.concat(created).slice(-200) });
    console.log('[Fahrtrichtung] Buchung erkannt, lokal gemerkt:', created.map(t => `${t.trainFull} ${t.travelDate}`).join(', '));
  }
  await updateFeedbackBadge();
  return { recorded: created.length };
}

// Trips, deren Reisetag vorbei ist und die noch kein Feedback haben
function dueTrips(trips, todayIso) {
  return (trips || []).filter(t => t.feedback === null && t.travelDate && t.travelDate < todayIso);
}

function localTodayIso(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function updateFeedbackBadge() {
  if (!chrome.action?.setBadgeText) return;
  const { trips = [] } = await chrome.storage.local.get({ trips: [] });
  const due = dueTrips(trips, localTodayIso());
  try {
    await chrome.action.setBadgeText({ text: due.length ? String(due.length) : '' });
    if (due.length) await chrome.action.setBadgeBackgroundColor({ color: '#ec0016' });
  } catch (e) { /* ignore */ }
}

// Taeglicher Check (Reisetag vorbei -> Badge), ohne Nutzerinteraktion
if (chrome.alarms) {
  const ensureAlarm = () => chrome.alarms.create(FEEDBACK_ALARM, { periodInMinutes: 12 * 60 });
  chrome.runtime.onInstalled.addListener(ensureAlarm);
  chrome.runtime.onStartup?.addListener(ensureAlarm);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FEEDBACK_ALARM) updateFeedbackBadge();
  });
}

// journeyHint (optional): exakte Zugkennung aus dem bahn.de-Sitzplatzdialog
//   { trainNumber, departureEva, departureTime: 'YYYY-MM-DDTHH:MM:SS',
//     arrivalEva, arrivalTime, zugfahrtKey }
// Damit findet bahn.de den Zug ohne jede Namens-/Nummernheuristik.
async function handleFetchFernbahn({ trainNumber, trainType, fromStation, toStation, travelDate, journeyHint }) {
  const year = travelDate ? new Date(travelDate).getFullYear() : new Date().getFullYear();
  const url = `https://www.fernbahn.de/datenbank/suche/?fahrplan_jahr=${year}&zug_nummer=${trainNumber}&filterview[]=1&filterview[]=2&fv_suche_reihungsverzeichnis=1`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fernbahn.de returned ${response.status}`);
  }

  const html = await response.text();
  const allEntries = parseEntries(html);

  // Filter entries by train type (fernbahn.de searches by number only, may return multiple types)
  const entries = allEntries.filter(e => e.trainName.toUpperCase().startsWith(trainType.toUpperCase()));

  if (entries.length === 0) {
    throw new Error(`Keine Wagenreihung gefunden für ${trainType} ${trainNumber}`);
  }

  const dateStr = travelDate || new Date().toISOString().slice(0, 10);
  const exactMatch = findValidEntry(entries, dateStr);
  const validEntry = exactMatch || entries[entries.length - 1];

  // Find the latest known validity end date across all entries
  let latestValidityTo = null;
  if (!exactMatch) {
    for (const e of entries) {
      const t = e.validity?.to || e.validity?.from;
      if (t && (!latestValidityTo || t > latestValidityTo)) latestValidityTo = t;
    }
  }

  console.log('[Fahrtrichtung]', trainType, trainNumber, 'date:', dateStr,
    '| entries:', entries.length,
    '| exactMatch:', !!exactMatch,
    '| latestValidityTo:', latestValidityTo,
    '| validity:', validEntry.validity,
    '| hint:', journeyHint ? `${journeyHint.departureEva}@${journeyHint.departureTime}` : 'none');

  // Fetch definitive station list (with scheduled times) from bahn.de
  let stationOrder = [];
  let stationSource = 'none';
  try {
    stationOrder = await fetchBahnDeStations(trainType, trainNumber, dateStr, { journeyHint, route: validEntry.route });
    stationSource = 'bahn.de';
  } catch (e) {
    console.warn('[Fahrtrichtung] bahn.de fetch failed, trying fernbahn fallback:', e.message);
  }

  // Safety net: the station list must belong to the route we parsed from
  // fernbahn.de (zero overlap = different train). With bahn.de we match the
  // exact train name, so this should never trigger — but a wrong list would
  // produce wrong/empty directions, so keep the guard.
  if (stationOrder.length && !stationOrderMatchesEntry(stationOrder, validEntry)) {
    console.warn('[Fahrtrichtung] bahn.de station list does not match fernbahn.de route',
      '| route:', validEntry.route,
      '| bahn.de:', stationNames(stationOrder).join(' > '),
      '— falling back to fernbahn.de');
    stationOrder = [];
    stationSource = 'none';
  }

  // Fallback: use fernbahn.de's own station order (guaranteed consistent with the
  // segments we parsed) whenever bahn.de failed or returned the wrong train.
  if (!stationOrder.length) {
    stationOrder = await fetchFernbahnStationOrder(validEntry);
    if (stationOrder.length) stationSource = 'fernbahn';
  } else if (stationSource === 'bahn.de') {
    // bahn.de lists only stops with passenger exchange. Night trains pass e.g.
    // Frankfurt(M)Hbf without letting anyone on or off, so the station is
    // missing — and with it the fernbahn segment boundary where the train
    // reverses. Insert such missing boundaries from fernbahn's own station
    // sequence (one extra request, only when a boundary is actually missing).
    stationOrder = await insertMissingBoundaries(stationOrder, validEntry, trainType);
  }

  const fromSegmentIdx = findSegmentForStation(validEntry.segments, fromStation, stationOrder);
  const toSegmentIdx = findSegmentForStation(validEntry.segments, toStation, stationOrder);

  return {
    bgVersion: BG_VERSION,
    trainFull: `${trainType} ${trainNumber}`,
    route: validEntry.route,
    validity: validEntry.validity,
    validityExact: !!exactMatch,
    latestValidityTo,
    segments: validEntry.segments,
    wagonNumbers: validEntry.wagonNumbers,
    stationOrder,
    stationSource,
    fromSegmentIdx,
    toSegmentIdx
  };
}

// ============================================================================
// bahn.de timetable API ("reiseloesung")
//
// Same API the bahn.de website itself uses. Flow:
//   1. departures board at a station for a 1-hour window
//      GET /web/api/reiseloesung/abfahrten?datum=YYYY-MM-DD&zeit=HH:MM:SS&ortExtId=<eva>
//      -> entries[] with verkehrmittel.name ("ICE 691"), zeit, journeyId
//   2. full train run for that journeyId
//      GET /web/api/reiseloesung/fahrt?journeyId=...&poly=false
//      -> halte[] with name, extId, ankunft.sollzeit / abfahrt.sollzeit
//
// With a journeyHint (from the seat dialog) step 1 is ONE request at the exact
// departure station/time. Without a hint (website search, tests) we look up the
// route's origin station and scan the day hour by hour.
// ============================================================================

const BAHN_DE_HOSTS = ['https://www.bahn.de', 'https://int.bahn.de'];
const BAHN_DE_PRODUCTS = ['ICE', 'EC_IC', 'IR'];
// Fernverkehrsgattungen, zwischen denen dieselbe Zugnummer denselben Zug meint:
// fernbahn.de fuehrt z.B. "IC 1979", bahn.de zeigt "ICE 1979"; "RJ 251" vs "RJX 251".
const LONG_DISTANCE_TYPES = new Set(['ICE', 'IC', 'EC', 'ECE', 'RJ', 'RJX', 'NJ', 'EN', 'TGV', 'EST', 'IR', 'D']);

// Passt ein Tafel-Eintrag zum gesuchten Zug? Exakter Name zuerst; sonst gleiche
// Nummer, wenn beide Gattungen Fernverkehr sind (der Wrong-Train-Guard in
// handleFetchFernbahn faengt danach noch Zuege mit fremder Route ab).
function boardEntryMatches(entryName, trainName) {
  if (entryName === trainName) return true;
  const a = entryName.match(/^([A-Z]+)\s+(\d+)$/);
  const b = trainName.match(/^([A-Z]+)\s+(\d+)$/);
  if (!a || !b || a[2] !== b[2]) return false;
  return LONG_DISTANCE_TYPES.has(a[1]) && LONG_DISTANCE_TYPES.has(b[1]);
}

async function fetchBahnDeStations(trainType, trainNumber, travelDate, opts = {}) {
  const trainName = `${trainType} ${trainNumber}`;
  const hint = opts.journeyHint;

  let journeyId = null;
  if (hint && hint.departureEva && hint.departureTime) {
    journeyId = await findJourneyByHint(trainName, hint);
    if (!journeyId) console.warn('[Fahrtrichtung] bahn.de: train not found at hinted departure, scanning the day');
  }
  if (!journeyId) {
    journeyId = await findJourneyByScan(trainName, travelDate, opts.route, hint);
  }
  if (!journeyId) throw new Error(`bahn.de: ${trainName} not found on ${travelDate}`);

  const run = await bahnDeGetJson('/web/api/reiseloesung/fahrt', { journeyId, poly: 'false' });
  const stops = parseBahnDeHalte(run?.halte);
  if (!stops.length) throw new Error('bahn.de: empty train run');
  return stops;
}

// Departure board at the hinted station around the hinted time -> journeyId.
// Tries the exact minute first, then a wider window (in case the dialog time
// and the board time differ slightly, e.g. after a schedule change).
async function findJourneyByHint(trainName, hint) {
  const date = hint.departureTime.slice(0, 10);
  const wanted = hint.departureTime.slice(0, 16);           // YYYY-MM-DDTHH:MM
  for (const offsetMin of [2, 45]) {
    const zeit = shiftTime(hint.departureTime.slice(11, 16), -offsetMin);
    const entries = await fetchDepartures(hint.departureEva, date, zeit);
    // Rangfolge: exakter Name + Minute > exakter Name > gleiche Nummer + Minute > gleiche Nummer
    const pick = entries.find(e => e.name === trainName && e.zeit.slice(0, 16) === wanted)
      || entries.find(e => e.name === trainName)
      || entries.find(e => boardEntryMatches(e.name, trainName) && e.zeit.slice(0, 16) === wanted)
      || entries.find(e => boardEntryMatches(e.name, trainName));
    if (pick) return pick.journeyId;
  }
  return null;
}

// No hint: resolve the origin station of the fernbahn route ("Berlin-Gesundbrunnen — München Hbf")
// and scan its departures over the day. If the train doesn't show up there (rerouted),
// try the terminus' arrivals as well.
async function findJourneyByScan(trainName, travelDate, route, hint) {
  const [originName, terminusName] = (route || '').split(/\s+[–—-]+\s+/).map(s => s.trim());
  const candidates = [];
  if (hint?.departureEva) candidates.push({ eva: hint.departureEva, board: 'abfahrten' });
  if (originName) {
    const eva = await resolveStationEva(originName);
    if (eva) candidates.push({ eva, board: 'abfahrten' });
  }
  if (terminusName) {
    const eva = await resolveStationEva(terminusName);
    if (eva) candidates.push({ eva, board: 'ankuenfte' });
  }

  // Long-distance trains run roughly 04:00–24:00; start there, wrap around after.
  const hours = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3];
  for (const c of candidates) {
    for (const h of hours) {
      const entries = await fetchDepartures(c.eva, travelDate, `${String(h).padStart(2, '0')}:00:00`, c.board);
      const hit = entries.find(e => e.name === trainName) || entries.find(e => boardEntryMatches(e.name, trainName));
      if (hit) return hit.journeyId;
    }
  }
  return null;
}

async function fetchDepartures(eva, date, zeit, board = 'abfahrten') {
  const params = { datum: date, zeit, ortExtId: String(eva), mitVias: 'false' };
  const data = await bahnDeGetJson(`/web/api/reiseloesung/${board}`, params, BAHN_DE_PRODUCTS.map(p => ['verkehrsmittel[]', p]));
  return parseBahnDeBoard(data?.entries);
}

async function resolveStation(name) {
  const data = await bahnDeGetJson('/web/api/reiseloesung/orte', { suchbegriff: name, typ: 'ALL', limit: '5' });
  if (!Array.isArray(data)) return null;
  const wantedNorm = normalizeStation(name);
  const stations = data.filter(o => o?.type === 'ST' && o.extId);
  // Prefer an exact (normalized) name match, else the first station result
  const st = stations.find(o => normalizeStation(o.name) === wantedNorm) || stations[0];
  if (!st) return null;
  return { extId: String(st.extId), name: st.name, lat: typeof st.lat === 'number' ? st.lat : null, lon: typeof st.lon === 'number' ? st.lon : null };
}

async function resolveStationEva(name) {
  const st = await resolveStation(name);
  return st ? st.extId : null;
}

// GET helper: tries www.bahn.de, then int.bahn.de. Backs off and retries on
// 429/5xx. bahn.de's limiter allows a burst of ~30 requests, then only a slow
// trickle for a while (measured 2026-09-11) — one popup needs 2 requests, a
// full day scan up to ~25, so keep a gap between calls and wait properly on 429.
const BAHN_DE_MIN_GAP_MS = 250;
let bahnDeNextSlot = 0;
async function bahnDeGetJson(path, params, extraPairs = []) {
  const qs = new URLSearchParams(params);
  for (const [k, v] of extraPairs) qs.append(k, v);
  let lastErr = null;
  for (const host of BAHN_DE_HOSTS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = Date.now();
      const slot = Math.max(now, bahnDeNextSlot);
      bahnDeNextSlot = slot + BAHN_DE_MIN_GAP_MS;
      if (slot > now) await sleep(slot - now);
      try {
        const resp = await fetch(`${host}${path}?${qs.toString()}`, {
          headers: { 'Accept': 'application/json' },
        });
        if (resp.status === 429 || resp.status >= 500) {
          lastErr = new Error(`bahn.de ${path} HTTP ${resp.status}`);
          const retryAfter = Number(resp.headers?.get?.('retry-after')) || 0;
          await sleep(retryAfter ? Math.min(retryAfter, 20) * 1000 : (resp.status === 429 ? 3000 : 700) * (attempt + 1));
          continue;
        }
        if (!resp.ok) {
          // 4xx (403 Akamai, 400 Parameter, 404): Wiederholen bringt nichts —
          // direkt den naechsten Host probieren.
          lastErr = new Error(`bahn.de ${path} HTTP ${resp.status}`);
          break;
        }
        return await resp.json();
      } catch (e) {
        lastErr = e;
        await sleep(300 * (attempt + 1));   // Netzwerk-/Parsefehler: kurz warten, nochmal
      }
    }
  }
  throw lastErr || new Error('bahn.de unreachable');
}

function sleep(ms) {
  if (typeof setTimeout !== 'function') return Promise.resolve();   // reduzierte Sandboxes
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Board entries -> { name: "ICE 691", zeit: "2026-09-11T17:17:00", journeyId }
function parseBahnDeBoard(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const e of entries) {
    const name = (e?.verkehrmittel?.name || e?.verkehrmittel?.mittelText || '').replace(/\s+/g, ' ').trim();
    if (!name || !e.journeyId) continue;
    out.push({ name, zeit: e.zeit || '', journeyId: e.journeyId });
  }
  return out;
}

// Train run stops -> internal station format ({ name, dep, arr }), times as
// ISO strings in local (Europe/Berlin) time exactly as bahn.de delivers them.
function parseBahnDeHalte(halte) {
  if (!Array.isArray(halte)) return [];
  return halte
    .filter(h => h?.name)
    .map(h => {
      const stop = {
        name: h.name.replace(/\s+/g, ' ').trim(),
        dep: h.abfahrt?.sollzeit || null,
        arr: h.ankunft?.sollzeit || null,
      };
      const xy = typeof h.id === 'string' ? h.id.match(/@X=(-?\d+)@Y=(-?\d+)/) : null;
      if (xy) { stop.lon = Number(xy[1]) / 1e6; stop.lat = Number(xy[2]) / 1e6; }
      return stop;
    });
}

// "08:36" - 45 min -> "07:51:00" (same day; clamps at 00:00:00)
function shiftTime(hhmm, deltaMin) {
  const [h, m] = hhmm.split(':').map(Number);
  let total = h * 60 + m + deltaMin;
  if (total < 0) total = 0;
  if (total > 23 * 60 + 59) total = 23 * 60 + 59;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
}

// ============================================================================
// fernbahn.de
// ============================================================================

// Fetch the station order from fernbahn.de's own detail page (via zug_id).
// This list always belongs to the exact entry we parsed, so it's the reliable
// fallback when bahn.de is unreachable or returns the wrong train.
async function fetchFernbahnStationOrder(validEntry) {
  if (!validEntry.zugId) return [];
  try {
    const detailUrl = `https://www.fernbahn.de/datenbank/suche/?zug_id=${validEntry.zugId}`;
    const detailResp = await fetch(detailUrl);
    if (!detailResp.ok) return [];
    return parseFernbahnStationOrder(await detailResp.text()).map(name => ({ name, dep: null, arr: null }));
  } catch (e) {
    console.warn('[Fahrtrichtung] Fernbahn station-order fallback failed:', e.message);
    return [];
  }
}

// Insert segment-boundary stations that bahn.de omitted. Night trains (NJ/EN)
// pass e.g. Frankfurt(M)Hbf at 3 am without passenger exchange — bahn.de lists
// neither the stop nor shows it on any board, but the train DOES reverse there.
// Position is found GEOMETRICALLY: the run's stops carry coordinates, the
// boundary's come from the station search; it goes into the gap between two
// consecutive stops where the detour is smallest (and small in absolute terms).
//
// Deliberately NOT done for daytime trains: if an ICE/IC/RJ misses a Kopfbahnhof
// boundary today, it is being rerouted around it (construction) and does NOT
// reverse — the plain edge-clamp in findSegmentForStation (one direction for the
// whole run) is the right answer there. Only interior boundaries (where the
// direction actually changes) are considered; route endpoints never.
const NIGHT_TRAIN_TYPES = new Set(['NJ', 'EN', 'D']);
async function insertMissingBoundaries(stationOrder, validEntry, trainType) {
  if (!NIGHT_TRAIN_TYPES.has(String(trainType || '').toUpperCase())) return stationOrder;
  const segments = validEntry.segments || [];
  if (segments.length < 2) return stationOrder;
  const names = stationNames(stationOrder).map(normalizeStation);
  const boundaries = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const bnd = segments[i].to || segments[i + 1].from;
    if (bnd && !boundaries.includes(bnd)) boundaries.push(bnd);
  }
  const missing = boundaries.filter(bnd => findSegBoundary(bnd, names) < 0);
  if (!missing.length) return stationOrder;

  const result = stationOrder.slice();
  for (const bnd of missing) {
    let geo = null;
    try { geo = await resolveStation(bnd); } catch (e) { /* bahn.de down — leave list as is */ }
    if (!geo || geo.lat == null || geo.lon == null) continue;
    const at = bestInsertIndex(result, geo);
    if (at < 0) continue;
    result.splice(at, 0, { name: bnd, dep: null, arr: null, lat: geo.lat, lon: geo.lon, inferred: true });
    console.log('[Fahrtrichtung] boundary station missing on bahn.de, inserted by geometry:', bnd, '@', at);
  }
  return result;
}

// Index at which `point` fits best between consecutive stops with coordinates
// (minimal detour). Only interior gaps qualify, and the detour must be small —
// a boundary the train does not pass at all today (e.g. "Basel SBB" for a run
// that ends in Singen, or a rerouted train) must NOT be forced in. Returns -1
// if no gap qualifies.
const MAX_DETOUR_KM = 25;
const MAX_DETOUR_RATIO = 0.3;
function bestInsertIndex(stops, point) {
  let best = -1, bestDetour = Infinity;
  let prev = -1;
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].lat == null || stops[i].lon == null) continue;
    if (prev >= 0) {
      const direct = geoDistance(stops[prev], stops[i]);
      const detour = geoDistance(stops[prev], point) + geoDistance(point, stops[i]) - direct;
      // The point must also lie BETWEEN the two stops (projection onto the
      // connecting line inside the gap), not beyond one of them.
      const t = projectionParam(stops[prev], stops[i], point);
      if (t > 0 && t < 1 && detour < bestDetour && detour <= Math.max(MAX_DETOUR_KM, MAX_DETOUR_RATIO * direct)) { bestDetour = detour; best = i; }
    }
    prev = i;
  }
  return best;
}

// Where does `p` project onto the line a->b? 0 = at a, 1 = at b, outside = beyond.
function projectionParam(a, b, p) {
  const k = Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
  const abx = (b.lon - a.lon) * k, aby = b.lat - a.lat;
  const apx = (p.lon - a.lon) * k, apy = p.lat - a.lat;
  const len2 = abx * abx + aby * aby;
  return len2 ? (apx * abx + apy * aby) / len2 : 0;
}

// Equirectangular approximation in km — precise enough to order stops.
function geoDistance(a, b) {
  const toRad = d => d * Math.PI / 180;
  const x = (toRad(b.lon) - toRad(a.lon)) * Math.cos((toRad(a.lat) + toRad(b.lat)) / 2);
  const y = toRad(b.lat) - toRad(a.lat);
  return Math.sqrt(x * x + y * y) * 6371;
}

// Verify a station list actually belongs to the train we parsed from
// fernbahn.de. We anchor on stations we KNOW are on the route — the route
// endpoints ("Wien Hbf — München Hbf") and every segment boundary. If not a
// single anchor appears in the list, it's a different train sharing the number.
function stationOrderMatchesEntry(stationOrder, validEntry) {
  if (!stationOrder.length) return false;
  const names = stationNames(stationOrder).map(normalizeStation);

  const anchors = [];
  if (validEntry.route) {
    for (const part of validEntry.route.split(/\s+[–—-]+\s+/)) {
      const p = part.trim();
      if (p) anchors.push(p);
    }
  }
  for (const seg of validEntry.segments) {
    if (seg.from) anchors.push(seg.from);
    if (seg.to) anchors.push(seg.to);
  }
  if (!anchors.length) return true; // nothing to check against — don't reject

  return anchors.some(a => findSegBoundary(a, names) >= 0);
}

// Extract just the station names from stationOrder (which may be objects or strings)
function stationNames(stationOrder) {
  return stationOrder.map(s => typeof s === 'string' ? s : s.name);
}

// Determine which segment a station falls into using the definitive station order.
// Uses stationMatchLoose so "Hamburg Hbf" is found inside "Frankfurt – Hamburg-Altona" segment.
function findSegmentForStation(segments, station, stationOrder) {
  if (!station || !segments.length) return -1;

  const names = stationNames(stationOrder).map(normalizeStation);

  // Find station in the ordered list
  const stationIdx = findInStationList(normalizeStation(station), names);
  if (stationIdx < 0) return -1;

  // Find which segment contains this station by locating segment boundaries in the station list.
  // Uses stationMatchLoose for boundary lookup (e.g. "Hamburg Hbf" within "Hamburg-Altona" segment).
  let coverLo = -1, coverLoSeg = -1;   // lowest covered list index across all segments
  let coverHi = -1, coverHiSeg = -1;   // highest covered list index across all segments
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let segFromIdx = findSegBoundary(seg.from, names);
    let segToIdx = findSegBoundary(seg.to, names);

    // Fall back to list edges if a boundary isn't found
    if (segFromIdx < 0 && segToIdx >= 0) segFromIdx = 0;
    if (segToIdx < 0 && segFromIdx >= 0) segToIdx = names.length - 1;

    if (segFromIdx >= 0 && segToIdx >= 0) {
      const lo = Math.min(segFromIdx, segToIdx);
      const hi = Math.max(segFromIdx, segToIdx);
      if (stationIdx >= lo && stationIdx <= hi) return i;
      if (coverLo < 0 || lo < coverLo) { coverLo = lo; coverLoSeg = i; }
      if (coverHi < 0 || hi > coverHi) { coverHi = hi; coverHiSeg = i; }
    }
  }

  // Today's actual route can extend beyond the stretch fernbahn.de covers
  // (e.g. a rerouted ICE 691 starting in Hamburg while the wagon-order diagram
  // begins at Berlin). Stations outside the covered range belong to the
  // outermost segment on that side.
  if (coverLo >= 0 && stationIdx < coverLo) return coverLoSeg;
  if (coverHi >= 0 && stationIdx > coverHi) return coverHiSeg;

  return -1;
}

// Find a segment boundary station in the station list using loose matching.
// Tries exact/substring first (findInStationList), then falls back to stationMatchLoose.
function findSegBoundary(stationName, normNames) {
  const norm = normalizeStation(stationName);
  const idx = findInStationList(norm, normNames);
  if (idx >= 0) return idx;
  // Loose match: "Hamburg-Altona" should match near "Hamburg Hbf" in the list
  for (let i = 0; i < normNames.length; i++) {
    if (stationMatchLoose(norm, normNames[i])) return i;
  }
  return -1;
}


function parseEntries(html) {
  const entries = [];
  const entryPattern = /<div\s+class="reihungsverzeichnis-eintrag[^"]*"[^>]*>([\s\S]*?)<!-- reihungsverzeichnis-eintrag -->/g;
  let entryMatch;

  while ((entryMatch = entryPattern.exec(html)) !== null) {
    const block = entryMatch[1];
    const entry = parseEntry(block);
    if (entry) entries.push(entry);
  }

  return entries;
}

function parseEntry(block) {
  const zugnrMatch = block.match(/<div\s+class="zugnr">([\s\S]*?)<\/div>/);
  const trainName = zugnrMatch ? stripHtml(zugnrMatch[1]).trim() : '';

  const vonbisMatch = block.match(/<div\s+class="vonbis">([\s\S]*?)<\/div>/);
  const route = vonbisMatch ? decodeEntities(stripHtml(vonbisMatch[1])).replace(/\s+/g, ' ').trim() : '';

  const richtungMatch = block.match(/<div\s+class="richtungswechsel">([\s\S]*?)<\/div>/);
  const segments = richtungMatch ? parseRichtungswechsel(richtungMatch[1]) : [];

  const wagonNumbers = [];
  const wagenNumPattern = /<span\s+class="wagen-nummer">(\d+)<\/span>/g;
  let wm;
  while ((wm = wagenNumPattern.exec(block)) !== null) {
    wagonNumbers.push(wm[1]);
  }

  const zugnameMatch = block.match(/<div\s+class="zugname">([\s\S]*?)<\/div>/);
  const validity = parseValidity(zugnameMatch ? zugnameMatch[1] : '');

  const zugIdMatch = block.match(/zug_id=(\d+)/);
  const zugId = zugIdMatch ? zugIdMatch[1] : null;

  return { trainName, route, segments, wagonNumbers, validity, zugId };
}

function parseRichtungswechsel(html) {
  const segments = [];
  const parts = html.split(/<br\s*\/?>/i).filter(p => p.trim());

  for (const part of parts) {
    const hasLeftArrow = part.includes('pfeillinks');
    const hasRightArrow = part.includes('pfeilrechts');

    const textContent = decodeEntities(stripHtml(part)).trim();
    if (!textContent) continue;

    // Segment separator is a dash surrounded by whitespace (" – ").
    // Require whitespace on BOTH sides so hyphens *inside* station names
    // (Berlin-Gesundbrunnen, München-Pasing, Baden-Baden) don't split a segment.
    const routeMatch = textContent.match(/(.+?)\s+[–—-]\s+(.+)/);
    const from = routeMatch ? routeMatch[1].trim() : textContent;
    const to = routeMatch ? routeMatch[2].trim() : '';

    segments.push({
      from,
      to,
      direction: hasLeftArrow ? 'left' : (hasRightArrow ? 'right' : 'unknown'),
      text: textContent,
      firstWagonIsFront: hasLeftArrow
    });
  }

  return segments;
}

function parseValidity(html) {
  const text = decodeEntities(stripHtml(html)).replace(/\s+/g, ' ').replace(/\s*ansehen\s*$/, '').trim();

  const timePattern = /<time\s+datetime="([^"]+)">/g;
  const times = [];
  let tm;
  while ((tm = timePattern.exec(html)) !== null) {
    times.push(tm[1]);
  }

  let from = times[0] || null;
  let to = times[1] || null;

  // Single date: "bis 08.06.2026" = valid UNTIL, "ab 08.06.2026" = valid FROM
  if (times.length === 1) {
    if (text.includes(' bis ')) {
      to = times[0];
      from = null;
    } else {
      // "ab" or other context: treat as start date
      to = null;
    }
  }

  // Parse day-of-week restrictions from text
  // Examples: "Mo", "Mo-Sa", "Di, Mi, Do, Fr, Sa, So", "tgl" (= daily)
  const dayMap = { 'mo': 1, 'di': 2, 'mi': 3, 'do': 4, 'fr': 5, 'sa': 6, 'so': 0 };
  let days = null; // null = all days
  if (text && !text.includes('tgl')) {
    // Match day abbreviations before the first date or "ab"/"bis"
    const dayPart = text.match(/gültig\s+(.+?)(?:\s+\d|\s+ab\s|\s+bis\s)/i);
    if (dayPart) {
      const dayStr = dayPart[1].trim();
      // Parse comma-separated parts, each can be a range ("Mo-Fr") or single day ("So")
      days = [];
      const parts = dayStr.split(/,\s*/);
      for (const part of parts) {
        const rangeMatch = part.match(/^(Mo|Di|Mi|Do|Fr|Sa|So)-(Mo|Di|Mi|Do|Fr|Sa|So)$/i);
        if (rangeMatch) {
          const startDay = dayMap[rangeMatch[1].toLowerCase()];
          const endDay = dayMap[rangeMatch[2].toLowerCase()];
          for (let d = startDay; ; d = (d + 1) % 7) {
            days.push(d);
            if (d === endDay) break;
          }
        } else {
          const abbrs = part.match(/\b(Mo|Di|Mi|Do|Fr|Sa|So)\b/gi);
          if (abbrs?.length) {
            days = days.concat(abbrs.map(a => dayMap[a.toLowerCase()]));
          }
        }
      }
    }
  }

  return { text, from, to, days };
}

function findValidEntry(entries, dateStr) {
  const date = new Date(dateStr);
  const dayOfWeek = date.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  for (const entry of entries) {
    const { from, to, days } = entry.validity;

    // Check day-of-week restriction
    if (days && !days.includes(dayOfWeek)) continue;

    if (from && to) {
      if (date >= new Date(from) && date <= new Date(to)) return entry;
    } else if (from && !to) {
      if (date >= new Date(from)) return entry;
    } else if (!from && to) {
      if (date <= new Date(to)) return entry;
    } else {
      // No dates specified - entry is always valid (entire timetable period)
      return entry;
    }
  }

  return null;
}

// Fallback: parse fernbahn.de detail page for station order
function parseFernbahnStationOrder(html) {
  const stations = [];

  const startMatch = html.match(/id="zls-daten-bahnhof-start"[^>]*>([^<]+)/);
  if (startMatch) stations.push(decodeEntities(startMatch[1]).trim());

  const viaPattern = /id="zls-daten-bahnhof-via\d+"[^>]*>([^<]*)/g;
  let vm;
  while ((vm = viaPattern.exec(html)) !== null) {
    const text = decodeEntities(vm[1]).trim();
    if (text) {
      for (const s of text.split(/\s*-\s*/)) {
        const station = s.trim();
        if (station) stations.push(station);
      }
    }
  }

  const endMatch = html.match(/id="zls-daten-bahnhof-ziel"[^>]*>([^<]+)/);
  if (endMatch) stations.push(decodeEntities(endMatch[1]).trim());

  return stations;
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '');
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}
