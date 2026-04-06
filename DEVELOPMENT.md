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

## Headless Tests

```bash
npm run test:headless
```

Fuehrt `tests.html` in Puppeteer (Headless Chromium) aus. Exit Code 0 bei Erfolg, 1 bei Fehlern.

## Neue Version veroeffentlichen

### Voraussetzungen (einmalig)

GitHub Secrets muessen konfiguriert sein (Settings > Secrets and variables > Actions):

**Chrome Web Store:**
- `CHROME_EXTENSION_ID` — Extension-ID aus dem Chrome Web Store Developer Dashboard
- `CHROME_CLIENT_ID` — OAuth2 Client ID (Google Cloud Console > APIs & Services > Credentials)
- `CHROME_CLIENT_SECRET` — OAuth2 Client Secret
- `CHROME_REFRESH_TOKEN` — Einmalig generierter Refresh Token (`npx chrome-webstore-upload-cli init`)

**Firefox AMO:**
- `FIREFOX_JWT_ISSUER` — API Key (addons.mozilla.org > Tools > Manage API Keys)
- `FIREFOX_JWT_SECRET` — API Secret

**Edge Add-ons:**
- `EDGE_PRODUCT_ID` — Product ID (Edge Partner Center)
- `EDGE_CLIENT_ID` — Azure AD App Client ID (Azure Portal > App Registrations)
- `EDGE_CLIENT_SECRET` — Azure AD App Client Secret
- `EDGE_ACCESS_TOKEN_URL` — Azure AD Token Endpoint (`https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token`)

### Release-Ablauf

1. Aenderungen in `chrome/` fertigstellen und testen
2. Version in `chrome/manifest.json` hochsetzen (z.B. `"1.0"` → `"1.1"`)
3. Committen und pushen:
   ```bash
   git add -A
   git commit -m "Release v1.1"
   git push origin main
   ```
4. Tag erstellen und pushen (das loest die GitHub Action aus):
   ```bash
   git tag v1.1
   git push origin v1.1
   ```
5. GitHub Action laeuft automatisch:
   - Prueft: Tag-Version == Manifest-Version (bei Mismatch: Abbruch)
   - Fuehrt headless Tests aus (bei Fehlern: Abbruch)
   - Baut ZIPs fuer alle 4 Browser
   - Laedt zu Chrome Web Store, Firefox AMO, Edge Add-ons hoch
   - Erstellt GitHub Release mit allen 4 ZIPs
6. In den Store-Dashboards pruefen und ggf. freigeben

### Lokale Tests vor Release

```bash
npm run test:headless    # Headless Unit Tests
./sync-browsers.sh       # Browser-ZIPs bauen
```
