// Begleit-App der Safari-Erweiterung: Anleitung, Status, Button zu den Safari-Einstellungen.
// Sprache passend zum System: Deutsch, sonst britisches Englisch.
const EN = {
    title: 'Fahrtrichtung for Safari',
    on: 'The extension is switched on.',
    off: 'The extension is still switched off.',
    mac1: 'Click <b>“Open Safari Settings”</b> below and tick <b>Fahrtrichtung</b>.',
    mac2: 'Then, under <b>“Edit Websites…”</b>, set <b>bahn.de</b> and <b>fernbahn.de</b> to <b>“Allow”</b>. Otherwise Safari asks with a very general warning the first time you click – Fahrtrichtung only reads bahn.de.',
    mac3: 'On bahn.de, go to <b>“Sitzplatz auswählen”</b> (choose seat) and click the Fahrtrichtung icon in the Safari toolbar.',
    ios1: 'Tap <b>“Open Settings”</b>, switch on <b>“Allow Extension”</b> and, under <b>Permissions</b>, set <b>bahn.de</b> and <b>fernbahn.de</b> to <b>“Allow”</b>. Otherwise Safari asks with a very general warning the first time – Fahrtrichtung only reads bahn.de.',
    iosPath: 'If the button doesn’t take you there directly: Settings → Apps → Safari → Extensions → Fahrtrichtung.',
    ios3: 'In Safari, go to <b>“Sitzplatz auswählen”</b> on bahn.de, tap the <b>page icon</b> on the left of the address bar, <b>scroll down</b> the menu and choose <b>Fahrtrichtung</b>.',
    readyHead: 'One click is all it takes',
    ready: 'As soon as you choose a seat on bahn.de, click the Fahrtrichtung icon at the top of Safari – and the direction of travel is shown.',
    readyClose: 'You can close this window now.',
    button: 'Open Safari Settings',
    blockTitle: 'Please quit first:',
    blockText: 'While this app is running, Safari won’t let you switch on extensions. You can reopen it afterwards.',
    hint: 'Does Safari say clicks were prevented? Then briefly quit apps that sit on top of other windows or control your Mac – e.g. dictation, window or remote-access apps.',
    demoTitle: 'Extensions',
    demoEdit: 'Edit Websites…',
    demoAllow: 'Allow',
    demoAsk: 'Ask',
    iosBack: 'Safari',
    iosAllow: 'Allow Extension',
    iosPerms: 'Permissions',
    iosBtnSettings: 'Open Settings',
    iosBtnBahn: 'Open bahn.de in Safari',
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
}

document.querySelector('button.open-preferences').addEventListener('click', () => {
    webkit.messageHandlers.controller.postMessage('open-preferences');
});

// Inhaltshoehe an die App melden (Fenster passt sich an), auch nach Statuswechseln
function reportHeight() {
    const h = document.querySelector('main').getBoundingClientRect().height + 40;
    try { webkit.messageHandlers.controller.postMessage('height:' + Math.round(h)); } catch (e) {}
}
new ResizeObserver(reportHeight).observe(document.querySelector('main'));
window.addEventListener('load', reportHeight);

// iPhone: Buttons zu den Einstellungen bzw. zu bahn.de
document.querySelectorAll('.ios-btn').forEach(b => b.addEventListener('click', () => {
    try { webkit.messageHandlers.controller.postMessage(b.dataset.msg); } catch (e) {}
}));
