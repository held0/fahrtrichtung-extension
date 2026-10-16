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
    blockTitle: 'Please quit first:',
    blockText: 'While this app is running, Safari won’t let you switch on extensions. You can reopen it afterwards.',
    recheck: 'Done – check again',
    checking: 'Checking…',
    wait: 'Still running… Quitting can take a few seconds.',
    hint: 'Does Safari say it “detected apps or services that prevented clicks”? Then briefly quit apps that sit on top of other windows or control your Mac (e.g. dictation, window or remote-access apps).',
    demoTitle: 'Extensions',
    demoEdit: 'Edit Websites…',
    demoAllow: 'Allow',
    note: 'This app only contains the Safari extension. No data is collected.',
};

if (!/^de/i.test(navigator.language || '')) {
    document.documentElement.lang = 'en-GB';
    document.querySelectorAll('[data-t]').forEach(el => { if (EN[el.dataset.t]) el.innerHTML = EN[el.dataset.t]; });
}

function show(platform, enabled, blockers) {
    document.body.classList.add(`platform-${platform}`);
    document.body.classList.toggle('state-on', enabled === true);
    document.body.classList.toggle('state-off', enabled === false);
    const box = document.querySelector('.blockers');
    const names = Array.isArray(blockers) ? blockers : [];
    box.hidden = names.length === 0;
    box.querySelector('.names').textContent = names.join(', ');
    if (names.length === 0) stopRecheck();
}

// "Ist beendet – erneut prüfen": bis zu 10 s lang nachsehen (Electron-Apps wie
// Wispr Flow brauchen ein paar Sekunden, bis sie wirklich beendet sind)
const DE = { recheck: 'Ist beendet – erneut prüfen', checking: 'Prüfe …' };
const T = k => (document.documentElement.lang === 'en-GB' ? EN : DE)[k];
let recheckTimer = null;
function stopRecheck() {
    clearInterval(recheckTimer); recheckTimer = null;
    const btn = document.querySelector('.recheck');
    btn.disabled = false; btn.textContent = T('recheck');
}
document.querySelector('.recheck').addEventListener('click', () => {
    const btn = document.querySelector('.recheck'), wait = document.querySelector('.wait');
    btn.disabled = true; btn.textContent = T('checking'); wait.hidden = true;
    let tries = 0;
    clearInterval(recheckTimer);
    recheckTimer = setInterval(() => {
        webkit.messageHandlers.controller.postMessage('refresh');
        if (++tries >= 14) { stopRecheck(); wait.hidden = false; }
    }, 700);
    webkit.messageHandlers.controller.postMessage('refresh');
});

document.querySelector('button.open-preferences').addEventListener('click', () => {
    webkit.messageHandlers.controller.postMessage('open-preferences');
});
