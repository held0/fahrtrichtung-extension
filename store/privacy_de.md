# Datenschutzerklärung – Fahrtrichtung Extension

Zuletzt aktualisiert: 19. Februar 2026

## Welche Daten werden erhoben?

Die Extension erhebt **keine personenbezogenen Daten**. Es werden keine Konten erstellt, keine Cookies gesetzt und keine Daten an eigene Server gesendet.

## Welche Daten werden an Dritte übermittelt?

Um die Fahrtrichtung zu ermitteln, sendet die Extension folgende Anfragen:

1. **fernbahn.de** – Zugtyp und Zugnummer werden übermittelt, um die Wagenreihung abzurufen.
2. **bahn.de** – Zugtyp, Zugnummer, Reisedatum sowie Abfahrtsbahnhof und -zeit des gewählten Zuges werden an die Fahrplan-Schnittstelle der Bahn-Website übermittelt, um die Stationsliste und Zeiten abzurufen.

Diese Anfragen enthalten keine personenbezogenen Daten (keine Namen, E-Mail-Adressen oder Standortdaten).

## Welche Daten werden lokal gespeichert?

Die Extension speichert ausschließlich einen Nutzungszähler (Anzahl der Aufrufe) in `chrome.storage.local`. Dieser Zähler dient dazu, gelegentlich einen Spendenhinweis anzuzeigen. Es werden keine Reisedaten, Zuginformationen oder personenbezogenen Daten gespeichert.

## Zugriff auf Webseiten

Die Extension liest Informationen aus der geöffneten bahn.de-Seite (Zugbezeichnung, Stationen, Reisedatum), um den richtigen Zug zu identifizieren. Diese Daten werden nur lokal verarbeitet und nicht gespeichert oder weitergeleitet.

## Kontakt

Bei Fragen zur Datenschutzerklärung: https://github.com/held0/fahrtrichtung-extension/issues

Optional (nur nach ausdrücklicher Zustimmung in der Erweiterung): Übermittlung der anonymen Erfolgsrate (Anzahl richtig/falsch, Extension-Version) an fahrtrichtung.info – ohne Zug, Datum, Name, Kennung oder Cookie. Alle anderen Daten des Erfolgszählers bleiben lokal auf dem Gerät.
