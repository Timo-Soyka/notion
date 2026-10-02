#!/bin/bash
# Bildschirmfoto des Heft-Fensters (Debug-Modus): scripts/debug/hsnap.sh ziel.png
mkdir -p /tmp/heft-debug
N=snap$RANDOM
touch /tmp/heft-debug/$N.snap
for i in $(seq 1 50); do [ -f /tmp/heft-debug/$N.png ] && break; sleep 0.1; done
sleep 0.3
mv /tmp/heft-debug/$N.png "${1:-/tmp/heft-snap.png}" 2>/dev/null && echo ok
