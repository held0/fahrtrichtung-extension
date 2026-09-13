// Content script auf bahn.de: erkennt eine abgeschlossene Buchung (Bestätigungs-
// seite) und meldet sie an den Service Worker, der sie mit den Zügen abgleicht,
// die kurz zuvor im Popup nachgeschlagen wurden.
//
// Datenschutz: Es wird NICHTS gesendet — die Meldung geht nur an die eigene
// Extension, gespeichert wird ausschließlich in chrome.storage.local auf diesem
// Gerät. Es werden nur Zugname, Reisedatum und (falls vorhanden) die
// Auftragsnummer als Duplikat-Schutz gemerkt, keine Namen, keine Preise.
//
// Die reinen Erkennungsfunktionen (detectBookingConfirmation, extractDates)
// sind ohne DOM nutzbar und werden in test-booking-unit.mjs getestet.

const FR_TRAIN_PATTERN = /\b(ICE|ECE|IC|EC|RJX|RJ|TGV|EST|NJ|EN)\s*(\d{1,5})\b/g;
const FR_MONTHS = { januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8,
  september: 9, oktober: 10, november: 11, dezember: 12,
  jan: 1, feb: 2, mär: 3, mrz: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, dez: 12 };

// Reisedaten aus Seitentext: "12.09.2026", "Sa. 12. Sep. 2026", "12. September 2026"
function extractDates(text) {
  const out = [];
  const seen = new Set();
  const push = (y, m, d) => {
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return;
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!seen.has(iso)) { seen.add(iso); out.push(iso); }
  };
  let m;
  const numeric = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g;
  while ((m = numeric.exec(text)) !== null) push(Number(m[3]), Number(m[2]), Number(m[1]));
  const named = /\b(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]{3,9})\.?\s+(\d{4})\b/g;
  while ((m = named.exec(text)) !== null) {
    const mon = FR_MONTHS[m[2].toLowerCase()];
    if (mon) push(Number(m[3]), mon, Number(m[1]));
  }
  return out;
}

function extractTrains(text) {
  const trains = [];
  const seen = new Set();
  let m;
  FR_TRAIN_PATTERN.lastIndex = 0;
  while ((m = FR_TRAIN_PATTERN.exec(text)) !== null) {
    const key = `${m[1]} ${m[2]}`;
    if (!seen.has(key)) { seen.add(key); trains.push(key); }
  }
  return trains;
}

// Ist das eine Buchungsbestätigung? Konservativ: es braucht eine Auftrags-/
// Buchungsnummer UND eine Erfolgsformulierung, sonst nichts melden.
function detectBookingConfirmation(text, url) {
  const t = (text || '').replace(/\s+/g, ' ');
  const orderMatch = t.match(/(?:Auftragsnummer|Auftrags-Nr\.?|Buchungsnummer|Bestellnummer|Order number|Booking number)\s*:?\s*([A-Z0-9]{6,12})\b/i);
  const success = /(Buchung|Bestellung|Reservierung|Booking|Order)[^.]{0,80}?(erfolgreich|abgeschlossen|bestätigt|successful|completed|confirmed)|Vielen Dank für (Ihre|deine) (Buchung|Bestellung)|Thank you for your (booking|order)/i.test(t);
  const urlHint = /bestaetigung|confirmation|erfolg|success|abschluss/i.test(url || '');
  const isConfirmation = Boolean(orderMatch) && (success || urlHint);
  return {
    isConfirmation,
    orderNumber: orderMatch ? orderMatch[1].toUpperCase() : null,
    trains: isConfirmation ? extractTrains(t) : [],
    travelDates: isConfirmation ? extractDates(t) : [],
  };
}

// ---- Laufzeit (nur im Browser) ---------------------------------------------
if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
  (() => {
    let timer = null;
    let reported = null;
    try { reported = sessionStorage.getItem('fahrtrichtung-booking-reported'); } catch (e) { /* ignore */ }

    function collectShadowText(node, depth) {
      if (!node || depth > 25) return '';
      let text = '';
      if (node.shadowRoot) {
        text += (node.shadowRoot.textContent || '') + '\n';
        for (const child of node.shadowRoot.querySelectorAll('*')) text += collectShadowText(child, depth + 1);
      }
      if (node.children) {
        for (const child of node.children) text += collectShadowText(child, depth + 1);
      }
      return text;
    }

    function check() {
      timer = null;
      let text = '';
      try { text = (document.body?.innerText || '') + '\n' + collectShadowText(document.body, 0); } catch (e) { return; }
      const result = detectBookingConfirmation(text, location.href);
      if (!result.isConfirmation) return;
      const key = result.orderNumber || `${result.trains.join(',')}|${result.travelDates.join(',')}`;
      if (key === reported) return;
      reported = key;
      try { sessionStorage.setItem('fahrtrichtung-booking-reported', key); } catch (e) { /* ignore */ }
      try {
        chrome.runtime.sendMessage({ type: 'bookingDetected', orderNumber: result.orderNumber, trains: result.trains,
          travelDates: result.travelDates, url: location.href, detectedAt: Date.now() }, () => void chrome.runtime.lastError);
      } catch (e) { /* Extension wurde neu geladen — ignorieren */ }
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(check, 1500);
    }

    schedule();
    try {
      new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* ignore */ }
  })();
}
