#!/usr/bin/env node
// Comprehensive train validation script
// Tests fernbahn.de parsing + bahn.expert station list matching for all trains
// Usage: node test-trains.mjs [--range 1-100] [--types ICE,IC,EC,ECE] [--date 2026-02-20] [--concurrency 5]

// ============================================================
// Import parsing functions from chrome/background.js & chrome/utils.js
// (copied here for Node.js compatibility - no importScripts/chrome APIs)
// ============================================================

function normalizeStation(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(m\)/g, '(main)')
    .replace(/\bfernbf\b/g, 'fernbahnhof')
    .replace(/\bhbf\b/g, 'hauptbahnhof')
    .replace(/[^a-zäöüß0-9]/g, '');
}

function findInStationList(needle, normList) {
  if (!needle) return -1;
  let idx = normList.indexOf(needle);
  if (idx >= 0) return idx;
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

function stationMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

function stationMatchLoose(a, b) {
  if (stationMatch(a, b)) return true;
  const coreA = a.replace(/(hauptbahnhof|ostbahnhof|sudkreuz|südkreuz|altona|hof|zoo|fernbahnhof)$/g, '').trim();
  const coreB = b.replace(/(hauptbahnhof|ostbahnhof|sudkreuz|südkreuz|altona|hof|zoo|fernbahnhof)$/g, '').trim();
  return coreA.length > 2 && coreB.length > 2 && (coreA.includes(coreB) || coreB.includes(coreA));
}

function stripHtml(html) { return html.replace(/<[^>]+>/g, ''); }

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

function parseEntries(html) {
  const entries = [];
  const entryPattern = /<div\s+class="reihungsverzeichnis-eintrag[^"]*"[^>]*>([\s\S]*?)<!-- reihungsverzeichnis-eintrag -->/g;
  let entryMatch;
  while ((entryMatch = entryPattern.exec(html)) !== null) {
    const entry = parseEntry(entryMatch[1]);
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
  while ((wm = wagenNumPattern.exec(block)) !== null) wagonNumbers.push(wm[1]);
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
    const routeMatch = textContent.match(/(.+?)\s*[–—\-]\s*(.+)/);
    segments.push({
      from: routeMatch ? routeMatch[1].trim() : textContent,
      to: routeMatch ? routeMatch[2].trim() : '',
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
  while ((tm = timePattern.exec(html)) !== null) times.push(tm[1]);
  let from = times[0] || null;
  let to = times[1] || null;
  if (times.length === 1) {
    if (text.includes(' bis ')) { to = times[0]; from = null; }
    else { to = null; }
  }
  const dayMap = { 'mo': 1, 'di': 2, 'mi': 3, 'do': 4, 'fr': 5, 'sa': 6, 'so': 0 };
  let days = null;
  if (text && !text.includes('tgl')) {
    const dayPart = text.match(/gültig\s+(.+?)(?:\s+\d|\s+ab\s|\s+bis\s)/i);
    if (dayPart) {
      const dayStr = dayPart[1].trim();
      const rangeMatch = dayStr.match(/^(Mo|Di|Mi|Do|Fr|Sa|So)-(Mo|Di|Mi|Do|Fr|Sa|So)$/i);
      if (rangeMatch) {
        const startDay = dayMap[rangeMatch[1].toLowerCase()];
        const endDay = dayMap[rangeMatch[2].toLowerCase()];
        days = [];
        for (let d = startDay; ; d = (d + 1) % 7) { days.push(d); if (d === endDay) break; }
      } else {
        const abbrs = dayStr.match(/\b(Mo|Di|Mi|Do|Fr|Sa|So)\b/gi);
        if (abbrs?.length) days = abbrs.map(a => dayMap[a.toLowerCase()]);
      }
    }
  }
  return { text, from, to, days };
}

function findValidEntry(entries, dateStr) {
  const date = new Date(dateStr);
  const dayOfWeek = date.getUTCDay();
  for (const entry of entries) {
    const { from, to, days } = entry.validity;
    if (days && !days.includes(dayOfWeek)) continue;
    if (from && to) { if (date >= new Date(from) && date <= new Date(to)) return entry; }
    else if (from && !to) { if (date >= new Date(from)) return entry; }
    else if (!from && to) { if (date <= new Date(to)) return entry; }
    else { return entry; }
  }
  return null;
}

function findSegBoundary(stationName, normNames) {
  const norm = normalizeStation(stationName);
  const idx = findInStationList(norm, normNames);
  if (idx >= 0) return idx;
  for (let i = 0; i < normNames.length; i++) {
    if (stationMatchLoose(norm, normNames[i])) return i;
  }
  return -1;
}

function parseSuperjsonStops(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const stopIndices = parsed[1];
  if (!Array.isArray(stopIndices)) throw new Error('Unexpected bahn.expert response format');
  const stations = [];
  for (const stopIdx of stopIndices) {
    const stop = parsed[stopIdx];
    if (!stop?.stopPlace) continue;
    const stopPlace = parsed[stop.stopPlace];
    if (!stopPlace?.name) continue;
    stations.push({ name: parsed[stopPlace.name] });
  }
  return stations;
}

// ============================================================
// Test runner
// ============================================================

const TRAIN_TYPES = ['ICE', 'ECE', 'IC', 'EC', 'RJX', 'RJ', 'TGV', 'NJ', 'EN'];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    rangeStart: 1,
    rangeEnd: 300,
    types: TRAIN_TYPES,
    date: new Date().toISOString().slice(0, 10),
    concurrency: 3
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--range' && args[i + 1]) {
      const [s, e] = args[++i].split('-').map(Number);
      opts.rangeStart = s;
      opts.rangeEnd = e;
    } else if (args[i] === '--types' && args[i + 1]) {
      opts.types = args[++i].split(',').map(t => t.trim().toUpperCase());
    } else if (args[i] === '--date' && args[i + 1]) {
      opts.date = args[++i];
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      opts.concurrency = parseInt(args[++i]);
    }
  }
  return opts;
}

async function fetchWithRetry(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url);
      if (!resp.ok && resp.status !== 404) throw new Error(`HTTP ${resp.status}`);
      return resp;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function fetchFernbahnEntries(number, year) {
  const url = `https://www.fernbahn.de/datenbank/suche/?fahrplan_jahr=${year}&zug_nummer=${number}&filterview[]=1&filterview[]=2&fv_suche_reihungsverzeichnis=1`;
  const resp = await fetchWithRetry(url);
  const html = await resp.text();
  return parseEntries(html);
}

async function fetchBahnExpertStations(trainType, trainNumber, travelDate) {
  const datePart = travelDate || '0';
  const detailUrl = `https://bahn.expert/details/${trainType}%20${trainNumber}/${datePart}`;
  const resp = await fetch(detailUrl, { redirect: 'follow' });
  const journeyIdMatch = resp.url.match(/\/j\/([^\/\?]+)/);
  if (!journeyIdMatch) throw new Error('No journeyId in redirect');
  const journeyId = decodeURIComponent(journeyIdMatch[1]);
  const input = JSON.stringify({ '0': JSON.stringify([journeyId]) });
  const query = `journey.detailsByJourneyId?batch=1&input=${encodeURIComponent(input)}`;
  let apiResp = await fetch(`https://bahn.expert/api/trpc/${query}`);
  if (!apiResp.ok) apiResp = await fetch(`https://bahn.expert/rpc/${query}`);
  if (!apiResp.ok) throw new Error(`bahn.expert API ${apiResp.status}`);
  const data = await apiResp.json();
  const raw = data[0]?.result?.data;
  if (!raw) throw new Error('Empty bahn.expert response');
  return parseSuperjsonStops(raw);
}

async function testTrain(trainType, trainNumber, date, allEntries) {
  const issues = [];
  const trainFull = `${trainType} ${trainNumber}`;

  // Filter entries for this train type
  const entries = allEntries.filter(e => e.trainName.toUpperCase().startsWith(trainType));
  if (entries.length === 0) return null; // Train doesn't exist for this type

  // Check validity matching
  const validEntry = findValidEntry(entries, date);
  if (!validEntry) {
    issues.push(`WARN: No valid entry for date ${date} (${entries.length} entries exist)`);
    // Use last entry as fallback for further checks
  }
  const entry = validEntry || entries[entries.length - 1];

  // Check segments
  if (entry.segments.length === 0) {
    issues.push('ERROR: No direction segments parsed');
  }
  for (const seg of entry.segments) {
    if (seg.direction === 'unknown') {
      issues.push(`WARN: Unknown direction for segment "${seg.text}"`);
    }
    if (!seg.to) {
      issues.push(`WARN: Segment has no destination: "${seg.text}"`);
    }
  }

  // Check wagon numbers
  if (entry.wagonNumbers.length === 0) {
    issues.push('WARN: No wagon numbers parsed');
  }

  // Check bahn.expert station list
  let stationOrder = [];
  try {
    stationOrder = await fetchBahnExpertStations(trainType, trainNumber, date);
    if (stationOrder.length === 0) {
      issues.push('ERROR: bahn.expert returned empty station list');
    }
  } catch (e) {
    issues.push(`WARN: bahn.expert failed: ${e.message}`);
  }

  // Check segment boundaries against station list
  if (stationOrder.length > 0) {
    const normNames = stationOrder.map(s => normalizeStation(s.name));
    for (const seg of entry.segments) {
      if (seg.from) {
        const fromIdx = findSegBoundary(seg.from, normNames);
        if (fromIdx < 0) {
          issues.push(`WARN: Segment start "${seg.from}" not found in station list`);
        }
      }
      if (seg.to) {
        const toIdx = findSegBoundary(seg.to, normNames);
        if (toIdx < 0) {
          issues.push(`WARN: Segment end "${seg.to}" not found in station list`);
        }
      }
    }

    // Check that segment order matches station order direction
    if (entry.segments.length >= 1) {
      const firstSeg = entry.segments[0];
      const lastSeg = entry.segments[entry.segments.length - 1];
      const firstFromIdx = findSegBoundary(firstSeg.from, normNames);
      const lastToIdx = findSegBoundary(lastSeg.to, normNames);
      if (firstFromIdx >= 0 && lastToIdx >= 0 && firstFromIdx > lastToIdx) {
        issues.push('WARN: Segments appear to be in reverse order vs station list');
      }
    }
  }

  return {
    train: trainFull,
    route: entry.route,
    entries: entries.length,
    validForDate: !!validEntry,
    segments: entry.segments.length,
    wagons: entry.wagonNumbers.length,
    stations: stationOrder.length,
    stationNames: stationOrder.map(s => s.name),
    issues
  };
}

async function runPool(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function main() {
  const opts = parseArgs();
  const year = new Date(opts.date).getFullYear();

  console.log(`\n=== Fahrtrichtung Train Validator ===`);
  console.log(`Date: ${opts.date} | Range: ${opts.rangeStart}-${opts.rangeEnd} | Types: ${opts.types.join(', ')} | Concurrency: ${opts.concurrency}\n`);

  // Phase 1: Fetch all fernbahn.de pages (by number, which returns all types)
  console.log(`Fetching fernbahn.de entries for numbers ${opts.rangeStart}-${opts.rangeEnd}...`);

  const numberEntries = new Map(); // number -> entries[]
  let fetchedCount = 0;
  const totalNumbers = opts.rangeEnd - opts.rangeStart + 1;

  const fetchTasks = [];
  for (let num = opts.rangeStart; num <= opts.rangeEnd; num++) {
    fetchTasks.push(async () => {
      try {
        const entries = await fetchFernbahnEntries(num, year);
        if (entries.length > 0) numberEntries.set(num, entries);
      } catch (e) {
        console.error(`  fernbahn.de error for #${num}: ${e.message}`);
      }
      fetchedCount++;
      if (fetchedCount % 50 === 0 || fetchedCount === totalNumbers) {
        process.stdout.write(`  Progress: ${fetchedCount}/${totalNumbers} numbers fetched, ${numberEntries.size} with entries\r`);
      }
    });
  }

  await runPool(fetchTasks, opts.concurrency);
  console.log(`\nFound ${numberEntries.size} numbers with wagon order entries.\n`);

  // Phase 2: Test each train type+number combination
  console.log('Validating trains against bahn.expert...');

  const allResults = [];
  const testTasks = [];

  for (const [num, entries] of numberEntries) {
    for (const trainType of opts.types) {
      const typeEntries = entries.filter(e => e.trainName.toUpperCase().startsWith(trainType));
      if (typeEntries.length === 0) continue;

      testTasks.push(async () => {
        try {
          const result = await testTrain(trainType, String(num), opts.date, entries);
          if (result) {
            allResults.push(result);
            if (result.issues.length > 0) {
              process.stdout.write(`  ${result.train}: ${result.issues.length} issue(s)\n`);
            }
          }
        } catch (e) {
          allResults.push({ train: `${trainType} ${num}`, issues: [`FATAL: ${e.message}`] });
        }
        // Rate limit bahn.expert
        await new Promise(r => setTimeout(r, 200));
      });
    }
  }

  await runPool(testTasks, opts.concurrency);

  // Phase 3: Report
  console.log('\n\n========================================');
  console.log('           VALIDATION REPORT');
  console.log('========================================\n');

  const withIssues = allResults.filter(r => r.issues.length > 0);
  const errors = allResults.filter(r => r.issues.some(i => i.startsWith('ERROR')));
  const warnings = allResults.filter(r => r.issues.some(i => i.startsWith('WARN')) && !r.issues.some(i => i.startsWith('ERROR')));

  console.log(`Total trains tested: ${allResults.length}`);
  console.log(`  OK:       ${allResults.length - withIssues.length}`);
  console.log(`  Warnings: ${warnings.length}`);
  console.log(`  Errors:   ${errors.length}`);

  if (errors.length > 0) {
    console.log('\n--- ERRORS ---');
    for (const r of errors) {
      console.log(`\n${r.train} (${r.route || 'no route'})`);
      console.log(`  Entries: ${r.entries}, Segments: ${r.segments}, Wagons: ${r.wagons}, Stations: ${r.stations}`);
      for (const issue of r.issues) console.log(`  ${issue}`);
    }
  }

  if (warnings.length > 0) {
    console.log('\n--- WARNINGS ---');
    for (const r of warnings) {
      console.log(`\n${r.train} (${r.route || 'no route'})`);
      console.log(`  Entries: ${r.entries}, Segments: ${r.segments}, Wagons: ${r.wagons}, Stations: ${r.stations}`);
      for (const issue of r.issues) console.log(`  ${issue}`);
    }
  }

  // Summary of segment boundary mismatches
  const boundaryIssues = allResults.filter(r => r.issues.some(i => i.includes('not found in station list')));
  if (boundaryIssues.length > 0) {
    console.log('\n--- SEGMENT BOUNDARY MISMATCHES (detail) ---');
    for (const r of boundaryIssues) {
      const mismatches = r.issues.filter(i => i.includes('not found in station list'));
      console.log(`${r.train}: ${mismatches.map(m => m.replace('WARN: ', '')).join(' | ')}`);
      if (r.stationNames?.length) {
        console.log(`  Station list: ${r.stationNames.join(' → ')}`);
      }
    }
  }

  console.log('\n========================================\n');

  // Exit code
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
