// Begleit-App der Safari-Erweiterung: Anleitung, Status, Button zu den Safari-Einstellungen.
// Sprache passend zum System: Deutsch, sonst britisches Englisch.
const EN = {
    title: 'Fahrtrichtung for Safari',
    on: 'The extension is switched on.',
    off: 'The extension is still switched off.',
    mac1: 'Click <b>“Open Safari Settings”</b> below and tick <b>Fahrtrichtung</b>.',
    mac2: 'Then allow bahn.de and fernbahn.de under <b>“Edit Websites…”</b> – or when you first click the icon.',
    mac3: 'On bahn.de, go to <b>“Sitzplatz auswählen”</b> (choose seat) and click the Fahrtrichtung icon in the Safari toolbar.',
    ios1: 'Open the <b>Settings</b> app: <b>Apps → Safari → Extensions → Fahrtrichtung</b>.',
    ios2: 'Switch on <b>Allow Extension</b> and set bahn.de and fernbahn.de to <b>“Allow”</b>.',
    ios3: 'In Safari, go to <b>“Sitzplatz auswählen”</b> on bahn.de, then tap <b>Fahrtrichtung</b> via the extensions icon in the address bar.',
    button: 'Open Safari Settings',
    demoTitle: 'Extensions',
    demoEdit: 'Edit Websites…',
    demoAllow: 'Allow',
    note: 'This app only contains the Safari extension. No data is collected.',
};

if (!/^de/i.test(navigator.language || '')) {
    document.documentElement.lang = 'en-GB';
    document.querySelectorAll('[data-t]').forEach(el => { if (EN[el.dataset.t]) el.innerHTML = EN[el.dataset.t]; });
}

function show(platform, enabled) {
    document.body.classList.add(`platform-${platform}`);
    document.body.classList.toggle('state-on', enabled === true);
    document.body.classList.toggle('state-off', enabled === false);
}

document.querySelector('button.open-preferences').addEventListener('click', () => {
    webkit.messageHandlers.controller.postMessage('open-preferences');
});
