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
// stationOrder = [{name, dep, arr}, ...] from bahn.expert
function computeSegmentDuration(fromName, toName, stationOrder) {
  if (!stationOrder?.length || !fromName || !toName) return null;

  const names = stationOrder.map(s => typeof s === 'string' ? s : s.name).map(normalizeStation);

  let fromIdx = findInStationList(normalizeStation(fromName), names);
  let toIdx = findInStationList(normalizeStation(toName), names);

  // Fall back to list edges if a boundary isn't found
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

// Find the correct station name from bahn.expert list that matches the (possibly dirty) input
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
