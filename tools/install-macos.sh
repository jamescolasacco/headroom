#!/bin/bash
# Installs Headroom Server and Headroom Viewer (built by tools/build-macos.sh) into /Applications — or
# ~/Applications when /Applications isn't writable — then starts Headroom Server.
#
#   tools/install-macos.sh [--only server|viewer] [--cli]
#
#   --cli   also link the `headroom` command into /usr/local/bin (asks for your password if needed)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ONLY=""
CLI=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --cli) CLI=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

DEST=/Applications
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }

install_app() { # name
  local src="$ROOT/dist/$1.app" dst="$DEST/$1.app"
  [ -d "$src" ] || { echo "$src not found: run tools/build-macos.sh first" >&2; exit 1; }
  # Stop a running copy (SIGTERM: the app quits and its engine follows). No AppleScript: "tell … to quit"
  # can launch an app that isn't running, and asks for the Automation permission.
  local exe
  exe="$(defaults read "$src/Contents/Info" CFBundleExecutable)"
  if pgrep -x "$exe" >/dev/null; then pkill -x "$exe"; sleep 1; fi
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

if [ "$ONLY" != "viewer" ]; then
  open "$DEST/Headroom Server.app"
  cat <<EOF

Headroom Server is running in the menu bar. Next:
  1. Allow Screen Recording and Accessibility when asked (or from its Status page). macOS restarts the app
     after Screen Recording is turned on.
  2. Pair your devices from "Pair a device", and turn on "Start at Login" in the menu-bar menu.
EOF
fi
