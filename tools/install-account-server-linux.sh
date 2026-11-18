#!/bin/bash
# Runs the Headroom account server and relay on a Linux server as a systemd service, listening on 127.0.0.1 for a
# tunnel or reverse proxy that adds HTTPS (Cloudflare Tunnel, Caddy, nginx). Run it from a checkout of the
# repository; run it again after `git pull` to update (data and accounts are kept).
#
#   sudo tools/install-account-server-linux.sh [--admin <username>] [--port 8780] [--name "Headroom"]
#   sudo tools/install-account-server-linux.sh --uninstall          stop and remove the service (keeps the data)
#
#   --admin <username>  create this account if the server has none yet (asks for the password; or pipe it in).
#                       Public sign-up stays off, so nobody else can claim the server first.
#
# Needs Node.js 20 or later and systemd. Data: /var/lib/headroom-accounts (back it up: secret.key derives every
# device's keys). Logs: journalctl -u headroom-accounts
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/headroom-accounts
DATA=/var/lib/headroom-accounts
UNIT=/etc/systemd/system/headroom-accounts.service
PORT=8780
NAME=Headroom
ADMIN=""
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --admin) ADMIN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "Run it with sudo." >&2; exit 1; }
command -v systemctl > /dev/null || { echo "systemd is required (or use the Docker image: account-server/Dockerfile)." >&2; exit 1; }

if [ "$UNINSTALL" = 1 ]; then
  systemctl disable --now headroom-accounts 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  echo "Removed the service. Data kept in $DATA (delete it yourself if you mean to)."
  exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js 20 or later is required: https://nodejs.org/en/download (e.g. via your package manager or nvm)." >&2; exit 1; }
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || { echo "Node.js 20 or later is required (found $("$NODE" --version))." >&2; exit 1; }
# A Node installed under a home directory (nvm) isn't reachable by the service user: copy it beside the app.
case "$NODE" in
  /home/*|/root/*) install -D -m 755 "$NODE" "$APP/node"; NODE="$APP/node" ;;
esac

id headroom > /dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin headroom
install -d -m 755 "$APP"
install -d -o headroom -g headroom -m 700 "$DATA"
install -m 644 "$ROOT/account-server/server.mjs" "$APP/server.mjs"
rm -rf "$APP/web.new"
cp -R "$ROOT/web" "$APP/web.new"
rm -f "$APP/web.new/admin.html" "$APP/web.new/js/admin.js" "$APP/web.new/css/admin.css" # the computers' settings page
rm -rf "$APP/web" && mv "$APP/web.new" "$APP/web"
chmod -R a+rX "$APP"

run_as_service_user() { # the CLI, with the service's data directory
  if command -v runuser > /dev/null; then runuser -u headroom -- env DATA_DIR="$DATA" "$NODE" "$APP/server.mjs" "$@"
  else sudo -u headroom env DATA_DIR="$DATA" "$NODE" "$APP/server.mjs" "$@"; fi
}

accounts="$(run_as_service_user list-users | grep -c . || true)"
if [ -n "$ADMIN" ] && [ "$accounts" = 0 ]; then
  # The running server keeps the accounts in memory and would overwrite the new one when it stops: stop it first.
  systemctl stop headroom-accounts 2>/dev/null || true
  echo "Creating the account '$ADMIN'."
  run_as_service_user add-user "$ADMIN"
  accounts="$(run_as_service_user list-users | grep -c . || true)"
  [ "$accounts" != 0 ] || { echo "The account wasn't created (see above)." >&2; exit 1; }
fi

cat > "$UNIT" <<EOF
[Unit]
Description=Headroom account server and relay
After=network-online.target
Wants=network-online.target

[Service]
User=headroom
Group=headroom
Environment=PORT=$PORT
Environment=BIND=127.0.0.1
Environment=TRUST_PROXY=1
Environment=SIGNUP=closed
Environment="NAME=$NAME"
Environment=DATA_DIR=$DATA
Environment=WEB_ROOT=$APP/web
ExecStart=$NODE $APP/server.mjs
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable headroom-accounts > /dev/null 2>&1
systemctl restart headroom-accounts
for i in $(seq 20); do
  curl -fs "http://127.0.0.1:$PORT/api/info" > /dev/null 2>&1 && break
  sleep 0.5
done
if curl -fs "http://127.0.0.1:$PORT/api/info" > /dev/null 2>&1; then
  echo "Headroom account server and relay: running on http://127.0.0.1:$PORT (systemd: headroom-accounts)."
else
  echo "Installed, but it isn't answering yet: journalctl -u headroom-accounts -n 50" >&2
  exit 1
fi
if [ "$accounts" = 0 ]; then
  echo
  echo "No account yet (public sign-up is off). Create yours:  sudo $0 --admin <username>"
fi
cat <<EOF

Point your tunnel or reverse proxy at http://localhost:$PORT, e.g. in cloudflared's config.yml:
    ingress:
      - hostname: relay.example.com
        service: http://localhost:$PORT
Then join each computer in Headroom Server → Settings → Account using https://relay.example.com.
EOF
