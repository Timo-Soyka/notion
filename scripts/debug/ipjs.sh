#!/bin/bash
# JavaScript in der iPad-App ausführen (Entwicklungsversion, über iCloud Drive):
#   scripts/debug/ipjs.sh 'return 1+1' [Ordner, Standard Heft-Test] [Sekunden]
DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/${2:-Heft-Test}/Debug"
mkdir -p "$DIR"
N=cmd$RANDOM$RANDOM
printf '%s' "$1" > "$DIR/$N.tmp" && mv "$DIR/$N.tmp" "$DIR/$N.js"
for i in $(seq 1 $(( ${3:-60} * 2 ))); do [ -f "$DIR/$N.json" ] && break; sleep 0.5; done
cat "$DIR/$N.json" 2>/dev/null || echo "(keine Antwort)"
rm -f "$DIR/$N.json" "$DIR/$N.js"
