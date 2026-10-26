#!/bin/bash
# One-line install of the latest Headroom release on a Mac:
#   curl -fsSL https://github.com/jamescolasacco/headroom/releases/latest/download/get-macos.sh | bash
# Options go after "bash -s --", e.g.  ... | bash -s -- --only viewer
# Downloads Headroom-macOS.zip and runs its install.sh: Headroom Server and Headroom Viewer go to /Applications,
# then Headroom Server starts. (Files fetched with curl aren't quarantined, so macOS opens the un-notarized apps.)
set -euo pipefail
REPO="${HEADROOM_REPO:-jamescolasacco/headroom}"
URL="${HEADROOM_ZIP_URL:-https://github.com/$REPO/releases/latest/download/Headroom-macOS.zip}"

[ "$(uname -s)" = Darwin ] || { echo "This installer is for macOS. Windows builds: https://github.com/$REPO/releases/latest" >&2; exit 1; }
major="$(sw_vers -productVersion | cut -d. -f1)"
[ "$major" -ge 13 ] || { echo "Headroom needs macOS 13 (Ventura) or later; this Mac has $(sw_vers -productVersion)." >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $URL"
curl -fL --progress-bar -o "$tmp/Headroom-macOS.zip" "$URL"
ditto -x -k "$tmp/Headroom-macOS.zip" "$tmp/x"
bash "$tmp/x/Headroom/install.sh" "$@"
