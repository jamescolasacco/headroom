# Relay and remote support

The account server (`account-server/server.mjs`) is also a relay. Every computer in an account keeps one
outbound connection to it, so it can be reached **from any browser, anywhere**, with no port forwarding, no
Tailscale and no certificate to install:

- **Your own computers:** open your account server's address (`https://accounts.example.com/`) on any device,
  sign in, and click a computer. If the device can't reach it directly (another network), the app goes through
  the relay automatically.
- **Remote support, AnyDesk-style:** the person at a computer opens Headroom Server → **Remote support**, creates
  a one-time code, and gives it with the computer's **Headroom ID** (9 digits) to whoever is helping. The helper
  opens the account server's address, chooses **Connect with an ID**, types both, and the computer shows
  **Accept / View only / Decline**. The helper needs no account, no app and no pairing.

```
 browser (anywhere) ──HTTPS──▶ relay ◀──WebSocket (outbound)── computer
                                │       control: {"t":"open",…}
                                └──────WebSocket "tunnel" per viewer connection (raw bytes)──▶ computer's own HTTP server
```

## How it works

1. A computer that joined an account opens a WebSocket to `/api/relay/control`, authenticated with its account
   credential. The relay gives it a **Headroom ID** (9 digits, kept if the computer leaves and rejoins).
2. A viewer request for `https://relay/r/<Headroom ID>/<path>` makes the relay send `{"t":"open","id":nonce}`
   on the control connection. The computer opens `/api/relay/tunnel/<nonce>` (another WebSocket) and its binary
   messages carry that viewer connection's raw bytes: one HTTP request, or a whole session WebSocket.
3. The computer serves the tunnel with its normal HTTP stack, marked as **relayed**. The session protocol is the
   same as a direct connection ([PROTOCOL.md](PROTOCOL.md)); the web client only changes its base address to
   `…/r/<Headroom ID>`.

Links between computers and the relay are WebSockets so that reverse proxies and tunnels (Caddy, nginx,
Cloudflare) pass them like any other traffic.

## What can go through it

Only `/ws` (sessions), `/api/info`, `/api/me` and `/api/files/{list,download,upload,mkdir}`. Pairing, the settings
API and certificate pages are refused **twice**: by the relay, and by the computer, which also never treats a
relayed connection as local (the relay may run on the very same machine). Every session still authenticates on
the computer: an account device's per-computer key, a paired device's token, or a support code.

## Support codes

- 6 digits, valid for an hour, **one use**: the first accepted session uses it up. Five wrong tries withdraw it,
  and failed tries count against the viewer's address in the computer's rate limiter.
- **Ask before accepting** is on by default: the menu-bar app (Mac) or tray app (Windows) and the settings page
  show the request; no answer within a minute means no. Turning it off allows unattended access with a code alone.
- An accepted session gets a **resume key** so a dropped connection reconnects without asking again. It works
  while the session lasts plus 10 minutes, at most 12 hours, and is never saved to disk. Disconnecting the
  session from the computer revokes it.
- Session messages: the viewer sends `{"t":"hello","support":{"code","name"}}`; the computer may answer
  `{"t":"pending","message"}` while it asks, then `welcome` (with `resumeToken`, `support: true`) or
  `{"t":"error","code":"bad-code"|"declined"}`. Reconnects send the resume key as `token`.

## Trust model

- TLS runs from the browser to the relay and from the relay to the computer, but **the relay itself sees the
  session in the clear** (it's a proxy, not end-to-end encryption). Run it yourself, on a machine you trust: it's
  the same server that already decides who's in your account.
- The relay can't make a computer accept anything it wouldn't accept directly: the computer authenticates every
  session and refuses everything outside the paths above.
- Headroom IDs are not secrets. Knowing one lets someone see the computer's name and try support codes, which the
  limits above make hopeless.

## Putting the relay on the internet

The relay needs a public **HTTPS** address (browsers won't use a plain-HTTP server from an HTTPS page, and
passwords cross it). Pick one:

- **Cloudflare Tunnel** (free, no open ports; needs a domain on Cloudflare):
  ```bash
  cloudflared tunnel login && cloudflared tunnel create headroom
  cloudflared tunnel route dns headroom accounts.example.com
  cloudflared tunnel run --url http://localhost:8780 headroom
  ```
  For a quick test without a domain, `cloudflared tunnel --url http://localhost:8780` prints a temporary
  `https://….trycloudflare.com` address (it changes every run).
- **Tailscale Funnel** (free; needs Tailscale on the server machine): `tailscale funnel 8780` publishes it at
  `https://<machine>.<tailnet>.ts.net/`.
- **A small VPS** with the Docker image behind Caddy (`reverse_proxy localhost:8780` gets a certificate by itself).

Behind any of these, start the server with `TRUST_PROXY=1` so rate limiting and the computers see the viewer's
real address (taken from `X-Forwarded-For`; only do this when the server isn't also reachable directly), and
`BIND=127.0.0.1` so it's only reachable through the proxy.

On a Mac that should host it permanently, `tools/install-account-server-macos.sh` installs it as a login item
(it needs Node.js 20 or later). Then join each computer to `https://<your public address>` in Headroom Server →
Account, so they connect to the relay at the address browsers use.

## Settings

| where | setting | |
|---|---|---|
| account server | `RELAY=off` | turn the relay off (accounts keep working) |
| Headroom Server → Remote support | Reachable through the relay | per computer, on by default while it's in an account |
| Headroom Server → Remote support | Ask before someone connects with a code | on by default |
