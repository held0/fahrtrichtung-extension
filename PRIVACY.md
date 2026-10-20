# Datenschutzerklärung / Privacy Policy

## Deutsch

### Datenerhebung

Fahrtrichtung erhebt, speichert und übermittelt **keine personenbezogenen Daten**.

### Drittanbieter-Dienste

Um die Fahrtrichtung anzuzeigen, sendet die Extension Anfragen an:

- **fernbahn.de** – Abruf der Wagenreihung (übermittelt: Zugtyp und Zugnummer)
- **bahn.de** – Abruf der Stationsliste und Zeiten über die Fahrplan-Schnittstelle der Bahn-Website (übermittelt: Zugtyp, Zugnummer, Reisedatum, Abfahrtsbahnhof und -zeit des gewählten Zuges)
- **fahrtrichtung.info** – nur wenn fernbahn.de nicht erreichbar ist: Abruf der Wagenreihung für den gewählten Zug (übermittelt: Zugtyp, Zugnummer, Reisedatum, Version der Extension). Zug und Datum werden dort nicht gespeichert; wie bei jedem Website-Aufruf wird die IP-Adresse kurzzeitig im Server-Logfile vermerkt (Details: https://fahrtrichtung.info/datenschutz).

Diese Anfragen enthalten keine personenbezogenen Daten. Wie bei jeder HTTP-Anfrage wird Ihre IP-Adresse im Rahmen des Internetprotokolls an diese Dienste übertragen.

### Lokale Speicherung

Die Extension speichert lokal im Browser einen Nutzungszähler (Anzahl der Aufrufe) und die zuletzt abgerufenen Wagenreihungen (höchstens 30 Züge, längstens 60 Tage), damit die Fahrtrichtung auch angezeigt werden kann, wenn fernbahn.de kurz nicht erreichbar ist. Diese Daten verlassen den Browser nicht. Personenbezogene Daten werden nicht gespeichert.

### Umfrage beim Deinstallieren

Wenn Sie die Extension entfernen, öffnet Ihr Browser die Seite fahrtrichtung.info/tschuess mit einer freiwilligen Ein-Klick-Umfrage. Die Extension selbst sendet dabei keinerlei Daten, es wird nur diese Seite geöffnet. Details: https://fahrtrichtung.info/datenschutz

### Zugriff auf bahn.de

Die Extension liest Informationen aus der geöffneten bahn.de-Seite (Zugbezeichnung, Stationen, Reisedatum), um den richtigen Zug zu identifizieren. Diese Daten werden nur lokal verarbeitet und weder gespeichert noch weitergeleitet.

---

## English

### Data Collection

Fahrtrichtung does **not collect, store, or transmit any personal data**.

### Third-Party Services

To display travel direction information, the extension makes requests to:

- **fernbahn.de** – retrieves wagon order data (sends: train type and number)
- **bahn.de** – retrieves the station list and times via the timetable API of the bahn.de website itself (sends: train type, number, travel date, departure station and time of the selected train)
- **fahrtrichtung.info** – only if fernbahn.de is unavailable: retrieves the coach sequence for the selected train (sends: train type, number, travel date, extension version). Train and date are not stored there; as with any website visit, the IP address is briefly recorded in the server log file (details: https://fahrtrichtung.info/datenschutz).

These requests do not contain any personal data. As with any HTTP request, your IP address is transmitted to these services as part of standard internet protocol.

### Local Storage

The extension stores, locally in the browser, a usage counter (number of opens) and the most recently retrieved coach sequences (at most 30 trains, for up to 60 days), so the direction of travel can still be shown if fernbahn.de is briefly unavailable. This data never leaves the browser. No personal data is stored.

### Uninstall survey

When you remove the extension, your browser opens fahrtrichtung.info/tschuess with an optional one-click survey. The extension itself sends no data at all; it only opens this page. Details: https://fahrtrichtung.info/datenschutz

### Access to bahn.de

The extension reads information from the open bahn.de page (train name, stations, travel date) to identify the correct train. This data is only processed locally and is not stored or forwarded.

---

Zuletzt aktualisiert / Last updated: October 2026

Kontakt / Contact: https://github.com/held0/fahrtrichtung-extension/issues
