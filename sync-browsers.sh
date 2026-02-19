#!/bin/bash
# Synchronisiert chrome/ nach firefox/, edge/ und opera/
# Ausfuehren nach Aenderungen an der Chrome-Version.

set -e
cd "$(dirname "$0")"

echo "Syncing chrome/ -> edge/ (1:1 Kopie)..."
rsync -a --delete chrome/ edge/

echo "Syncing chrome/ -> opera/ (1:1 Kopie)..."
rsync -a --delete chrome/ opera/

echo "Syncing chrome/ -> firefox/ (ohne manifest.json und background.js)..."
rsync -a --exclude='manifest.json' --exclude='background.js' chrome/ firefox/

# Firefox background.js: Chrome-Version kopieren, importScripts durch Kommentar ersetzen
echo "Updating firefox/background.js..."
sed "s|^importScripts('utils.js');|// utils.js is loaded via manifest.json background.scripts|" \
  chrome/background.js > firefox/background.js

echo "Sync abgeschlossen."
echo ""
echo "Dateien pro Browser:"
for dir in chrome firefox edge opera; do
  echo "  $dir/: $(ls "$dir/" | wc -l | tr -d ' ') Dateien"
done

# ZIP-Dateien erstellen
echo ""
echo "Erstelle ZIP-Dateien..."
for dir in chrome firefox edge opera; do
  zipfile="fahrtrichtung-${dir}.zip"
  rm -f "$zipfile"
  (cd "$dir" && zip -r "../$zipfile" . -x '.*') > /dev/null
  echo "  $zipfile ($(du -h "$zipfile" | cut -f1))"
done
echo "Fertig."
