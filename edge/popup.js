const contentEl = document.getElementById('content');

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url?.includes('bahn.de')) {
      showStatus('Öffne bahn.de um Züge automatisch zu erkennen.');
      return;
    }

    // Use scripting API to extract train info directly - no content script needed
    let trainInfo;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: extractTrainInfoFromPage
      });
      // Merge results from all frames
      trainInfo = { trains: [], fromStation: '', toStation: '', dialogTrain: '', travelDate: '' };
      for (const r of results) {
        const res = r?.result;
        if (!res) continue;

        if (res.trains?.length) {
          trainInfo.trains.push(...res.trains);
        }
        if (res.fromStation && !trainInfo.fromStation) trainInfo.fromStation = res.fromStation;
        if (res.toStation && !trainInfo.toStation) trainInfo.toStation = res.toStation;
        if (res.travelDate && !trainInfo.travelDate) trainInfo.travelDate = res.travelDate;
        if (res.dialogTrain) {
          trainInfo.dialogTrain = res.dialogTrain;
          trainInfo.fromStation = res.fromStation || trainInfo.fromStation;
          trainInfo.toStation = res.toStation || trainInfo.toStation;
        }
      }
      // Deduplicate trains
      const seen = new Set();
      trainInfo.trains = trainInfo.trains.filter(t => {
        if (seen.has(t.full)) return false;
        seen.add(t.full);
        return true;
      });
      // If a seat selection dialog is open, use only that train
      if (trainInfo.dialogTrain) {
        const match = trainInfo.trains.find(t => t.full === trainInfo.dialogTrain);
        if (match) {
          trainInfo.trains = [match];
        }
      }
    } catch (err) {
      showStatus('Seite konnte nicht gelesen werden: ' + err.message);
      return;
    }

    if (!trainInfo.dialogTrain) {
      showStatus('Bitte öffnen Sie zunächst den \u201eSitzplatz auswählen\u201c Dialog damit der gewünschte Zug automatisch erkannt werden kann.');
      return;
    }

    const travelDate = trainInfo.travelDate || new Date().toISOString().slice(0, 10);

    if (trainInfo.trains.length === 1) {
      await fetchAndDisplay(trainInfo.trains[0], trainInfo.fromStation, trainInfo.toStation, travelDate);
    } else {
      // dialogTrain is set but multiple trains found - shouldn't happen, but pick the dialog one
      const match = trainInfo.trains.find(t => t.full === trainInfo.dialogTrain);
      if (match) {
        await fetchAndDisplay(match, trainInfo.fromStation, trainInfo.toStation, travelDate);
      } else {
        showStatus('Zug aus Dialog nicht gefunden.');
      }
    }
  } catch (err) {
    showError(err.message);
  }
}

// This function runs IN the bahn.de page context via chrome.scripting.executeScript.
// It has NO access to external functions - everything must be inline.
function extractTrainInfoFromPage() {
  const trains = [];
  const seen = new Set();
  let fromStation = '';
  let toStation = '';

  // Collect text from page INCLUDING Shadow DOMs (bahn.de uses Web Components like <ri-transport-chip>)
  function collectShadowText(node) {
    let text = '';
    if (node.shadowRoot) {
      text += (node.shadowRoot.textContent || '') + '\n';
      for (const child of node.shadowRoot.querySelectorAll('*')) {
        text += collectShadowText(child);
      }
    }
    if (node.children) {
      for (const child of node.children) {
        text += collectShadowText(child);
      }
    }
    return text;
  }

  const bodyText = document.body.innerText || '';
  const shadowText = collectShadowText(document.body);
  const allText = bodyText + '\n' + shadowText;

  // Regex without trailing \b - shadow DOM may have "ICE 549nach" without space
  const trainPattern = /\b(ICE|IC|EC|RJ|TGV|EST)\s*(\d{1,5})/g;
  let match;

  while ((match = trainPattern.exec(allText)) !== null) {
    const key = `${match[1]} ${match[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      trains.push({ type: match[1], number: match[2], full: key });
    }
  }

  // Detect seat selection dialog: bahn.de loads it in a GSD iframe whose URL contains
  // JSON with zugbezeichnung, abfahrtsbahnhof, ankunftsbahnhof
  let dialogTrain = '';
  let travelDate = '';
  const isGsd = /\/web\/api\/gsd\//.test(location.href);
  if (isGsd) {
    try {
      const url = new URL(location.href);
      const rawData = url.searchParams.get('data');
      if (rawData) {
        const data = JSON.parse(rawData);
        const di = data.displayinformation;
        if (di?.zugbezeichnung) {
          dialogTrain = di.zugbezeichnung;
          fromStation = di.abfahrtsbahnhof || '';
          toStation = di.ankunftsbahnhof || '';
        }
      }
    } catch (e) {
      // GSD URL parsing failed - fall through to other extraction methods
    }
  }

  // Extract travel date from page text
  // bahn.de shows it as "Do. 16. Juli 2026" in the seat reservation header
  if (!travelDate) {
    const months = { 'januar':1, 'februar':2, 'märz':3, 'april':4, 'mai':5, 'juni':6,
      'juli':7, 'august':8, 'september':9, 'oktober':10, 'november':11, 'dezember':12 };
    const longMatch = bodyText.match(/(\d{1,2})\.\s*(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(\d{4})/i);
    if (longMatch) {
      const day = String(longMatch[1]).padStart(2, '0');
      const mon = String(months[longMatch[2].toLowerCase()]).padStart(2, '0');
      travelDate = `${longMatch[3]}-${mon}-${day}`;
    }
  }
  // Fallback: DD.MM.YYYY with weekday prefix
  if (!travelDate) {
    const wdMatch = bodyText.match(/(?:Mo|Di|Mi|Do|Fr|Sa|So)[.,]?\s*(\d{2})\.(\d{2})\.(\d{4})/);
    if (wdMatch) {
      travelDate = `${wdMatch[3]}-${wdMatch[2]}-${wdMatch[1]}`;
    }
  }
  // Fallback: ISO date in GSD iframe URL
  if (!travelDate && isGsd) {
    try {
      const isoMatch = new URL(location.href).searchParams.get('data')?.match(/(\d{4}-\d{2}-\d{2})T/);
      if (isoMatch) travelDate = isoMatch[1];
    } catch (e) { /* ignore */ }
  }

  // Fallback: try loose pattern (no colon required) for route extraction
  if (!fromStation) {
    const routePattern = /(ICE|IC|EC|RJ|TGV|EST)\s+(\d{1,5})\s*[:\.]?\s*(.+?)\s*[-–—]\s*(.+?)(?:\n|$)/;
    const routeMatch = bodyText.match(routePattern);
    if (routeMatch) {
      let rawFrom = routeMatch[3].trim();
      toStation = routeMatch[4].trim();

      const buttonWords = /^(prüfen|angebote|abbrechen|auswählen|details|zurück|weiter|schließen|öffnen|buchen|suchen|filter|sortieren|ändern|bearbeiten|löschen|hinzufügen|entfernen|speichern|aktualisieren)\b/i;
      while (buttonWords.test(rawFrom)) {
        rawFrom = rawFrom.replace(buttonWords, '').trim();
      }
      fromStation = rawFrom;
    }
  }

  // Fallback: extract stations from page header in body text (Köln Hbf – Berlin Hbf)
  if (!fromStation) {
    const headerMatch = bodyText.match(/([A-ZÄÖÜa-zäöüß]{2,}[\w\s\/]*(?:Hbf|Hauptbahnhof|Ostbahnhof|Südkreuz|Hof))\s*[–—]\s*([A-ZÄÖÜa-zäöüß]{2,}[\w\s\/]*(?:Hbf|Hauptbahnhof|Ostbahnhof|Südkreuz|Hof))/);
    if (headerMatch) {
      fromStation = headerMatch[1].trim();
      toStation = headerMatch[2].trim();
    }
  }

  return { trains, fromStation, toStation, dialogTrain, travelDate };
}

function showStatus(message) {
  contentEl.innerHTML = `<div class="status">${escHtml(message)}</div>`;
  const ice = document.getElementById('ice-sketch');
  if (ice) ice.style.display = '';
}

async function fetchAndDisplay(train, fromStation, toStation, travelDate) {
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'fetchFernbahn',
      trainNumber: train.number,
      trainType: train.type,
      fromStation: fromStation || '',
      toStation: toStation || '',
      travelDate: travelDate || new Date().toISOString().slice(0, 10)
    });

    if (result.error) {
      contentEl.innerHTML = `<div class="status error">${escHtml(result.error)}</div>`;
      return;
    }

    renderResult(result, fromStation, toStation);
  } catch (err) {
    contentEl.innerHTML = `<div class="status error">Fehler: ${escHtml(err.message)}</div>`;
  }
}

// Filter segments to only those relevant to the user's journey
function filterRelevantSegments(segments, fromSegIdx, toSegIdx) {
  if (fromSegIdx >= 0 && toSegIdx >= 0) {
    const lo = Math.min(fromSegIdx, toSegIdx);
    const hi = Math.max(fromSegIdx, toSegIdx);
    return { segments: segments.slice(lo, hi + 1), startIdx: lo };
  }
  return { segments, startIdx: 0 };
}

// Compute display direction for bahn.de: bahn.de always shows wagons ascending left->right.
// If the front wagon has a high number -> arrow RIGHT, low number -> arrow LEFT.
function getDisplayDirection(seg, wagonNumbers) {
  if (!wagonNumbers?.length || wagonNumbers.length < 2) return seg.direction;
  const frontWagon = seg.firstWagonIsFront ? wagonNumbers[0] : wagonNumbers[wagonNumbers.length - 1];
  const nums = wagonNumbers.map(Number).filter(n => !isNaN(n));
  if (!nums.length) return seg.direction;
  const frontNum = Number(frontWagon);
  return (frontNum > (Math.min(...nums) + Math.max(...nums)) / 2) ? 'right' : 'left';
}

function formatDuration(duration) {
  if (!duration) return '';
  if (duration.hours > 0) {
    return `${duration.hours}h${String(duration.minutes).padStart(2, '0')}min`;
  }
  return `${duration.minutes}min`;
}

function renderResult(data, userFrom, userTo) {
  const html = [];

  // Extract station names from stationOrder (which now contains full objects with times)
  const stationNames = data.stationOrder?.map(s => typeof s === 'string' ? s : s.name) || [];

  // Clean station names using bahn.expert station list if available
  if (stationNames.length) {
    userFrom = cleanStationName(userFrom, stationNames);
    userTo = cleanStationName(userTo, stationNames);
  }

  // Show user's searched route if available, otherwise full train route
  const displayRoute = (userFrom && userTo) ? `${userFrom} \u2013 ${userTo}` : data.route;

  html.push(`
    <div class="train-header">
      <span class="train-name">${escHtml(data.trainFull)}</span>
      <span class="train-route">${escHtml(displayRoute)}</span>
    </div>
  `);

  // Filter segments to only show those relevant to the user's journey
  let relevantSegments = data.segments;
  let relevantStartIdx = 0;
  if (userFrom && userTo && data.segments.length > 1) {
    const result = filterRelevantSegments(data.segments, data.fromSegmentIdx ?? -1, data.toSegmentIdx ?? -1);
    relevantSegments = result.segments;
    relevantStartIdx = result.startIdx;
  }

  // Build segment display data, applying boundary adjustments and skipping empty segments
  const displaySegments = [];
  for (let si = 0; si < relevantSegments.length; si++) {
    const seg = relevantSegments[si];
    const isFirst = si === 0;
    const isLast = si === relevantSegments.length - 1;

    let segFrom = seg.from;
    let segTo = seg.to;

    if (isFirst && userFrom && seg.from && !stationMatch(normalizeStation(seg.from), normalizeStation(userFrom))) {
      segFrom = userFrom;
    }

    if (isLast && userTo && seg.to && !stationMatch(normalizeStation(seg.to), normalizeStation(userTo))) {
      segTo = userTo;
    }

    if (segFrom && segTo && stationMatch(normalizeStation(segFrom), normalizeStation(segTo))) {
      continue;
    }

    displaySegments.push({ seg, segFrom, segTo });
  }

  if (displaySegments.length > 1) {
    html.push(`<div class="validity">Die Fahrtrichtung \u00e4ndert sich w\u00e4hrend der Fahrt wie folgt:</div>`);
  } else if (displaySegments.length === 1 && !data.validityExact) {
    let hint = 'Keine Wagenreihung f\u00fcr dieses Datum verf\u00fcgbar.';
    if (data.latestValidityTo) {
      const d = new Date(data.latestValidityTo);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yy = String(d.getFullYear()).slice(2);
      hint += ` Letzte verf\u00fcgbare Daten liegen vor ${dd}.${mm}.${yy}`;
    }
    html.push(`<div class="validity">${escHtml(hint)}</div>`);
  }

  for (const { seg, segFrom, segTo } of displaySegments) {
    const displayDir = getDisplayDirection(seg, data.wagonNumbers);
    const dirClass = displayDir === 'left' ? 'direction-left' : displayDir === 'right' ? 'direction-right' : '';
    const arrow = displayDir === 'left' ? '\u2190' : displayDir === 'right' ? '\u2192' : '?';

    let frontWagon = '';
    if (data.wagonNumbers?.length) {
      frontWagon = seg.firstWagonIsFront ? data.wagonNumbers[0] : data.wagonNumbers[data.wagonNumbers.length - 1];
    }

    const segText = segTo ? `${segFrom} \u2013 ${segTo}` : segFrom;
    const durationStr = formatDuration(computeSegmentDuration(segFrom, segTo, data.stationOrder));

    html.push(`
      <div class="segment ${dirClass}">
        <div class="segment-badge"><span class="arrow-animated">${arrow}</span></div>
        <div class="segment-route">
          ${escHtml(segText)}
          ${durationStr ? `<span class="segment-duration">${escHtml(durationStr)}</span>` : ''}
        </div>
        <div class="segment-info">
          ${frontWagon ? `<span class="front-wagon">Wagen ${escHtml(frontWagon)} f\u00e4hrt vorne</span>` : ''}
        </div>
      </div>
    `);
  }

  contentEl.innerHTML = html.join('');

  // Show disclaimer and ICE image when results are displayed
  const disc = document.getElementById('disclaimer');
  const ice = document.getElementById('ice-sketch');
  if (disc) disc.style.display = '';
  if (ice) ice.style.display = '';

  // Track usage and show donate banner at milestones
  showDonateIfMilestone();
}

function showError(msg) {
  contentEl.innerHTML = `<div class="status error">${escHtml(msg)}</div>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function showDonateIfMilestone() {
  const data = await chrome.storage.local.get({ openCount: 0 });
  const count = data.openCount + 1;
  await chrome.storage.local.set({ openCount: count });

  // Show banner every 25 uses
  if (count < 25 || count % 25 !== 0) return;

  const banner = document.getElementById('donate-banner');
  const text = document.getElementById('milestone-text');
  if (!banner || !text) return;

  text.textContent = `\uD83C\uDF89 Du hast Fahrtrichtung schon ${count}\u00d7 benutzt!`;
  banner.style.display = '';
  startConfetti();
}

function startConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const colors = ['#ec0016', '#ffc439', '#333', '#0070ba', '#4caf50', '#ff9800'];
  const pieces = [];
  for (let i = 0; i < 60; i++) {
    pieces.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      w: 4 + Math.random() * 4,
      h: 6 + Math.random() * 6,
      color: colors[Math.floor(Math.random() * colors.length)],
      vy: 1 + Math.random() * 2,
      vx: (Math.random() - 0.5) * 2,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.15
    });
  }

  let frame = 0;
  const maxFrames = 120;

  function draw() {
    if (frame > maxFrames) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Fade out in last 30 frames
    const alpha = frame > maxFrames - 30 ? (maxFrames - frame) / 30 : 1;
    ctx.globalAlpha = alpha;

    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    frame++;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

init();
