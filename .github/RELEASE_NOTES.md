Self-hosted remote desktop for your own computers: **Headroom Server** on the computer you want to reach, **Headroom Viewer** (or the iPhone/iPad web app) on the device you use. Pair devices one by one, or run your own small account server and sign in once.

## New in 0.3: people and a plain login

- **Sign in like any other service.** The apps sign in to the built-in account server (set in `web/js/config.js`);
  signed out, the home screen is just a login.
- **People.** The first account is the administrator: invite others with a single-use link (they pick their own
  password), send password-reset links, reset two-factor, assign roles, remove accounts. Each person sees only
  their own computers.
- **Security, aligned with NIST SP 800-63B and OWASP ASVS:** 12-character minimum with checks against common and
  breached passwords, stronger password hashing (upgraded at your next sign-in), re-entering your password for
  sensitive changes, other devices signed out when a password changes, idle sign-ins expiring after 90 days, a
  strict Content-Security-Policy and HSTS, and an audit log. See
  [docs/ACCOUNTS.md](https://github.com/jamescolasacco/headroom/blob/master/docs/ACCOUNTS.md#security-controls).
- **Updating your account server:** `cd headroom && git pull && sudo tools/install-account-server-linux.sh`.
  Existing accounts keep working; the oldest becomes the administrator.

## New in 0.2: from anywhere, and remote support

- **Any browser, any network.** Your account server is now also a relay: computers keep an outbound connection
  to it, so you can reach them from anywhere with no port forwarding, VPN or certificate install. Direct
  connections are still used whenever they work.
- **Remote support, AnyDesk-style.** Headroom Server → Remote support shows the computer's 9-digit Headroom ID and a
  one-time code. The helper opens your account server's address in any browser, chooses **Connect with an ID**,
  and you click **Accept**, **View only** or **Decline**.
- Put the account server on the internet with Cloudflare Tunnel, Tailscale Funnel or a small VPS:
  [docs/RELAY.md](https://github.com/jamescolasacco/headroom/blob/master/docs/RELAY.md).

## Install

### Mac (macOS 13 or later, Apple silicon and Intel)

Paste this into Terminal:

```bash
curl -fsSL https://github.com/jamescolasacco/headroom/releases/latest/download/get-macos.sh | bash
```

That installs Headroom Server and Headroom Viewer into /Applications and starts Headroom Server in the menu bar. Allow **Screen Recording** and **Accessibility** when it asks. To install only the viewer, add `-s -- --only viewer` after `bash`.

Prefer to download it yourself? Get **Headroom-macOS.zip** below, unzip it, then run `bash install.sh` in Terminal from that folder. The apps aren't notarized by Apple, so opening them straight from a downloaded zip makes macOS refuse; `install.sh` clears that flag on the installed copies.

### Windows 10/11 (x64)

- **Headroom Server:** download **Headroom-Server-Windows-x64.zip**, extract it, then in that folder run `powershell -ExecutionPolicy Bypass -File install.ps1` (it asks for administrator rights). It installs a service, so the lock screen, sign-in screen, UAC prompts and Ctrl+Alt+Del work remotely.
- **Headroom Viewer:** download **Headroom-Viewer-Windows-x64.zip**, extract it, then run `powershell -ExecutionPolicy Bypass -File install-viewer.ps1` (no administrator rights needed).

The builds aren't code-signed, so SmartScreen may warn: choose **More info → Run anyway**.

### iPhone / iPad

No download: open your computer's Headroom address in Safari, then Share → Add to Home Screen. The [README](https://github.com/jamescolasacco/headroom#connecting-from-your-iphone--ipad) has the steps for trusting the computer's certificate (or use Tailscale).

## Connecting

- **Pairing:** Headroom Server → Pair a device shows a one-time code. In Headroom Viewer, add the computer by its address and enter the code.
- **Accounts and relay (optional):** run `node account-server/server.mjs` from the source (Node 20+; on a Mac, `tools/install-account-server-macos.sh` keeps it running) or its Docker image, put it behind HTTPS, join each computer in Headroom Server → Settings → Account, and sign in on your devices. See [docs/ACCOUNTS.md](https://github.com/jamescolasacco/headroom/blob/master/docs/ACCOUNTS.md) and [docs/RELAY.md](https://github.com/jamescolasacco/headroom/blob/master/docs/RELAY.md).

`SHA256SUMS.txt` lists the checksums of every download.
