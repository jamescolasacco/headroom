#!/bin/bash
# Removes Headroom Server and Headroom Viewer from /Applications (and ~/Applications).
#
#   tools/uninstall-macos.sh [--purge]
#
#   --purge  also deletes pairings, certificates, logs, the viewer's saved computers and pinned keys, and
#            resets the Screen Recording / Accessibility permissions macOS granted to Headroom Server
set -euo pipefail
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

# SIGTERM quits each app (Headroom Server's engine exits with it).
for exe in HeadroomServer HeadroomViewer; do
  if pgrep -x "$exe" >/dev/null; then pkill -x "$exe"; sleep 1; fi
done

for dir in /Applications "$HOME/Applications"; do
  for name in "Headroom Server" "Headroom Viewer"; do
    if [ -d "$dir/$name.app" ]; then rm -rf "$dir/$name.app"; echo "Removed $dir/$name.app"; fi
  done
done
link=/usr/local/bin/headroom
if [ -L "$link" ]; then rm -f "$link" 2>/dev/null || sudo rm -f "$link"; echo "Removed $link"; fi

if [ "$PURGE" = 1 ]; then
  rm -rf "$HOME/Library/Application Support/Headroom" "$HOME/Library/Logs/Headroom" \
         "$HOME/Library/Application Support/Headroom Viewer" \
         "$HOME/Library/WebKit/app.headroom.viewer" "$HOME/Library/Caches/app.headroom.viewer" \
         "$HOME/Library/WebKit/app.headroom.server" "$HOME/Library/Caches/app.headroom.server"
  tccutil reset ScreenCapture app.headroom.server >/dev/null 2>&1 || true
  tccutil reset Accessibility app.headroom.server >/dev/null 2>&1 || true
  echo "Deleted Headroom data and reset its permissions."
fi
echo "Done. (If Headroom Server was a login item, macOS drops it now that the app is gone.)"
