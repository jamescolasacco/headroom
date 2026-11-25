#!/bin/bash
# Launch two copies through the production app. A temporary Applications bundle
# records launches and reopen events. Run on a Mac without the selected app installed.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-Server}" in Server|Viewer) kind="${1:-Server}" ;; *) exit 2 ;; esac
app="Headroom $kind.app"
exe="Headroom$kind"
dst="$HOME/Applications/$app"
if [[ -e "/Applications/$app" || -e "$dst" ]]; then
  echo "This test needs a Mac without an existing $app installation." >&2
  exit 1
fi
tmp="$(mktemp -d)"
mkdir -p "$HOME/Applications"
mkdir "$dst" || exit 1
child=""
cleanup() {
  if [[ -n "$child" ]]; then kill "$child" 2>/dev/null || true; fi
  if [[ -s "$tmp/pid" ]]; then kill "$(cat "$tmp/pid")" 2>/dev/null || true; fi
  rm -rf "$tmp" "$dst"
}
trap cleanup EXIT
mkdir -p "$dst/Contents/MacOS"
cp "$repo/dist/$app/Contents/Info.plist" "$dst/Contents/Info.plist"
cat > "$tmp/main.swift" <<'SWIFT'
import AppKit
let root = Bundle.main.object(forInfoDictionaryKey: "FixtureDirectory") as! String
func mark(_ name: String, _ text: String = "yes") {
    try! text.write(toFile: root + "/" + name, atomically: true, encoding: .utf8)
}
final class Delegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ note: Notification) { mark("pid", String(getpid())) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mark("reopened")
        return false
    }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
SWIFT
/usr/libexec/PlistBuddy -c "Add :FixtureDirectory string $tmp" "$dst/Contents/Info.plist"
swiftc "$tmp/main.swift" -o "$dst/Contents/MacOS/$exe"
codesign --force --sign - "$dst"
ditto "$repo/dist/$app" "$tmp/$app"
cat > "$tmp/engine-spy" <<'SH'
#!/bin/sh
touch "$HEADROOM_DATA/duplicate-engine-started"
exit 2
SH
chmod +x "$tmp/engine-spy"
for marker in pid reopened; do
  rm -f "$tmp/$marker"
  HEADROOM_DATA="$tmp" HEADROOM_ENGINE="$tmp/engine-spy" HEADROOM_ADMIN_PORT=59877 \
    "$tmp/$app/Contents/MacOS/$exe" > "$tmp/duplicate.log" 2>&1 &
  child=$!
  for _ in {1..100}; do
    [[ -e "$tmp/duplicate-engine-started" ]] && { echo "A second engine was started." >&2; exit 1; }
    if [[ -s "$tmp/$marker" ]] && ! kill -0 "$child" 2>/dev/null; then break; fi
    sleep 0.2
  done
  [[ -s "$tmp/$marker" ]] && ! kill -0 "$child" 2>/dev/null || { cat "$tmp/duplicate.log"; echo "Missing handoff: $marker"; exit 1; }
  wait "$child"
  child=""
done
echo "Both launches reached the installed $app."
