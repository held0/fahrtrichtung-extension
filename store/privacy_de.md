# Datenschutzerklärung – Fahrtrichtung Extension

Zuletzt aktualisiert: 21. Oktober 2026

## Welche Daten werden erhoben?

Die Extension erhebt **keine personenbezogenen Daten**. Es werden keine Konten erstellt und keine Cookies gesetzt.

## Welche Daten werden an Dritte übermittelt?

Um die Fahrtrichtung zu ermitteln, sendet die Extension folgende Anfragen:

1. **fernbahn.de** – Zugtyp und Zugnummer werden übermittelt, um die Wagenreihung abzurufen.
2. **bahn.de** – Zugtyp, Zugnummer, Reisedatum sowie Abfahrtsbahnhof und -zeit des gewählten Zuges werden an die Fahrplan-Schnittstelle der Bahn-Website übermittelt, um die Stationsliste und Zeiten abzurufen.
3. **fahrtrichtung.info** – nur wenn fernbahn.de nicht erreichbar ist: Zugtyp, Zugnummer, Reisedatum und die Version der Extension, um die Wagenreihung für diesen Zug abzurufen. Zug und Datum werden dort nicht gespeichert; wie bei jedem Website-Aufruf wird die IP-Adresse kurzzeitig im Server-Logfile vermerkt.

Diese Anfragen enthalten keine personenbezogenen Daten (keine Namen, E-Mail-Adressen oder Standortdaten).

## Welche Daten werden lokal gespeichert?

Die Extension speichert in `chrome.storage.local`:

- einen Nutzungszähler (Anzahl der Aufrufe), um gelegentlich einen Spendenhinweis anzuzeigen;
- die zuletzt abgerufenen Wagenreihungen (höchstens 30 Züge, längstens 60 Tage), damit die Fahrtrichtung auch angezeigt werden kann, wenn fernbahn.de kurz nicht erreichbar ist.

Diese Daten verlassen den Browser nicht. Personenbezogene Daten werden nicht gespeichert.

## Umfrage beim Deinstallieren

Wenn Sie die Extension entfernen, öffnet Ihr Browser die Seite fahrtrichtung.info/tschuess mit einer freiwilligen Ein-Klick-Umfrage. Die Extension selbst sendet dabei keinerlei Daten, es wird nur diese Seite geöffnet. Details: https://fahrtrichtung.info/datenschutz

## Zugriff auf Webseiten

Die Extension liest Informationen aus der geöffneten bahn.de-Seite (Zugbezeichnung, Stationen, Reisedatum), um den richtigen Zug zu identifizieren. Diese Daten werden nur lokal verarbeitet und nicht gespeichert oder weitergeleitet.

## Kontakt

Bei Fragen zur Datenschutzerklärung: https://github.com/held0/fahrtrichtung-extension/issues
