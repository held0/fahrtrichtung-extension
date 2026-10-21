# Privacy Policy – Fahrtrichtung Extension

Last updated: 21 October 2026

## What data is collected?

This extension does **not collect any personal data**. No accounts are created and no cookies are set.

## What data is sent to third parties?

To determine the travel direction, the extension makes the following requests:

1. **fernbahn.de** – Train type and train number are sent to retrieve the coach sequence.
2. **bahn.de** – Train type, train number, travel date, and the departure station/time of the selected train are sent to the timetable API of the bahn.de website to retrieve the station list and times.
3. **fahrtrichtung.info** – only if fernbahn.de is unavailable: train type, train number, travel date and the extension version are sent to retrieve the coach sequence for that train. Train and date are not stored there; as with any website visit, the IP address is briefly recorded in the server log file.

These requests do not contain any personal data (no names, email addresses, or location data).

## What data is stored locally?

The extension stores in `chrome.storage.local`:

- a usage counter (number of opens), used to occasionally show a donation prompt;
- the most recently retrieved coach sequences (at most 30 trains, for up to 60 days), so the direction of travel can still be shown if fernbahn.de is briefly unavailable.

This data never leaves the browser. No personal data is stored.

## Uninstall survey

When you remove the extension, your browser opens fahrtrichtung.info/tschuess with an optional one-click survey. The extension itself sends no data at all; it only opens this page. Details: https://fahrtrichtung.info/datenschutz

## Website access

The extension reads information from the open bahn.de page (train name, stations, travel date) to identify the correct train. This data is only processed locally and is not stored or forwarded.

## Contact

Questions about this privacy policy: https://github.com/held0/fahrtrichtung-extension/issues
