#!/bin/bash
# Bildschirmfoto der iPad-App: scripts/debug/ipsnap.sh ziel.png [Ordner]
DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/${2:-Heft-Test}/Debug"
mkdir -p "$DIR"
N=snap$RANDOM
touch "$DIR/$N.snap"
for i in $(seq 1 120); do [ -f "$DIR/$N.png" ] && break; sleep 0.5; done
sleep 1
mv "$DIR/$N.png" "${1:-/tmp/ipad-snap.png}" 2>/dev/null && echo ok || echo "(kein Bild)"
