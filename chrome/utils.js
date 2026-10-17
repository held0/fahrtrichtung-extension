// Shared utility functions for Fahrtrichtung extension
// Used by both background.js (via importScripts) and popup.js (via <script>)

function normalizeStation(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(m\)/g, '(main)')       // Frankfurt(M) → Frankfurt(Main)
    .replace(/\bfernbf\b/g, 'fernbahnhof')  // Fernbf → Fernbahnhof
    .replace(/\bhbf\b/g, 'hauptbahnhof')    // Hbf → Hauptbahnhof
    .replace(/[^a-zäöüß0-9]/g, '');
}

// Find a station name in a normalized list, with fuzzy substring matching.
// Returns index or -1. Prefers exact match, then closest-length substring match.
function findInStationList(needle, normList) {
  if (!needle) return -1;
  // Exact match first
  let idx = normList.indexOf(needle);
  if (idx >= 0) return idx;

  // Substring match: prefer the closest length match to avoid "hamburg" matching "hamburgharburg"
  // instead of "hamburghbf"
  let bestIdx = -1;
  let bestLenDiff = Infinity;
  for (let i = 0; i < normList.length; i++) {
    const s = normList[i];
    if (s.includes(needle) || needle.includes(s)) {
      const diff = Math.abs(s.length - needle.length);
      if (diff < bestLenDiff) {
        bestLenDiff = diff;
        bestIdx = i;
      }
    }
  }
  return bestIdx;
}

// Check if two normalized station names match (exact or substring).
// Used for segment boundary lookups where "Hamburg Hbf" should match within a
// segment that contains it.  Does NOT do core-city matching because
// "Hamburg-Altona" and "Hamburg Hbf" are different stations.
function stationMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

// Looser match: also compares core city names (stripping suffixes like Hbf, Altona).
// Used by findSegmentForStation where "Hamburg Hbf" should be found inside the
// "Frankfurt – Hamburg-Altona" segment.
function stationMatchLoose(a, b) {
  if (stationMatch(a, b)) return true;
  const coreA = a.replace(/(hauptbahnhof|ostbahnhof|sudkreuz|südkreuz|altona|hof|zoo|fernbahnhof)$/g, '').trim();
  const coreB = b.replace(/(hauptbahnhof|ostbahnhof|sudkreuz|südkreuz|altona|hof|zoo|fernbahnhof)$/g, '').trim();
  return coreA.length > 2 && coreB.length > 2 && (coreA.includes(coreB) || coreB.includes(coreA));
}

// Compute duration between two station names using the stationOrder (with times).
// stationOrder = [{name, dep, arr}, ...] from bahn.de (times = local ISO strings without zone)
// innerBoundaries (optional): Namen der Richtungswechsel-Bahnhoefe ZWISCHEN zwei
// Abschnitten. Fehlt so ein Bahnhof in der Tages-Stationsliste (z. B. ICE ueber
// Frankfurt Flughafen statt Hbf), waere der Rueckfall auf den Listenrand falsch —
// jeder Abschnitt bekaeme die Gesamtfahrzeit. Dann lieber keine Dauer anzeigen.
function computeSegmentDuration(fromName, toName, stationOrder, innerBoundaries = []) {
  if (!stationOrder?.length || !fromName || !toName) return null;

  const names = stationOrder.map(s => typeof s === 'string' ? s : s.name).map(normalizeStation);

  let fromIdx = findInStationList(normalizeStation(fromName), names);
  let toIdx = findInStationList(normalizeStation(toName), names);

  const isInner = name => innerBoundaries.some(b => normalizeStation(b) === normalizeStation(name));
  if ((fromIdx < 0 && isInner(fromName)) || (toIdx < 0 && isInner(toName))) return null;

  // Fall back to list edges if an outer boundary (route start/end) isn't found
  if (fromIdx < 0 && toIdx >= 0) fromIdx = 0;
  if (toIdx < 0 && fromIdx >= 0) toIdx = names.length - 1;

  if (fromIdx < 0 || toIdx < 0) return null;

  const fromStation = stationOrder[fromIdx];
  const toStation = stationOrder[toIdx];

  const depTime = typeof fromStation === 'string' ? null : (fromStation.dep || fromStation.arr);
  const arrTime = typeof toStation === 'string' ? null : (toStation.arr || toStation.dep);

  if (!depTime || !arrTime) return null;

  const depMs = new Date(depTime).getTime();
  const arrMs = new Date(arrTime).getTime();
  const diffMin = Math.round(Math.abs(arrMs - depMs) / 60000);

  return { hours: Math.floor(diffMin / 60), minutes: diffMin % 60 };
}

// Find the correct station name from the bahn.de station list that matches the (possibly dirty) input
// e.g. "Prüfen Angebote Abbrechen Karlsruhe Hbf" -> "Karlsruhe Hbf"
function cleanStationName(dirty, stationOrder) {
  if (!dirty || !stationOrder?.length) return dirty;
  const dirtyNorm = normalizeStation(dirty);

  // Check if any station from the list is contained in the dirty string
  let bestMatch = null;
  let bestLen = 0;
  for (const station of stationOrder) {
    const stNorm = normalizeStation(station);
    if (dirtyNorm.includes(stNorm) && stNorm.length > bestLen) {
      bestMatch = station;
      bestLen = stNorm.length;
    }
  }
  return bestMatch || dirty;
}

// Richtung in der bahn.de-Sitzplatzansicht. bahn.de zeigt die Wagen immer
// aufsteigend links->rechts, auch bei Mehrfachtraktion (21..29 | 31..39).
// Deshalb entscheidet jeder Zugteil selbst: Faellt seine Nummerierung von
// vorne nach hinten (29,28,..,21), liegt seine Spitze in der Ansicht rechts.
// Der fruehere Vergleich "Frontwagen > Mittelwert aller Nummern" lag bei
// Doppeltraktion daneben (ICE 225: Front 29, Mittel 30 -> faelschlich links).
// Zugteile = Bloecke ohne Nummernsprung > 2 zwischen Nachbarwagen.
// Physische Reihung als Zugteile, vorderster Wagen zuerst (Block ohne Nummernsprung > 2)
function getPhysicalUnits(seg, wagonNumbers) {
  const nums = (wagonNumbers || []).map(Number).filter(n => !isNaN(n));
  if (nums.length < 2) return [];
  const phys = seg.firstWagonIsFront ? nums : [...nums].reverse();
  const units = [[phys[0]]];
  for (let i = 1; i < phys.length; i++) {
    if (Math.abs(phys[i] - phys[i - 1]) > 2) units.push([]);
    units[units.length - 1].push(phys[i]);
  }
  return units;
}

function getUnitDirections(seg, wagonNumbers) {
  return getPhysicalUnits(seg, wagonNumbers)
    .filter(u => u.length >= 2)
    .map(u => ({
      from: Math.min(...u),
      to: Math.max(...u),
      direction: u[0] > u[u.length - 1] ? 'right' : 'left',
    }))
    .sort((a, b) => a.from - b.from);
}

// 'left' | 'right' | 'mixed' (Zugteile fahren in der Ansicht gegenlaeufig,
// z.B. ICE 911: 39..31 | 21..29) — Fallback auf die fernbahn-Pfeilrichtung.
function getDisplayDirection(seg, wagonNumbers) {
  const units = getUnitDirections(seg, wagonNumbers);
  if (!units.length) return seg.direction;
  return units.every(u => u.direction === units[0].direction) ? units[0].direction : 'mixed';
}

// Wagen, der in der bahn.de-Ansicht in Fahrtrichtung ganz aussen liegt.
// Bei einem Zugteil ist das der physisch vorderste Wagen. Bei mehreren gleich
// gerichteten Zugteilen nennen wir bewusst den aeussersten Wagen der Ansicht
// (ICE 225: 39 statt des physisch vorderen 29, der in der Ansicht in der Mitte
// liegt und sonst verwirrt). Bei gegenlaeufigen Zugteilen: null.
function getDisplayFrontWagon(seg, wagonNumbers) {
  const units = getUnitDirections(seg, wagonNumbers);
  if (!units.length) {
    if (!wagonNumbers?.length) return null;
    return seg.firstWagonIsFront ? wagonNumbers[0] : wagonNumbers[wagonNumbers.length - 1];
  }
  if (!units.every(u => u.direction === units[0].direction)) return null;
  return units[0].direction === 'right'
    ? String(Math.max(...units.map(u => u.to)))
    : String(Math.min(...units.map(u => u.from)));
}

// Tageszug faehrt heute an einem Wende-Bahnhof (innere fernbahn-Segmentgrenze,
// meist ein Kopfbahnhof wie Frankfurt(M)Hbf) vorbei, z. B. umgeleitet ueber
// Frankfurt(Main)Sued: Dann wendet er NICHT — die beiden Abschnitte werden zu
// einem zusammengelegt. Die Richtung kommt von dem Abschnitt, den der Zug heute
// tatsaechlich faehrt: liegt der Start des vorderen Abschnitts auf der Route (oder
// gar keiner der Aussenpunkte), gilt der vordere, sonst der hintere.
// Bewusst strenger Namensvergleich (findInStationList): „Frankfurt(Main)Sued“
// darf nicht als „Frankfurt(M)Hbf“ durchgehen.
function mergeBypassedBoundaries(segments, stationOrder) {
  if (!Array.isArray(segments) || segments.length < 2 || !stationOrder?.length) return segments;
  const names = stationOrder.map(s => typeof s === 'string' ? s : s.name).map(normalizeStation);
  const found = name => !!name && findInStationList(normalizeStation(name), names) >= 0;
  const out = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const prev = out[out.length - 1];
    const seg = segments[i];
    const boundary = prev.to || seg.from;
    if (!boundary || found(boundary)) { out.push(seg); continue; }
    const keepPrev = found(prev.from) || !found(seg.to);
    const base = keepPrev ? prev : seg;
    out[out.length - 1] = {
      ...base,
      from: prev.from,
      to: seg.to,
      text: `${prev.from} \u2013 ${seg.to}`,
      mergedAt: [...(prev.mergedAt || []), boundary],
    };
  }
  return out;
}
