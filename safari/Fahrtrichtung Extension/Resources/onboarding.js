// Onboarding-Seite: öffnet sich einmalig nach der Installation.
// Eine einzige Ansicht mit der Demo-Animation von fahrtrichtung.info
// (reines CSS, läuft in Endlosschleife) — kein Durchklicken nötig.
// Läuft auch außerhalb der Extension (lokale Vorschau) — dann greift
// der Sprach-Fallback statt chrome.i18n.

(function () {
  'use strict';

  var FALLBACK = {
    de: null, // deutsche Texte stehen bereits im HTML
    en: {
      obTitle: 'Train Direction',
      obHeading: 'One click is all it takes',
      obSub: 'As soon as you select a seat on bahn.de, simply click the ICE icon at the top of your browser — and the direction of travel is shown immediately.',
      obPinTip: 'Tip: click the puzzle icon 🧩 next to the address bar and pin Train Direction so the icon is always visible.',
      obPrivacy: 'Free · Open source · No tracking'
    }
  };

  var hasChromeI18n = typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getMessage;
  var lang = (navigator.language || 'de').slice(0, 2);
  var dict = FALLBACK[lang === 'de' ? 'de' : 'en'];

  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    var key = el.getAttribute('data-i18n');
    var text = hasChromeI18n ? chrome.i18n.getMessage(key) : (dict ? dict[key] : null);
    if (text) el.textContent = text;
  });
  if (hasChromeI18n) {
    document.title = chrome.i18n.getMessage('obTitle') || document.title;
  } else if (dict && dict.obTitle) {
    document.title = dict.obTitle;
  }
})();
