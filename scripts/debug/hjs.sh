#!/bin/bash
# Führt JavaScript in einer mit --debug-bridge gestarteten Heft-App aus:
#   scripts/debug/hjs.sh 'return 1+1' [Zehntelsekunden Wartezeit]
mkdir -p /tmp/heft-debug
N=cmd$RANDOM$RANDOM
OUT=/tmp/heft-debug/$N.json
printf '%s' "$1" > /tmp/heft-debug/$N.tmp && mv /tmp/heft-debug/$N.tmp /tmp/heft-debug/$N.js
for i in $(seq 1 ${2:-100}); do [ -f "$OUT" ] && break; sleep 0.1; done
cat "$OUT" 2>/dev/null || echo "(keine Antwort)"
rm -f "$OUT"
