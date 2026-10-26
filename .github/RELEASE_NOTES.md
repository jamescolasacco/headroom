Self-hosted remote desktop for your own computers: **Headroom Server** on the computer you want to reach, **Headroom Viewer** (or the iPhone/iPad web app) on the device you use. Pair devices one by one, or run your own small account server and sign in once.

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
- **Accounts (optional):** run `node account-server/server.mjs` from the source (Node 20+) or its Docker image, put it behind HTTPS, join each computer in Headroom Server → Settings → Account, and sign in on your devices. See [docs/ACCOUNTS.md](https://github.com/jamescolasacco/headroom/blob/master/docs/ACCOUNTS.md).

`SHA256SUMS.txt` lists the checksums of every download.
