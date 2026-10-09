# Headroom accounts

Accounts are optional. Without one, each device pairs with each computer (password, TOTP or a one-time code),
which is still fully supported. With an account, you sign in once on a device and every computer in the account
shows up in one list, ready to connect, like RealVNC's or Jump Desktop's sign-in.

The account server is small and self-hosted: one Node.js process (`account-server/server.mjs`, no
dependencies) or one Docker container. It is a **directory and a key issuer, never a relay**. Video, input,
clipboard, audio and files go directly between your device and your computer, exactly as with pairing.

```
          sign in (username, password, optional TOTP)         check in every 20 s:
 ┌────────┐  ──────────────────────────────────────▶ ┌──────────────┐ ◀─── addresses, certificate pin, CA ─── ┌──────────┐
 │ device │  ◀── computers + one key per computer ── │ account      │ ──── devices: id, name, key hash ─────▶ │ computer │
 └────────┘                                          │ server       │                                         └──────────┘
     │                                               └──────────────┘                                               ▲
     └─────────────────────── WSS directly, with the key made for that computer ────────────────────────────────────┘
```

## Running an account server

```bash
node account-server/server.mjs                       # http://0.0.0.0:8780, data in account-server/data/
TLS_CERT=fullchain.pem TLS_KEY=privkey.pem PORT=443 node account-server/server.mjs
docker build -f account-server/Dockerfile -t headroom-accounts .   # from the repo root
docker run -d -p 8780:8780 -v headroom-accounts:/data headroom-accounts
```

| variable | default | |
|---|---|---|
| `PORT`, `BIND` | `8780`, `0.0.0.0` | |
| `DATA_DIR` | `account-server/data` | `db.json` (accounts, devices, computers) and `secret.key` (the token key) |
| `TLS_CERT`, `TLS_KEY` | — | serve HTTPS directly; otherwise put it behind a TLS reverse proxy |
| `TRUST_PROXY` | off | `1`: take the client address from `X-Forwarded-For` (for rate limiting) |
| `SIGNUP` | `first` | `first`: only the first account can sign up (the owner); `open`: anyone; `closed`: only `add-user` |
| `NAME` | `Headroom` | shown on the sign-in screen |
| `WEB_ROOT` | `../web` | also serves the Headroom web app, so `https://accounts.example.com/` is a complete client; `WEB_ROOT=` turns it off |

Administration: `node server.mjs add-user <name>`, `list-users`, `reset-password <name>`, `reset-2fa <name>`,
`delete-user <name>`.

Give it HTTPS with a certificate your devices trust: the account server checks passwords and tells devices
which certificate key each computer has, and the Headroom app (served over HTTPS by your computers, or inside
Headroom Viewer) can't call a plain-HTTP server anyway, except on `localhost` for testing. `tailscale cert` on a
Tailscale machine, or a reverse proxy such as Caddy, gives it a real certificate.

## Using it

1. **Computers:** Headroom Server → Settings → **Account** → enter the account server, username and password
   (and the authenticator code if two-factor is on). The computer gets its own credential there; the password
   isn't stored on it.
2. **Devices:** in the Headroom app (web, iPhone/iPad Home Screen app, Headroom Viewer), tap **Sign in to your
   account**. Every computer in the account appears, with a green dot when it checked in recently.
3. **Managing:** tap your account name: remove devices or computers, make a device view-only, turn on two-factor
   sign-in, change the password, sign out. Removing a device disconnects it from every computer within seconds.

Paired computers stay in the list next to the account's; a computer that is both shows once.

## Trust model

- **Passwords** are hashed with scrypt (N=2¹⁵, r=8) on the account server and are only sent to it, never to
  computers. Two-factor sign-in is RFC 6238 TOTP with replay protection. Failed sign-ins are rate limited per
  address and per username.
- **Device credentials.** Signing in creates a device (`viewer`) or computer (`computer`) with a 256-bit bearer
  token; the server stores only its SHA-256.
- **Per-computer keys.** For each device and computer the server derives
  `token = base64url(HMAC-SHA256(secret.key, "headroom-computer-token|v1|<deviceId>|<computerId>|<epoch>"))`.
  The device receives the token in `GET /api/account/computers`; the computer receives only
  `SHA-256(token)` (uppercase hex) in its check-in reply. A computer never learns anything that would let it
  connect to another computer, and a key copied from one computer's device list is useless anywhere else.
  (`epoch` is reserved for rotating a device's keys; it is 0 today.)
- **Computers** authenticate account devices exactly like paired ones: `hello` carries the token, the host hashes
  it and finds it in the device list from its last check-in. An unknown token triggers an immediate check-in (at
  most every 3 s), so a device that just signed in connects at once. Account devices appear in the host's
  sessions and settings as `account:<deviceId>`.
- **Revocation.** Removing a device (or making it view-only) takes effect at each computer's next check-in
  (≤ 20 s): the hash disappears and the computer closes that device's sessions. Removing a computer deletes its
  credential; its next check-in gets 401 and it leaves the account, dropping all account devices.
- **Outages.** Each computer caches the device list in its config, so devices keep connecting while the
  account server is unreachable; changes apply once it's back.
- **Certificates.** Each computer reports its addresses, its server key pin (base64 SHA-256 of the
  SubjectPublicKeyInfo, the same pin Headroom Viewer stores), its key fingerprint and its local CA. Headroom
  Viewer pins those keys without asking, since they come from your own signed-in account. A browser can't be
  told to trust a certificate, so phones and other browsers still need Tailscale or the computer's CA installed
  once (see the README); the account just removes the pairing.
- **What the account server can do.** Whoever controls it can add a device to your account and so reach your
  computers; that's inherent to any sign-in system. It never sees screen contents or input. Computers you don't
  join to an account are unaffected.

## API

All bodies are JSON. `Authorization: Bearer <token>` where noted. Errors: `{"error": code, "message"?}` with
`bad-credentials`, `totp-required`, `bad-totp`, `rate-limited` (+ `retryAfter` seconds), `signup-closed`,
`username-taken`, `unauthorized`. CORS is `*` (bearer tokens, no cookies).

| method | path | auth | |
|---|---|---|---|
| GET | `/api/info` | — | `{service: "headroom-account-server", name, version, signup, firstAccount}` |
| POST | `/api/account/register` | — | `{username, password (8+), deviceName, platform}` → as login (only while sign-up is allowed) |
| POST | `/api/account/login` | — | `{username, password, totp?, deviceName, platform, kind: "viewer"\|"computer"}` → `{token, device: {id, name}, account: {id, username}}` |
| POST | `/api/account/logout` | device | deletes this device |
| GET | `/api/account/me` | device | `{account: {id, username, totpEnabled}, device}` |
| GET | `/api/account/devices` | viewer | `{devices: [{id, kind, name, platform, created, lastSeen, lastAddress, viewOnly, current, online}]}` |
| POST | `/api/account/devices/:id` | viewer | `{viewOnly?, name?}` |
| DELETE | `/api/account/devices/:id` | viewer | remove a device or computer |
| GET | `/api/account/computers` | viewer | `{computers: [{id, hostId, name, os, osVersion, version, urls, tailscale, online, lastSeen, spki, fingerprint, ca, token, viewOnly}]}` |
| POST | `/api/account/password` | viewer | `{current, password}` |
| POST | `/api/account/totp/setup` | viewer | → `{secret, uri}`; `/totp/enable {code}`; `/totp/disable {password}` |
| POST | `/api/computer/heartbeat` | computer | `{hostId, name, os, osVersion, version, urls, tailscale, spki, fingerprint, ca}` → `{computerId, account, devices: [{id, name, tokenHash, viewOnly}], interval}` |

On a Headroom host, the settings page uses the loopback-only admin API: `POST /api/admin/account/join
{server, username, password, totp?}`, `POST /api/admin/account/leave`, `POST /api/admin/account/sync`, and
`account: {server, username, lastSync, error?, devices}` in `GET /api/admin/status`.
