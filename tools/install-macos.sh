#!/bin/bash
# Installs Headroom Server and Headroom Viewer into /Applications — or ~/Applications when /Applications isn't
# writable — then starts Headroom Server. Works from the repository (apps built by tools/build-macos.sh in dist/)
# and from an unzipped release (the apps next to this script, where it's called install.sh).
#
#   tools/install-macos.sh [--only server|viewer] [--cli] [--no-launch] [--relaunch-viewer]
#
#   --cli              also link the `headroom` command into /usr/local/bin (asks for your password if needed)
#   --no-launch        don't start Headroom Server afterwards
#   --relaunch-viewer  open Headroom Viewer afterwards (the updater: it was open)
#   HEADROOM_INSTALL_DIR=<dir> installs somewhere else (the updater: where the apps are; or testing)
#   HEADROOM_INSTALL_WAIT=1    give running copies 10 seconds to quit by themselves first (the updater)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$HERE/Headroom Server.app" ] || [ -d "$HERE/Headroom Viewer.app" ]; then SRC="$HERE"; else SRC="$(cd "$HERE/.." && pwd)/dist"; fi
ONLY=""
CLI=0
LAUNCH=1
VIEWER=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --cli) CLI=1; shift ;;
    --no-launch) LAUNCH=0; shift ;;
    --relaunch-viewer) VIEWER=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

DEST="${HEADROOM_INSTALL_DIR:-/Applications}"
mkdir -p "$DEST" 2>/dev/null || true
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }

install_app() { # name
  local src="$SRC/$1.app" dst="$DEST/$1.app"
  [ -d "$src" ] || { echo "$src not found: run tools/build-macos.sh first" >&2; exit 1; }
  # Stop a running copy (SIGTERM: the app quits and its engine follows). No AppleScript: "tell … to quit"
  # can launch an app that isn't running, and asks for the Automation permission.
  local exe
  exe="$(defaults read "$src/Contents/Info" CFBundleExecutable)"
  if [ -n "${HEADROOM_INSTALL_DIR:-}" ]; then
    # Somewhere else: only stop a copy running from there (after it's had a chance to quit by itself).
    if [ -n "${HEADROOM_INSTALL_WAIT:-}" ]; then
      for _ in $(seq 20); do pgrep -f "$dst/Contents/MacOS/$exe" >/dev/null || break; sleep 0.5; done
    fi
    if pgrep -f "$dst/Contents/MacOS/$exe" >/dev/null; then pkill -f "$dst/Contents/MacOS/$exe"; sleep 1; fi
  elif pgrep -x "$exe" >/dev/null; then pkill -x "$exe"; sleep 1; fi
  rm -rf "$dst"
  ditto "$src" "$dst"
  xattr -dr com.apple.quarantine "$dst" 2>/dev/null || true
  echo "Installed $dst"
}

if [ "$ONLY" != "viewer" ]; then
  install_app "Headroom Server"
  if [ "$CLI" = 1 ]; then
    target="$DEST/Headroom Server.app/Contents/MacOS/headroom"
    if [ -w /usr/local/bin ]; then ln -sf "$target" /usr/local/bin/headroom; else sudo mkdir -p /usr/local/bin && sudo ln -sf "$target" /usr/local/bin/headroom; fi
    echo "Linked /usr/local/bin/headroom"
  fi
fi
[ "$ONLY" != "server" ] && install_app "Headroom Viewer"
[ "$VIEWER" = 1 ] && [ "$ONLY" != "server" ] && open "$DEST/Headroom Viewer.app"

if [ "$ONLY" != "viewer" ] && [ "$LAUNCH" = 1 ]; then
  open "$DEST/Headroom Server.app"
  cat <<EOF

Headroom Server is running in the menu bar. Next:
  1. Allow Screen Recording and Accessibility when asked (or from its Settings). macOS restarts the app
     after Screen Recording is turned on.
  2. Sign in under "Account" to add this Mac to your devices (or use "Let someone connect" for a code), and
     turn on "Start at login" in Settings.
EOF
fi
