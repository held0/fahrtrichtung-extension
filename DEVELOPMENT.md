# Entwicklungs-Workflow

## Primaere Entwicklung: Chrome

Alle Aenderungen werden zuerst in `chrome/` entwickelt und getestet.

## Browser synchronisieren

Nach Aenderungen an `chrome/`:

```bash
./sync-browsers.sh
```

Das Script:
- Kopiert `chrome/` 1:1 nach `edge/` und `opera/`
- Kopiert alle Dateien ausser `manifest.json` und `background.js` nach `firefox/`
- Erstellt `firefox/background.js` aus `chrome/background.js` (entfernt `importScripts`)
- `firefox/manifest.json` wird NICHT ueberschrieben (manuell pflegen)
- Erstellt ZIP-Dateien fuer alle 4 Browser: `fahrtrichtung-chrome.zip`, `fahrtrichtung-firefox.zip`, `fahrtrichtung-edge.zip`, `fahrtrichtung-opera.zip`

## Browser-Unterschiede

| | Chrome | Firefox | Edge | Opera |
|---|---|---|---|---|
| Manifest | `service_worker` | `scripts` (background) | = Chrome | = Chrome |
| Background | `importScripts('utils.js')` | via manifest `scripts` Array | = Chrome | = Chrome |
| Gecko-Settings | - | `browser_specific_settings.gecko` | - | - |
| Sonstiges | - | - | Identisch mit Chrome | Identisch mit Chrome |

## Installation pro Browser

### Chrome
1. `chrome://extensions` oeffnen
2. Developer Mode aktivieren
3. "Load unpacked" → `chrome/` Ordner auswaehlen

### Firefox
1. `about:debugging#/runtime/this-firefox` oeffnen
2. "Load Temporary Add-on" → `firefox/manifest.json` auswaehlen

### Edge
1. `edge://extensions` oeffnen
2. Developer Mode aktivieren
3. "Load unpacked" → `edge/` Ordner auswaehlen

### Opera
1. `opera://extensions` oeffnen
2. Developer Mode aktivieren
3. "Load unpacked" → `opera/` Ordner auswaehlen

## Tests

`tests.html` im Browser oeffnen (referenziert `chrome/utils.js`). Kein Build noetig.

## Sync-Checkliste

Bei Aenderungen an `chrome/`:
- [ ] `./sync-browsers.sh` ausfuehren
- [ ] Falls `manifest.json` geaendert: `firefox/manifest.json` manuell anpassen
- [ ] Tests in `tests.html` pruefen
