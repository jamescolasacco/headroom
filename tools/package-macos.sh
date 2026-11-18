#!/bin/bash
# Packages the apps built by tools/build-macos.sh for a release:
#   dist/release/Headroom-macOS.dmg   what people download: open it, drag both apps to Applications
#   dist/release/Headroom-macOS.zip   Headroom/{Headroom Server.app, Headroom Viewer.app, install.sh, uninstall.sh}:
#                                     what the apps' updaters download (and the Terminal install)
#   dist/release/get-macos.sh         the one-line Terminal installer that downloads it
#
#   tools/build-macos.sh --universal && tools/package-macos.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
OUT="$DIST/release"
for app in "Headroom Server" "Headroom Viewer"; do
  [ -d "$DIST/$app.app" ] || { echo "$DIST/$app.app not found: run tools/build-macos.sh --universal first" >&2; exit 1; }
done

rm -rf "$OUT" && mkdir -p "$OUT/stage/Headroom"
ditto "$DIST/Headroom Server.app" "$OUT/stage/Headroom/Headroom Server.app"
ditto "$DIST/Headroom Viewer.app" "$OUT/stage/Headroom/Headroom Viewer.app"
cp "$ROOT/tools/install-macos.sh" "$OUT/stage/Headroom/install.sh"
cp "$ROOT/tools/uninstall-macos.sh" "$OUT/stage/Headroom/uninstall.sh"
chmod +x "$OUT/stage/Headroom/"*.sh
cat > "$OUT/stage/Headroom/README.txt" <<'TXT'
Headroom for macOS 13 or later (Apple silicon and Intel).

Install: open Terminal in this folder and run   bash install.sh
  (copies Headroom Server and Headroom Viewer to /Applications and starts Headroom Server)
Remove:  bash uninstall.sh   (add --purge to also delete settings and certificates)

These builds aren't notarized by Apple, so double-clicking the apps straight from a downloaded zip makes
macOS refuse to open them. install.sh clears that flag on the installed copies.

https://github.com/jamescolasacco/headroom
TXT
# ditto keeps the bundles' signatures, symlinks and permissions intact (unlike most zip tools).
(cd "$OUT/stage" && ditto -c -k --sequesterRsrc --keepParent Headroom "$OUT/Headroom-macOS.zip")
rm -rf "$OUT/stage"
cp "$ROOT/tools/get-macos.sh" "$OUT/get-macos.sh"

# The disk image: both apps and a shortcut to Applications to drag them onto.
mkdir -p "$OUT/dmg"
ditto "$DIST/Headroom Server.app" "$OUT/dmg/Headroom Server.app"
ditto "$DIST/Headroom Viewer.app" "$OUT/dmg/Headroom Viewer.app"
ln -s /Applications "$OUT/dmg/Applications"
hdiutil create -quiet -volname "Headroom" -srcfolder "$OUT/dmg" -fs HFS+ -format UDZO -ov "$OUT/Headroom-macOS.dmg"
rm -rf "$OUT/dmg"
ls -lh "$OUT"
