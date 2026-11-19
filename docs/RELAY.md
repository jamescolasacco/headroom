# The relay and guest codes

Every Headroom Server keeps one outbound connection to the relay (part of the account server), so it can be
reached from any browser on any network with no port forwarding, VPN or certificate install:

- **Your devices:** a computer signed in to your account is on the relay as one of your devices; signed-in
  browsers reach it at `/r/<its relay id>/` (the website does this for you — nobody sees or types relay ids).
- **Guests:** any computer, signed in or not, can make a 9-digit code. Whoever has it opens the website, enters
  it, and waits until the person at the computer clicks **Accept**.

Headroom Viewer on the same network connects to a computer directly instead.

## How it works

1. The computer opens a WebSocket to `/api/relay/control` — with its account credential, or with none (then it
   gets a random, unguessable relay id each time and is reachable only with codes; at most 5 such computers per
   network address).
2. For each viewer connection, the relay sends `{"t":"open","id":<nonce>,"client":<address>,"country":<cc>,
   "guest":<bool>}`; the computer opens a tunnel WebSocket to `/api/relay/tunnel/<nonce>` whose binary messages
   carry the viewer's bytes, and serves it like a direct connection (marked as relayed: never local).
3. The relay adds `X-Headroom-Client`, `X-Headroom-Country` and `X-Headroom-Guest` to forwarded requests and
   drops any the viewer sent.

## What can go through it

To `/r/<id>/`: only `/ws` (sessions), `/api/info`, `/api/me` and `/api/files/{list,download,upload,mkdir}`.
To `/c/<code>/` (a guest before being accepted): only `/ws` and `/api/info` (the computer's name). Never the
settings window, its API or anything else — the computer enforces the same lists again.

## Guest codes

- **Making one:** Headroom Server → *Let someone connect* → *Create a code*. The computer asks the relay for a
  4-digit **slot** (`{"t":"slot"}`), which routes `/c/<slot>/` to it, and adds 5 secret digits of its own: the
  relay never sees them. The code is shown as `123 456 789`, with a link `https://<site>/#code=123456789` (the
  fragment never reaches a server). It works for one person, for 10 minutes, and stops when used, cancelled
  ("Stop sharing"), withdrawn, or when the computer goes offline.
- **Guessing:** unknown slots are throttled per address (5 free tries, then exponential) and overall; on a real
  slot, 5 wrong secret digits make the computer withdraw the code. Codes only work through the relay's code path,
  not directly.
- **Accepting:** the computer always asks: "“name” wants to connect", with the name labelled as not verified, the
  approximate location (country) and address, and a warning about support scams. **Accept**, **View only** or
  **Decline**; *Let them transfer files* and *Share clipboard* start unticked. No answer in 2 minutes declines.
  At most 3 people can wait at once; accepting one declines the others.
- **During the session:** a bar at the top of the screen shows who is connected, with **Stop**. In the window
  (Home), control, files and clipboard can be switched per guest while connected. The computer never sends its
  clipboard to a guest unless allowed.
- **Dropped connections:** an accepted guest gets a resume key and continues at the computer's own relay path; it
  reconnects without asking again for 2 minutes after a drop (12 hours at most). Stop ends it for good.

## Trust model

- TLS runs from the browser to the relay and from the relay to the computer, but **the relay itself sees the
  session in the clear** (it's a proxy, not end-to-end encryption; that is next on the roadmap). Run your own if
  you'd rather trust only yourself.
- The relay can't make a computer accept anything it wouldn't accept directly: the computer authenticates every
  session (your account's keys, or a guest it accepted) and refuses everything outside the paths above.
- Limits: `MAX_HOSTS` computers and `MAX_TUNNELS` viewer connections at once (and 64 per computer); 5 computers
  without an account per network address.

## Putting the relay on the internet

The relay needs a public **HTTPS** address. On a Linux server or VPS:

```bash
sudo tools/install-account-server-linux.sh --url https://headroom.example.com
```

(see [ACCOUNTS.md](ACCOUNTS.md) for email and the human check), behind one of:

- **Cloudflare Tunnel** (free, no open ports; needs a domain on Cloudflare). In cloudflared's `config.yml`:
  ```yaml
  ingress:
    - hostname: headroom.example.com
      service: http://localhost:8780
    - service: http_status:404
  ```
  WebSockets pass through by default. **Bot Fight Mode** (and similar challenges) can block the computers' own
  connections, which aren't browsers: if a computer reports "The relay refused this computer (HTTP 403)", turn it
  off for this hostname or skip challenges for `/api/relay/`, `/r/` and `/c/`. Cloudflare's free plan limits a
  single upload to **100 MB** through the relay.
- **Tailscale Funnel** (`tailscale funnel 8780`) or **Caddy** (`reverse_proxy localhost:8780`).

Behind any of these the server runs with `TRUST_PROXY=1` (the installer sets it) so rate limiting and computers see
the viewer's real address and country (`CF-IPCountry` behind Cloudflare), and `BIND=127.0.0.1` so it's only
reachable through the proxy. `RELAY=off` turns the relay off (accounts keep working).
