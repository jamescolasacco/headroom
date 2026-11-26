#!/bin/bash
# Runs only on fixture bundles and an explicit temporary installation directory.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pkg="$tmp/package"
dest="$tmp/installed"
app="Headroom Viewer.app"
server="Headroom Server.app"
mkdir -p "$pkg/$app/Contents" "$dest/$app" "$pkg/$server/Contents" "$dest/$server" "$tmp/bin"
cp "$repo/tools/install-macos.sh" "$pkg/install.sh"
cat > "$pkg/$app/Contents/Info.plist" <<'PLIST'
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>FixtureViewer</string></dict></plist>
PLIST
cat > "$pkg/$server/Contents/Info.plist" <<'PLIST'
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>FixtureServer</string></dict></plist>
PLIST
echo new > "$pkg/$app/version"
echo old > "$dest/$app/version"
echo new > "$pkg/$server/version"
echo old > "$dest/$server/version"
export HEADROOM_INSTALL_DIR="$dest"
export PATH="$tmp/bin:$PATH"
# No app is running in this fixture. Force exactly the publish rename to fail, and record what would be opened
# (never the real `open`).
echo -e '#!/bin/bash\nexit 1' > "$tmp/bin/pgrep"
cat > "$tmp/bin/mv" <<'MV'
#!/bin/bash
if [[ "${FAIL_PUBLISH:-}" == 1 && "$1" == */new ]]; then exit 1; fi
exec /bin/mv "$@"
MV
cat > "$tmp/bin/open" <<OPEN
#!/bin/bash
echo "\$*" >> "$tmp/opened"
OPEN
chmod +x "$tmp/bin/pgrep" "$tmp/bin/mv" "$tmp/bin/open"
if FAIL_PUBLISH=1 bash "$pkg/install.sh" --only viewer --no-launch; then exit 1; fi
[[ "$(cat "$dest/$app/version")" == old ]]
bash "$pkg/install.sh" --only viewer --no-launch
[[ "$(cat "$dest/$app/version")" == new ]]
[[ "$(ls -A "$dest")" == "$(printf '%s\n' "$server" "$app")" ]]
if bash "$pkg/install.sh" --only typo --no-launch; then exit 1; fi
[[ ! -e "$tmp/opened" ]]

# As the updater runs it: whatever happens, the app that quit to update is running again afterwards.
export HEADROOM_INSTALL_WAIT=1
if FAIL_PUBLISH=1 bash "$pkg/install.sh" --only server; then exit 1; fi
[[ "$(cat "$dest/$server/version")" == old && "$(cat "$tmp/opened")" == "$dest/$server" ]]
rm "$tmp/opened"
echo old > "$dest/$app/version"
if FAIL_PUBLISH=1 bash "$pkg/install.sh" --only viewer --no-launch --relaunch-viewer; then exit 1; fi
[[ "$(cat "$dest/$app/version")" == old && "$(cat "$tmp/opened")" == "$dest/$app" ]]
rm "$tmp/opened"
mkdir "$tmp/readonly"
chmod 555 "$tmp/readonly"
if HEADROOM_INSTALL_DIR="$tmp/readonly" bash "$pkg/install.sh" --only server; then exit 1; fi
[[ "$(cat "$tmp/opened")" == "$tmp/readonly/$server" ]]
rm "$tmp/opened"
bash "$pkg/install.sh" --only server
[[ "$(cat "$dest/$server/version")" == new && "$(cat "$tmp/opened")" == "$dest/$server" ]]
[[ "$(ls -A "$dest")" == "$(printf '%s\n' "$server" "$app")" ]]
unset HEADROOM_INSTALL_WAIT
bash "$repo/tools/uninstall-macos.sh" --help
