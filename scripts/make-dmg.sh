#!/bin/bash
# Baut Heft.app und packt sie in eine Installationsdatei (DMG):
#   scripts/make-dmg.sh   →   dist/Heft-<Version>.dmg
# Im DMG liegen Heft.app, eine Verknüpfung zu „Programme“ zum Hineinziehen
# und „Heft installieren.command“, das die App kopiert und für den ersten
# Start freigibt (die App ist nicht bei Apple notarisiert).
set -euo pipefail
cd "$(dirname "$0")/.."

scripts/build.sh --no-install
VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" Resources/Info.plist)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "▸ Installationsdatei"
ditto build/Heft.app "$STAGE/Heft.app"
ln -s /Applications "$STAGE/Programme"
cp scripts/installer/"Heft installieren.command" "$STAGE/"
chmod +x "$STAGE/Heft installieren.command"
cp scripts/installer/LIESMICH.txt "$STAGE/"

mkdir -p dist
OUT="dist/Heft-$VERSION.dmg"
rm -f "$OUT"
hdiutil create -volname "Heft $VERSION" -srcfolder "$STAGE" -format UDZO -fs HFS+ -ov "$OUT" 2>&1 >/dev/null | grep -v deprecated || true
[ -s "$OUT" ] || { echo "DMG konnte nicht erstellt werden"; exit 1; }
# Die Arbeitskopie entfernen, damit macOS nur die installierte App startet
rm -rf build/Heft.app
echo "▸ Fertig: $OUT ($(du -h "$OUT" | cut -f1))"
