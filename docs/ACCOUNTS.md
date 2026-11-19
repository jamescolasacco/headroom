# Headroom accounts

An account is an email and a password. It owns **devices**: every computer that has signed in with Headroom
Server, listed even while it's off ("last seen"). Sign in at the Headroom website or in Headroom Viewer and you see
all of them and connect without anyone accepting. Each device is named after its computer; rename it in Headroom
Server (Account → this computer's name).

The account server (`account-server/server.mjs`, Node.js 20+, no dependencies) is also the relay
([RELAY.md](RELAY.md)) and serves the website. The public one is https://headroom.colasac.co; you can run your own.

## Signing up and signing in

- **Create account:** email + password (at least 12 characters), a human check (Cloudflare Turnstile), then the
  6-digit code we email. The account exists only once the code is entered, and the password is set with the code,
  so nobody can start an account with someone else's email and a password of their own. Signing up with an email
  that already has an account answers the same way and emails the owner instead (no way to find out who has one).
- **Sign in:** email + password (+ a code from an authenticator app if two-factor is on). Every new sign-in is
  emailed to you with where it came from; every computer that signs in is too.
- **Forgot password?** Email + human check → a 6-digit code by email → new password. The answer is the same
  whether or not the email has an account. Resetting signs out your browsers and phones (not your computers).
- **Account page** (tap your email): *Where you're signed in* (each browser or phone, labelled like "Safari on
  iPhone", with Sign out), your devices (Remove), change password (signs out your other browsers), two-factor
  sign-in, change email (code to the new address, notice to the old one), delete account, sign out.

Codes are 6 random digits, work for 15 minutes, and allow 5 tries; sending is limited per address and per
recipient so nobody can be flooded with emails.

## Running an account server

On a Linux server or VPS with systemd, behind HTTPS (Cloudflare Tunnel, Caddy, nginx):

```bash
sudo tools/install-account-server-linux.sh --url https://relay.example.com
```

It installs the `headroom-accounts` service on `127.0.0.1:8780` and creates `/etc/headroom-accounts.env`
(mode 600, never overwritten) for:

| setting | |
|---|---|
| `RESEND_API_KEY`, `EMAIL_FROM` | email through [Resend](https://resend.com): an API key, and a From address on a domain verified there (add the DNS records Resend shows). Without them, codes are only written to the log. |
| `PUBLIC_URL` | the address people open, used in emails |
| `TURNSTILE_SITEKEY`, `TURNSTILE_SECRET` | [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) widget for your domain: the human check on sign-up and password resets (recommended) |
| `SIGNUP=closed` | only accounts made from the command line |
| `MIN_PASSWORD`, `BREACH_CHECK=off`, `DEVICE_IDLE_DAYS` | password length (12), the breached-password check, sign-out after days unused (90) |
| `MAX_HOSTS`, `MAX_TUNNELS` | relay limits: computers connected at once (5000), viewer connections at once (2000) |

`sudo systemctl restart headroom-accounts` applies changes. Run the installer again after `git pull` to update.
Point your apps at your server: `DEFAULT_ACCOUNT_SERVER` in `web/js/config.js` (website, Headroom Viewer) and
`"server"` in each Headroom Server's `config.json`.

Moderation is from the command line (there is no admin page):
```bash
sudo headroom-accounts list-users
sudo headroom-accounts add-user <email>         # asks for the password; already verified
sudo headroom-accounts disable-user <email>     # can't sign in, its computers can't be reached; enable-user undoes
sudo headroom-accounts reset-2fa <email>
sudo headroom-accounts reset-password <email>
sudo headroom-accounts delete-user <email>
```
(The wrapper stops the service around changes: the running server keeps the database in memory.)

Elsewhere: `node account-server/server.mjs` (environment variables as above, plus `PORT`, `BIND`, `DATA_DIR`,
`TRUST_PROXY=1` behind a proxy, `TLS_CERT`/`TLS_KEY`), the Docker image (`account-server/Dockerfile`), or
`tools/install-account-server-macos.sh` on a Mac. A database from before email accounts (usernames) is set aside
as `db.v1-<time>.json` and the server starts fresh.

## Security controls

Aligned with **NIST SP 800-63B** and the **OWASP ASVS** for authentication, session management and HTTP security.
This is a self-assessment, not a certification.

| area | what the account server does |
|---|---|
| Password rules | At least 12 characters (`MIN_PASSWORD`), up to 256, any characters including spaces and Unicode (compared in NFKC form); no composition rules or forced expiry. Refused: the email's name inside it, repeated or keyboard/sequential runs, common passwords, and passwords found in breaches (Have I Been Pwned range API: only the first 5 hex digits of a SHA-1 leave the server). |
| Password storage | scrypt, N=2¹⁵, r=8, p=3, 16-byte random salt per password, parameters stored per record and upgraded at the next sign-in. |
| Email verification | Accounts exist only after the emailed code; emailed codes are hashed in memory, expire in 15 minutes, 5 tries. |
| Bots | Cloudflare Turnstile on sign-up and password resets (when configured), checked server-side. |
| Second factor | Optional TOTP (RFC 6238, 6 digits, 30 s, ±1 step), each code accepted once. Turning it off needs the password and is emailed. |
| Brute force | Failed sign-ins and codes throttled per address and per email/account (5 free, then exponential up to 15 minutes) plus a global cap; unknown emails and wrong passwords get the same answer and the same work. Emails sent are limited per address and per recipient. |
| Enumeration | Sign-up, sign-in and forgot-password answer the same whether or not an email has an account. |
| Notices | New sign-ins, new computers, password changes, email changes (to the old address), two-factor turned off and account deletion are emailed. |
| Sessions | Each sign-in is a 256-bit random token stored only as SHA-256, listed per account and revocable. Browsers and phones unused for 90 days are signed out. |
| Re-authentication | The current password is required to change the password or email, turn off two-factor, or delete the account. |
| Transport and browser | Meant to run behind HTTPS; sends `Strict-Transport-Security` when it is. Strict `Content-Security-Policy` (own scripts plus Cloudflare Turnstile, no framing), `nosniff`, `no-referrer`, `Cross-Origin-Opener-Policy`, restrictive `Permissions-Policy`. No cookies: bearer tokens, so CORS can't be abused. |
| Audit | Sign-ins (and failures), account changes and command-line moderation are logged as `audit:` lines (journalctl). Passwords, tokens and codes are never logged (unless email isn't configured, when codes go to the log instead). |
| Data at rest | `db.json` and `secret.key` are mode 600 in a 700 directory; no passwords or tokens in recoverable form. Unverified sign-ups are never stored. |

## Trust model

- **Passwords** are only sent to the account server, never to computers.
- **Per-computer keys.** For each browser sign-in and computer the server derives
  `token = base64url(HMAC-SHA256(secret.key, "headroom-computer-token|v1|<deviceId>|<computerId>|<epoch>"))`.
  The browser receives the token in `GET /api/account/computers`; the computer receives only `SHA-256(token)` in
  its check-in reply. A key copied from one computer's list is useless anywhere else.
- **Computers** check the `hello` token against the list from their last check-in. An unknown token triggers an
  immediate check-in (at most every 3 s), so a browser that just signed in connects at once. Sign-ins appear on
  the computer as `account:<id>`; they get that computer's settings (control, clipboard, files, sound).
- **Revocation.** Signing a browser out takes effect at each computer's next check-in (≤ 20 s): the hash
  disappears and the computer closes that sign-in's sessions. Removing a computer deletes its credential; its next
  check-in gets 401 and it signs out (it stays reachable with guest codes).
- **Outages.** Each computer caches the list, so your devices keep connecting while the account server is down.
- **Certificates.** Each computer reports its addresses and its server key pin; Headroom Viewer pins those keys
  for direct connections on the same network, since they come from your own account. Browsers always go through
  the relay, so they need nothing installed.
- **What the account server can do.** Whoever controls it could add a sign-in to your account and so reach your
  computers, and (until end-to-end encryption) see relayed sessions. Run your own if that matters to you.

## API

JSON bodies; `Authorization: Bearer <token>` where noted. Errors: `{"error": code, "message"?}` — `bad-email`,
`weak-password`, `bad-code`, `human-check`, `bad-credentials`, `totp-required`, `bad-totp`, `rate-limited`
(+ `retryAfter`), `signup-closed`, `exists`, `disabled`, `unauthorized`, `expired`. CORS is `*`.

| method | path | auth | |
|---|---|---|---|
| GET | `/api/info` | — | `{service: "headroom-account-server", name, version, signup, relay, turnstile: <site key>\|null, email}` |
| POST | `/api/account/signup` | — | `{email, password, turnstile}` → `{ok}`; emails a code |
| POST | `/api/account/verify` | — | `{email, code, password, deviceName, platform}` → as login |
| POST | `/api/account/login` | — | `{email, password, totp?, deviceName, platform, kind: "viewer"\|"computer"}` → `{token, device, account: {id, email, totpEnabled}, passwordWeak}` |
| POST | `/api/account/forgot` | — | `{email, turnstile}` → `{ok}`; emails a code if there's an account |
| POST | `/api/account/reset` | — | `{email, code, password}` |
| POST | `/api/account/logout` | any | ends this sign-in (or signs a computer out) |
| GET | `/api/account/me` | any | `{account, device}` |
| GET | `/api/account/devices` | viewer | `{devices: [{id, kind, name, platform, created, lastSeen, lastAddress, current, online}]}` |
| DELETE | `/api/account/devices/:id` | viewer | sign a browser out, or remove a computer |
| GET | `/api/account/computers` | viewer | `{computers: [{id, hostId, name, os, osVersion, version, urls, online, lastSeen, spki, fingerprint, token, relayId, relayOnline}]}` |
| POST | `/api/account/password` | viewer | `{current, password}` → `{ok, signedOut}` |
| POST | `/api/account/email` | viewer | `{password, email}` → code to the new address; `/api/account/email/verify {code}` → `{email}` |
| POST | `/api/account/delete` | viewer | `{password}` |
| POST | `/api/account/totp/setup` | viewer | → `{secret, uri}`; `/totp/enable {code}`; `/totp/disable {password}` |
| POST | `/api/computer/heartbeat` | computer | `{hostId, name, os, osVersion, version, urls, spki, fingerprint}` → `{computerId, account: {id, email}, devices: [{id, name, tokenHash, viewOnly}], interval}` |

The relay's endpoints are in [RELAY.md](RELAY.md). On a Headroom host, the window uses the loopback-only admin
API: `POST /api/admin/account/join {email, password, totp?}`, `/account/leave`, `/account/sync`, and
`account: {email, lastSync, error?, signIns}` in `GET /api/admin/status`.
