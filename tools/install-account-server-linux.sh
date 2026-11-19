#!/bin/bash
# Runs the Headroom account server and relay on a Linux server as a systemd service, listening on 127.0.0.1 for a
# tunnel or reverse proxy that adds HTTPS (Cloudflare Tunnel, Caddy, nginx). Run it from a checkout of the
# repository; run it again after `git pull` to update (data, accounts and settings are kept).
#
#   sudo tools/install-account-server-linux.sh [--port 8780] [--name "Headroom"] [--url https://headroom.example.com]
#   sudo tools/install-account-server-linux.sh --uninstall          stop and remove the service (keeps the data)
#
# Settings (email, the human check) live in /etc/headroom-accounts.env, created once and kept (later runs change only
# PUBLIC_URL, when --url is given): put your Resend API key and Cloudflare Turnstile keys there, then
# `sudo systemctl restart headroom-accounts`.
# Accounts from the command line (as the service user): sudo headroom-accounts list-users | add-user <email> |
# disable-user <email> | enable-user <email> | reset-2fa <email> | reset-password <email> | delete-user <email>
#
# Needs Node.js 20 or later and systemd. Data: /var/lib/headroom-accounts (back it up: secret.key derives every
# computer's keys). Logs: journalctl -u headroom-accounts
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/headroom-accounts
DATA=/var/lib/headroom-accounts
UNIT=/etc/systemd/system/headroom-accounts.service
ENVFILE=/etc/headroom-accounts.env
CLI=/usr/local/bin/headroom-accounts
PORT=8780
NAME=Headroom
URL=""
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" = 0 ] || { echo "Run it with sudo." >&2; exit 1; }
command -v systemctl > /dev/null || { echo "systemd is required (or use the Docker image: account-server/Dockerfile)." >&2; exit 1; }

if [ "$UNINSTALL" = 1 ]; then
  systemctl disable --now headroom-accounts 2>/dev/null || true
  rm -f "$UNIT" "$CLI"
  systemctl daemon-reload
  echo "Removed the service. Data kept in $DATA and settings in $ENVFILE (delete them yourself if you mean to)."
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
rm -f "$APP/web.new/admin.html" "$APP/web.new/js/admin.js" "$APP/web.new/css/admin.css" # the computers' settings window
rm -rf "$APP/web" && mv "$APP/web.new" "$APP/web"
chmod -R a+rX "$APP"

if [ ! -f "$ENVFILE" ]; then
  umask 077
  cat > "$ENVFILE" <<EOF
# Headroom account server settings. Apply with: sudo systemctl restart headroom-accounts

# Email: sign-up codes, password resets, sign-in alerts. A Resend (https://resend.com) API key, and a From address
# on a domain you verified there. Until this is set, codes are only written to the log (journalctl).
RESEND_API_KEY=
EMAIL_FROM="$NAME <no-reply@example.com>"

# The address people open (shown in emails).
PUBLIC_URL=${URL}

# Cloudflare Turnstile (dash.cloudflare.com → Turnstile; add your domain): stops bots on sign-up and password resets.
TURNSTILE_SITEKEY=
TURNSTILE_SECRET=

# Anyone can create an account. Uncomment to allow only accounts made with: sudo headroom-accounts add-user <email>
#SIGNUP=closed
EOF
  chmod 600 "$ENVFILE"
  echo "Created $ENVFILE: add your email and Turnstile keys there."
elif [ -n "$URL" ]; then
  # The settings stay as they are, except the address emails give, which follows --url (the site moved to a new domain).
  esc=$(printf '%s' "$URL" | sed 's/[&|\\]/\\&/g')
  if grep -q '^PUBLIC_URL=' "$ENVFILE"; then sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=$esc|" "$ENVFILE"
  else printf 'PUBLIC_URL=%s\n' "$URL" >> "$ENVFILE"; fi
fi

cat > "$CLI" <<EOF
#!/bin/bash
# The Headroom account server's command line, as its service user (accounts change only while it's stopped).
set -e
[ "\$(id -u)" = 0 ] || { echo "Run it with sudo." >&2; exit 1; }
case "\${1:-}" in
  ""|list-users|help) ;;
  *) systemctl stop headroom-accounts; trap 'systemctl start headroom-accounts' EXIT ;;
esac
if command -v runuser > /dev/null; then runuser -u headroom -- env DATA_DIR="$DATA" "$NODE" "$APP/server.mjs" "\$@"
else sudo -u headroom env DATA_DIR="$DATA" "$NODE" "$APP/server.mjs" "\$@"; fi
EOF
chmod 755 "$CLI"

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
Environment="NAME=$NAME"
Environment=DATA_DIR=$DATA
Environment=WEB_ROOT=$APP/web
EnvironmentFile=-$ENVFILE
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
grep -q '^RESEND_API_KEY=.\+' "$ENVFILE" || echo "Email isn't set up yet: add RESEND_API_KEY and EMAIL_FROM to $ENVFILE, then: sudo systemctl restart headroom-accounts"
grep -q '^TURNSTILE_SECRET=.\+' "$ENVFILE" || echo "The human check isn't set up yet: add TURNSTILE_SITEKEY and TURNSTILE_SECRET to $ENVFILE (recommended)."
cat <<EOF

Point your tunnel or reverse proxy at http://localhost:$PORT, e.g. in cloudflared's config.yml:
    ingress:
      - hostname: headroom.example.com
        service: http://localhost:$PORT
Accounts: sudo headroom-accounts list-users   (also add-user, disable-user, enable-user, reset-2fa, delete-user)
EOF
