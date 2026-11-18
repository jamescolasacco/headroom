#!/bin/bash
# Runs the Headroom account server (and relay) on this Mac permanently: a per-user LaunchAgent that starts at login
# and restarts it if it stops. Needs Node.js 20 or later (https://nodejs.org or `brew install node`).
#
#   tools/install-account-server-macos.sh [--port 8780] [--public]   install or update, then start
#   tools/install-account-server-macos.sh --uninstall                stop and remove (keeps the data)
#
#   --public  listen on all interfaces. By default it listens on 127.0.0.1 only, for a tunnel or reverse proxy
#             (Cloudflare Tunnel, Tailscale Funnel, Caddy) that adds HTTPS; it then trusts X-Forwarded-For.
#
# Data (accounts, the token key) lives in ~/Library/Application Support/Headroom Accounts; back it up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=app.headroom.accounts
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HOME_DIR="$HOME/Library/Application Support/Headroom Accounts"
PORT=8780
PUBLIC=0
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --public) PUBLIC=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ "$UNINSTALL" = 1 ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed the account server login item. Data kept in: $HOME_DIR"
  exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js 20 or later is required: https://nodejs.org (or brew install node)" >&2; exit 1; }
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || { echo "Node.js 20 or later is required (found $("$NODE" --version))." >&2; exit 1; }

# A copy of the server and the web app it serves, so the repository can move or change without breaking it.
mkdir -p "$HOME_DIR/app" "$HOME_DIR/data" "$HOME/Library/LaunchAgents"
chmod 700 "$HOME_DIR"
cp "$ROOT/account-server/server.mjs" "$HOME_DIR/app/server.mjs"
rsync -a --delete --exclude '.DS_Store' --exclude 'admin.html' --exclude 'js/admin.js' --exclude 'css/admin.css' "$ROOT/web/" "$HOME_DIR/app/web/"

BIND=127.0.0.1
TRUST=1
if [ "$PUBLIC" = 1 ]; then BIND=0.0.0.0; TRUST=0; fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$HOME_DIR/app/server.mjs</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>$PORT</string>
    <key>BIND</key><string>$BIND</string>
    <key>TRUST_PROXY</key><string>$TRUST</string>
    <key>DATA_DIR</key><string>$HOME_DIR/data</string>
    <key>WEB_ROOT</key><string>$HOME_DIR/app/web</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/server.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
if curl -fs "http://127.0.0.1:$PORT/api/info" > /dev/null; then
  echo "Headroom account server is running on http://$BIND:$PORT/ (starts at login). Log: $HOME_DIR/server.log"
else
  echo "Installed, but it isn't answering yet; see $HOME_DIR/server.log" >&2
fi
cat <<EOF

Next:
  1. Give it a public HTTPS address (docs/RELAY.md), e.g.  cloudflared tunnel --url http://localhost:$PORT
  2. Open that address, create your account (the first one is the owner's).
  3. In Headroom Server → Account on each computer, join using that address.
EOF
