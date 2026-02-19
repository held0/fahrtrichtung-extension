# Fahrtrichtung - Browser Extension

Zeigt die Fahrtrichtung von ICE/IC/EC-Zuegen auf bahn.de an.

## Unterstuetzte Browser

| Browser | Ordner | Hinweis |
|---------|--------|---------|
| Chrome | `chrome/` | Primaere Entwicklung |
| Firefox | `firefox/` | Eigenes Manifest (gecko) |
| Edge | `edge/` | Identisch mit Chrome |
| Opera | `opera/` | Identisch mit Chrome |

## Installation

### Chrome / Edge / Opera
1. Extensions-Seite oeffnen (`chrome://extensions`, `edge://extensions`, `opera://extensions`)
2. "Developer Mode" aktivieren
3. "Load unpacked" → entsprechenden Ordner auswaehlen

### Firefox
1. `about:debugging#/runtime/this-firefox` oeffnen
2. "Load Temporary Add-on" → `firefox/manifest.json` auswaehlen

## Nutzung

1. Auf [bahn.de](https://www.bahn.de) eine Verbindung suchen
2. Ein Angebot auswaehlen und den "Sitzplatz auswaehlen" Dialog oeffnen
3. Extension-Icon in der Toolbar klicken
4. Die Fahrtrichtung wird pro Streckenabschnitt angezeigt (Pfeil links/rechts)

## Datenquellen

- **[fernbahn.de](https://www.fernbahn.de)** - Wagenreihung, Fahrtrichtung, Gueltigkeitszeitraeume
- **[bahn.expert](https://bahn.expert)** - Stationsliste mit Abfahrts-/Ankunftszeiten

## Entwicklung

Siehe [DEVELOPMENT.md](DEVELOPMENT.md) fuer den Entwicklungs-Workflow.

### Tests

`tests.html` im Browser oeffnen - keine Dependencies, kein Build noetig.

### Extension teilen

```bash
cd chrome && zip -r ../fahrtrichtung-chrome.zip . && cd ..
cd firefox && zip -r ../fahrtrichtung-firefox.zip . && cd ..
```
