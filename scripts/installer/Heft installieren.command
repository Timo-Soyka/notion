#!/bin/bash
# Installiert Heft nach „Programme“ und gibt die App für den ersten Start frei.
# Heft ist nicht bei Apple notarisiert – ohne diesen Schritt blockiert macOS
# den Start mit „Entwickler kann nicht überprüft werden“.
cd "$(dirname "$0")"
clear
echo "Heft wird installiert …"
echo

if [ "$(uname -m)" != "arm64" ]; then
  echo "Heft läuft nur auf Macs mit Apple-Chip (M1 oder neuer)."
  read -n 1 -s -r -p "Taste drücken zum Schließen …"
  exit 1
fi

DEST=/Applications
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"

# Eine laufende ältere Fassung vorher beenden
if pgrep -xq Heft; then
  osascript -e 'tell application id "de.timo.heft" to quit' >/dev/null 2>&1 || true
  sleep 1
fi

rm -rf "$DEST/Heft.app"
ditto "Heft.app" "$DEST/Heft.app"
xattr -dr com.apple.quarantine "$DEST/Heft.app" 2>/dev/null || true
echo "✓ Installiert: $DEST/Heft.app"

if [ -z "$(mdfind "kMDItemCFBundleIdentifier == 'com.devon-technologies.think'" 2>/dev/null | head -1)" ]; then
  echo
  echo "Hinweis: DEVONthink wurde nicht gefunden. Heft speichert alle Einträge"
  echo "in einer DEVONthink-Datenbank – bitte DEVONthink 4 installieren."
fi

echo
echo "Heft wird gestartet. Beim ersten Speichern fragt macOS, ob Heft"
echo "DEVONthink steuern darf – bitte mit „Erlauben“ bestätigen."
open "$DEST/Heft.app"
echo
echo "Dieses Fenster kann jetzt geschlossen werden."
