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

# Safari (macOS + iOS, Xcode-Projekt in safari/): Ressourcen nachziehen und die
# App-Version an manifest.json angleichen. Das Projekt referenziert jede Datei
# EINZELN — neue Dateien in chrome/ muessen einmal in Xcode hinzugefuegt werden.
if [ -d "safari/Shared (Extension)/Resources" ]; then
  rsync -a --exclude='.*' chrome/ "safari/Shared (Extension)/Resources/"
  VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' chrome/manifest.json | head -1)
  # perl statt sed -i: laeuft auf macOS (BSD) und im Linux-CI (GNU) gleich
  perl -pi -e "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = $VERSION;/" safari/Fahrtrichtung.xcodeproj/project.pbxproj
  for f in $(cd chrome && find . -type f ! -name '.*' ! -path './_locales/*' | sed 's|^\./||'); do  # _locales ist ein Ordner-Verweis
    grep -q "/\* $(basename "$f") \*/" safari/Fahrtrichtung.xcodeproj/project.pbxproj \
      || echo "  ⚠️  Safari: $f ist neu — in Xcode zum Target 'Fahrtrichtung Extension' hinzufuegen"
  done
  echo "safari/ (Resources + Version $VERSION) synchronisiert."
fi

# Landing-Page (fahrtrichtung.info): der manuelle Zug-Check auf der Startseite
# nutzt serverseitig EXAKT dieselbe Logik wie die Extension. Kopie nachziehen,
# damit Website und Extension nie auseinanderlaufen (landing/ ist ein eigenes Repo).
if [ -d landing/api ]; then
  cp chrome/background.js chrome/utils.js landing/api/
  echo "landing/api/ (Website-Zugsuche) mit chrome/background.js + utils.js synchronisiert."
fi
