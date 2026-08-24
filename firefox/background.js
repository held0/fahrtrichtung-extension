// Service Worker for Fahrtrichtung Extension
// Fetches and parses fernbahn.de wagon order data
// Uses bahn.expert for definitive station lists
// NOTE: DOMParser is NOT available in service workers, so we use regex parsing

// utils.js is loaded via manifest.json background.scripts

const BG_VERSION = 3;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'fetchFernbahn') {
    handleFetchFernbahn(request)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleFetchFernbahn({ trainNumber, trainType, fromStation, toStation, travelDate }) {
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
    '| validity:', validEntry.validity);

  // Fetch definitive station list from bahn.expert
  let stationOrder = [];
  try {
    stationOrder = await fetchBahnExpertStations(trainType, trainNumber, dateStr);
  } catch (e) {
    console.warn('[Fahrtrichtung] bahn.expert fetch failed, trying fernbahn fallback:', e.message);
  }

  // bahn.expert resolves journeys by train NUMBER and can return a *different*
  // train that happens to share the number (e.g. "ICE 20" Wien–München vs. a
  // number-20 train Milano–Zürich). Such a list has zero overlap with the route
  // we parsed from fernbahn.de and would produce wrong/empty directions, so reject
  // it and fall back to fernbahn.de's own station order.
  if (stationOrder.length && !stationOrderMatchesEntry(stationOrder, validEntry)) {
    console.warn('[Fahrtrichtung] bahn.expert station list does not match fernbahn.de route',
      '| route:', validEntry.route,
      '| bahn.expert:', stationNames(stationOrder).join(' > '),
      '— falling back to fernbahn.de');
    stationOrder = [];
  }

  // Fallback: use fernbahn.de's own station order (guaranteed consistent with the
  // segments we parsed) whenever bahn.expert failed or returned the wrong train.
  if (!stationOrder.length) {
    stationOrder = await fetchFernbahnStationOrder(validEntry);
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
    fromSegmentIdx,
    toSegmentIdx
  };
}

// Fetch complete station list from bahn.expert API
async function fetchBahnExpertStations(trainType, trainNumber, travelDate) {
  // Step 1: Get journeyId from redirect (pass travel date for correct schedule)
  const datePart = travelDate || '0';
  const detailUrl = `https://bahn.expert/details/${trainType}%20${trainNumber}/${datePart}`;
  const resp = await fetch(detailUrl);
  const journeyIdMatch = resp.url.match(/\/j\/([^\/\?]+)/);
  if (!journeyIdMatch) {
    throw new Error('Could not get journeyId from bahn.expert');
  }
  const journeyId = decodeURIComponent(journeyIdMatch[1]);

  // Step 2: Call tRPC API to get journey details.
  // bahn.expert has switched its tRPC base path back and forth between
  // /api/trpc/ and /rpc/ — try the current one first, then the other.
  const input = JSON.stringify({ '0': JSON.stringify([journeyId]) });
  const query = `journey.detailsByJourneyId?batch=1&input=${encodeURIComponent(input)}`;
  let apiResp = await fetch(`https://bahn.expert/api/trpc/${query}`);
  if (!apiResp.ok) {
    apiResp = await fetch(`https://bahn.expert/rpc/${query}`);
  }
  if (!apiResp.ok) {
    throw new Error(`bahn.expert API returned ${apiResp.status}`);
  }

  const data = await apiResp.json();
  const raw = data[0]?.result?.data;
  if (!raw) throw new Error('Empty response from bahn.expert');

  return parseSuperjsonStops(raw);
}

// Fetch the station order from fernbahn.de's own detail page (via zug_id).
// This list always belongs to the exact entry we parsed, so it's the reliable
// fallback when bahn.expert is unreachable or returns the wrong train.
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

// Verify a bahn.expert station list actually belongs to the train we parsed from
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

// Parse the superjson flat-array response from bahn.expert into station objects
function parseSuperjsonStops(raw) {
  // raw is the superjson flat array — sometimes delivered as a JSON string,
  // sometimes already parsed, depending on the bahn.expert version.
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // superjson format: parsed[0] = template, parsed[1] = array of stop indices
  // Each stop: parsed[stopIdx] = { stopPlace: idx }, parsed[idx] = { name: nameIdx }
  const stopIndices = parsed[1];
  if (!Array.isArray(stopIndices)) throw new Error('Unexpected bahn.expert response format');

  const stations = [];
  for (const stopIdx of stopIndices) {
    const stop = parsed[stopIdx];
    if (!stop?.stopPlace) continue;
    const stopPlace = parsed[stop.stopPlace];
    if (!stopPlace?.name) continue;

    // Extract departure and arrival times
    let depTime = null, arrTime = null;
    if (stop.departure) {
      const depObj = parsed[stop.departure];
      if (depObj?.scheduledTime) {
        const st = parsed[depObj.scheduledTime];
        if (Array.isArray(st) && st[0] === 'Date') depTime = st[1];
      }
    }
    if (stop.arrival) {
      const arrObj = parsed[stop.arrival];
      if (arrObj?.scheduledTime) {
        const st = parsed[arrObj.scheduledTime];
        if (Array.isArray(st) && st[0] === 'Date') arrTime = st[1];
      }
    }

    stations.push({
      name: parsed[stopPlace.name],
      dep: depTime,
      arr: arrTime
    });
  }

  return stations;
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
