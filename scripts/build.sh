#!/bin/bash
# Baut Heft.app und installiert sie nach /Applications (bzw. ~/Applications).
#   scripts/build.sh            – bauen und installieren
#   scripts/build.sh --no-install
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ Tests"
node tests/markdown.test.mjs >/dev/null
node tests/typstmath.test.mjs >/dev/null
node tests/mathexpr.test.mjs >/dev/null
node tests/chem.test.mjs >/dev/null
node tests/mathlines.test.mjs >/dev/null
node tests/tablegrid.test.mjs >/dev/null
node tests/numbering.test.mjs >/dev/null
node tests/widths.test.mjs >/dev/null
node tests/filing.test.mjs >/dev/null
node tests/imagemodel.test.mjs >/dev/null
node tests/filetypes.test.mjs >/dev/null
node tests/imagesize.test.mjs >/dev/null
python3 scripts/fix-invisible.py web >/dev/null

echo "▸ Swift (Release)"
swift build -c release --build-system native 2>&1 | grep -E "error|warning: unre" || true
BIN=.build/release/Heft
[ -x "$BIN" ] || { echo "Build fehlgeschlagen"; exit 1; }

echo "▸ App-Paket"
APP=build/Heft.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Heft"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
rsync -a --delete --exclude 'testkit.js' --exclude '.DS_Store' web/ "$APP/Contents/Resources/web/"
# Feste Signatur-Anforderung (Bundle-ID), damit macOS die DEVONthink-Erlaubnis
# nach einem Update nicht jedes Mal neu abfragt
codesign --force --sign - --timestamp=none -r='designated => identifier "de.timo.heft"' "$APP" >/dev/null 2>&1
codesign --verify "$APP"

if [ "${1:-}" != "--no-install" ]; then
  DEST=/Applications
  [ -w "$DEST" ] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  # Laufende App vorher beenden, sonst bleibt die alte Fassung aktiv
  osascript -e 'tell application id "de.timo.heft" to quit' >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$DEST/Heft.app"
  ditto "$APP" "$DEST/Heft.app"
  # Die Arbeitskopie entfernen, damit macOS nur noch die installierte App startet
  rm -rf "$APP"
  echo "▸ Installiert: $DEST/Heft.app"
fi
