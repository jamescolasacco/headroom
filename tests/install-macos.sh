#!/bin/bash
# Runs only on fixture bundles and an explicit temporary installation directory.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pkg="$tmp/package"
dest="$tmp/installed"
app="Headroom Viewer.app"
mkdir -p "$pkg/$app/Contents" "$dest/$app" "$tmp/bin"
cp "$repo/tools/install-macos.sh" "$pkg/install.sh"
cat > "$pkg/$app/Contents/Info.plist" <<'PLIST'
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>FixtureViewer</string></dict></plist>
PLIST
echo new > "$pkg/$app/version"
echo old > "$dest/$app/version"
export HEADROOM_INSTALL_DIR="$dest"
export PATH="$tmp/bin:$PATH"
# No app is running in this fixture. Force exactly the publish rename to fail.
echo -e '#!/bin/bash\nexit 1' > "$tmp/bin/pgrep"
cat > "$tmp/bin/mv" <<'MV'
#!/bin/bash
if [[ "${FAIL_PUBLISH:-}" == 1 && "$1" == */new ]]; then exit 1; fi
exec /bin/mv "$@"
MV
chmod +x "$tmp/bin/pgrep" "$tmp/bin/mv"
if FAIL_PUBLISH=1 bash "$pkg/install.sh" --only viewer --no-launch; then exit 1; fi
[[ "$(cat "$dest/$app/version")" == old ]]
bash "$pkg/install.sh" --only viewer --no-launch
[[ "$(cat "$dest/$app/version")" == new ]]
[[ "$(ls -A "$dest")" == "$app" ]]
if bash "$pkg/install.sh" --only typo --no-launch; then exit 1; fi
bash "$repo/tools/uninstall-macos.sh" --help
