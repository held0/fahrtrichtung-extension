// Onboarding-Präsentation: läuft nach der Installation automatisch ab.
// Auto-Advance durch die Szenen, Klick auf einen Punkt springt direkt,
// Hover pausiert. Läuft auch außerhalb der Extension (lokale Vorschau) —
// dann greift der Sprach-Fallback statt chrome.i18n.

(function () {
  'use strict';

  // ---- i18n (chrome.i18n in der Extension, Fallback für lokale Vorschau) ----
  var FALLBACK = {
    de: null, // deutsche Texte stehen bereits im HTML
    en: {
      obTitle: 'Train Direction',
      obSkip: 'Skip',
      obWelcomeHeading: 'Welcome to Train Direction!',
      obWelcomeSub: 'Never ride backwards again: this extension shows you the direction of travel of your ICE, IC or EC during seat selection on bahn.de.',
      obHowHeading: 'How it works',
      obStep1: 'Search for a connection with ICE, IC or EC on bahn.de as usual.',
      obStep2: 'Open "Select seat" for your connection — the coach layout appears there.',
      obStep3: 'Click the Train Direction icon in the toolbar.',
      obResultHeading: 'This is what you’ll see',
      obMockInfo: 'The arrow shows the direction of travel in the coach layout',
      obReadyHeading: 'Have a good trip! 🚄',
      obReadySub: 'You’re all set for your next ticket purchase — the extension stays quiet on its own and collects no data.',
      obCta: 'Search a connection now',
      obPinTip: 'Tip: click the puzzle icon 🧩 next to the address bar and pin Train Direction so the icon is always visible.',
      obPrivacy: 'Free · Open source · No tracking'
    }
  };

  function translate() {
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
  }

  // ---- Szenen-Steuerung ----
  var SCENE_DURATIONS = [5000, 5500, 6500, 0]; // 0 = letzte Szene bleibt stehen
  var scenes = Array.prototype.slice.call(document.querySelectorAll('.scene'));
  var controls = document.getElementById('controls');
  var stage = document.getElementById('stage');
  var current = 0;
  var timer = null;
  var paused = false;

  var dots = scenes.map(function (_, i) {
    var dot = document.createElement('button');
    dot.className = 'dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('aria-label', 'Szene ' + (i + 1));
    dot.addEventListener('click', function () { show(i); });
    controls.appendChild(dot);
    return dot;
  });

  function show(idx) {
    if (idx === current || idx < 0 || idx >= scenes.length) return;
    var prev = scenes[current];
    prev.classList.remove('active');
    prev.classList.add('leaving');
    setTimeout(function () { prev.classList.remove('leaving'); }, 500);

    scenes[idx].classList.add('active');
    dots[current].classList.remove('active');
    dots[idx].classList.add('active');
    current = idx;
    schedule();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    var dur = SCENE_DURATIONS[current];
    if (!dur || paused) return;
    timer = setTimeout(function () { show(current + 1); }, dur);
  }

  stage.addEventListener('mouseenter', function () { paused = true; if (timer) clearTimeout(timer); });
  stage.addEventListener('mouseleave', function () { paused = false; schedule(); });

  document.getElementById('skip').addEventListener('click', function () {
    show(scenes.length - 1);
  });

  translate();
  schedule();
})();
