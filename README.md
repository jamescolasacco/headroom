# Headroom

Self-hosted remote desktop for your own computers, in the spirit of RealVNC, Jump Desktop and Parsec.
No cloud and no subscriptions: pair each device with each computer, or run your own small account server and
sign in once to see all your computers in one list.

Like VNC Server + VNC Viewer, every device gets the half it needs:

| Device | Be controlled (server) | Control others (viewer) |
|---|---|---|
| **Windows** | **Headroom Server**: background service + tray icon + settings window | **Headroom Viewer**: desktop app; captures Win, Alt+Tab, PrtScn |
| **Mac** | **Headroom Server**: menu-bar app + settings window | **Headroom Viewer**: desktop app; captures ⌘Tab, ⌘Space, Mission Control, screenshots |
| **iPhone / iPad** | — | the web app, installed via Share → Add to Home Screen (no App Store or developer account) |

The same web client also runs in any modern browser, served by each Headroom Server (and by the optional
account server).

## Install

**Mac** (macOS 13+, Apple silicon or Intel): paste into Terminal:
```bash
curl -fsSL https://github.com/jamescolasacco/headroom/releases/latest/download/get-macos.sh | bash
```
It installs Headroom Server and Headroom Viewer into /Applications and starts Headroom Server; allow Screen
Recording and Accessibility when asked.

**Windows** (10/11, x64): download the Server and Viewer zips from the
[latest release](https://github.com/jamescolasacco/headroom/releases/latest), extract, and run `install.ps1`
(Server, as administrator) or `install-viewer.ps1` (Viewer).

**iPhone / iPad:** nothing to download, see [Connecting from your iPhone / iPad](#connecting-from-your-iphone--ipad).

To build from source instead, see [Build](#build).

## What you get

| | |
|---|---|
| **Video** | GPU capture (Windows: DXGI Desktop Duplication; Mac: ScreenCaptureKit) → GPU colour conversion → **hardware H.264** (Windows: NVENC / Quick Sync / AMF via Media Foundation; Mac: VideoToolbox in Apple's low-latency mode; software fallback on both) → **hardware decode in the browser** (WebCodecs). Measured at 1080p on an RTX 3070: about 3 ms encode, under 1 ms decode, 60 fps; on an M3 MacBook Air at 720p: 3–5 ms encode, 1 ms decode. Frames are sent only when the screen changes, with a few refinement frames so text goes sharp once things stop moving. |
| **Latency control** | No frame queues. The client acks each frame, and the host encodes only while the link has room. Bitrate adapts to measured delivery rate and queueing delay. The SPS declares zero frame reordering, so Safari and Chrome display each frame immediately. |
| **Cursor** | Drawn locally, so it moves with zero lag, using the host's real cursor shape (I-beam, resize arrows…). |
| **Keyboard** | Positional key codes, so every shortcut works with the host's layout. Profiles adapt to both ends: from a Mac or iPad to a **Windows** host, **Mac-style shortcuts** by default (⌘C/V/X/Z/A/S/F/T/W… act as Ctrl, ⌘Q → Alt+F4, ⌘ alone opens Start, ⌥←/→ jumps by word); to a **Mac** host, keys go as pressed (⌘ is ⌘), and from a PC, Ctrl acts as ⌘. Other profiles: "PC" and "⌘ = Ctrl". In Chrome/Edge full screen, **Alt+Tab, Win and Esc** go to the remote (Keyboard Lock). Caps Lock and Num Lock stay in sync, and keys never get stuck after a disconnect. |
| **Touch** (iPhone/iPad) | **Trackpad mode**: slide to move, tap to click, two-finger tap for right-click, tap-then-drag, hold-to-drag, two-finger scroll with momentum, pinch to zoom with cursor-follow. **Touch mode**: click where you touch. Apple Pencil and iPad trackpads/mice work too. |
| **On-screen keyboard** | The iOS keyboard (with dictation, emoji and predictive text), plus an **extra-keys bar**: Esc, Tab, Ctrl, Alt, Win (⌘ on a Mac host), Shift, arrows, F1–F12, Del/Home/End/PgUp/PgDn and Ctrl+Alt+Del (Force Quit on a Mac host). Modifiers are sticky: tap once for one key, tap twice to lock. |
| **Shortcuts menu** | Windows hosts: Ctrl+Alt+Del, Task Manager, Lock, Start, Alt+Tab, Task View, Show desktop, Explorer, Run, Settings, Snip, PrtScn and Alt+F4. Mac hosts: Force Quit, Activity Monitor, Lock screen, App switcher, Spotlight, Mission Control, screenshots, Close/Quit/Hide/Minimize and Emoji. "Type text" helps at login screens. |
| **Clipboard** | Text syncs both ways. Paste on your device pastes on the remote computer, and copying there lands in your device's clipboard; Safari is handled with gesture-privileged writes. There is also a manual clipboard panel. |
| **Files** | Browse the remote computer's folders and download files (resumable ranges); upload with a picker or by dragging onto the window (lands in Downloads). |
| **Audio** | System audio as Opus (Windows: WASAPI loopback; Mac: ScreenCaptureKit + AudioToolbox's encoder), with roughly 40 ms of buffering. |
| **Displays** | Pick or cycle monitors (Ctrl+Alt+Shift+1…9 / ←→). Fit, 1:1 or Fill scaling, a resolution cap (native/1440p/1080p/720p/"this screen"), and frame-rate and bandwidth limits. |
| **Service mode** (Windows) | Runs as a Windows service, so it works **at the sign-in screen, lock screen and UAC prompts**, starts before anyone logs in, and supports **real Ctrl+Alt+Del**. On a Mac, Headroom Server runs in your session (start it at login); the login window after a restart isn't reachable yet. |
| **Accounts** (optional) | Your own account server (one Node.js process or Docker container): sign in once with username, password and optional two-factor, and every computer in the account is listed and connects without pairing. Remove a device once and it loses access everywhere within seconds. Traffic still goes directly to each computer. |
| **Security** | TLS everywhere. Devices pair once (password, optional TOTP, or a one-time code) or sign in to an account; after that only a revocable 256-bit token is used, made for that one computer. Brute-force protection, view-only devices, loopback-only admin page, optional lock-on-disconnect. |
| **Resilience** | Auto-reconnect with backoff, recovery when the app returns from the background (iOS), keep-awake during sessions, and a decoder watchdog that falls back to software decoding. |

## Build

**Windows** needs the .NET 10 SDK, from https://dot.net or the per-user `dotnet-install.ps1`:
```bash
powershell -ExecutionPolicy Bypass -File tools\publish.ps1
```
That produces two self-contained folders, so target PCs don't need .NET installed:
`dist\Headroom` (Server) and `dist\HeadroomViewer` (Viewer).

**macOS** (13 Ventura or later) needs only the Swift command-line tools (`xcode-select --install`; Xcode isn't
required):
```bash
tools/build-macos.sh
```
That produces `dist/Headroom Server.app` and `dist/Headroom Viewer.app` (`--universal` for Intel + Apple
silicon). The first build fetches SwiftNIO, swift-nio-ssl and swift-certificates and takes a few minutes.

## Headroom Server (the PC you want to reach)

- **Install** (recommended). Run as administrator:
  ```bash
  powershell -ExecutionPolicy Bypass -File dist\Headroom\install.ps1
  ```
  It installs to `C:\Program Files\Headroom` and registers the `Headroom` service, which starts with
  Windows, works before anyone signs in, and can show and control **UAC prompts, the lock screen and
  Ctrl+Alt+Del**. It also adds a firewall rule for private networks, a Start-menu entry, and the tray
  icon at sign-in.
- **Or just try it:** run `dist\Headroom\HeadroomServer.exe`.
  - The tray app runs the server for you in "user mode", with no console window.
  - UAC prompts and the lock screen appear as a notice instead of video.
  - When Windows asks about the firewall, allow **Private networks**.

**The tray icon:**
- A green dot appears while someone is connected.
- Notifications pop up on connect and disconnect.
- The menu has: open, pair a device, copy address, disconnect everyone, start/stop, start with Windows.

**The settings window** has these sections:
- **Status:** connected viewers, with disconnect.
- **Pair a device:** a one-time code plus scannable QR codes.
- **Devices:** revoke, or make view-only.
- **Security:** password and authenticator-app 2FA.
- **Features:** clipboard, files, sound, remote control.
- **Quality:** encoder, frame rate, bitrate.
- **Connection:** Tailscale, certificate fingerprints.

The same panel is at http://localhost:7080/admin.html on that PC.

## Headroom Server (Mac)

```bash
tools/install-macos.sh          # add --cli to also put `headroom` on your PATH
```
- **Install:** copies both apps to `/Applications` (or `~/Applications`) and starts Headroom Server. It lives in
  the **menu bar**; turn on **Start at Login** from its menu.
- **Permissions:** macOS asks for two, and the Status page shows both with buttons to fix them:
  - **Screen Recording** (Privacy & Security → Screen & System Audio Recording): video and sound. macOS restarts
    the app after you turn it on.
  - **Accessibility** (Privacy & Security → Accessibility): mouse and keyboard control.
- **The menu-bar icon** shows a dot while someone is connected (notifications pop up on connect and disconnect)
  and has: open, pair a device, copy address, disconnect everyone, allow permissions, start/stop, start at login.
- **The settings window** is the same panel as on Windows (status, pairing with QR codes, devices, security,
  features, quality, connection), also at http://localhost:7080/admin.html on that Mac.
- **Firewall:** if the macOS firewall is on, allow incoming connections for Headroom Server when asked.
- **Locking:** "Lock this Mac when the last viewer disconnects" is in Security. The login window after a restart
  can't be shown yet (see the roadmap).

Data lives in `~/Library/Application Support/Headroom` (config and certificates, readable only by you) and logs
in `~/Library/Logs/Headroom`. `tools/uninstall-macos.sh [--purge]` removes everything.

## Headroom Viewer (Mac)

Installed by `tools/install-macos.sh` (or `--only viewer`). It works like the Windows viewer:
- **Adding a computer:** the first time, it shows the computer's **server key fingerprint**; compare it with
  Headroom Server → Connection, then trust it. The key is pinned for the viewer only: nothing goes into your
  keychain, and the pin survives certificate renewals.
- **System shortcuts:** while a session window is focused, **⌘Tab, ⌘Space, ⌃↑/⌃↓, ⌘⇧3/4/5 and ⌘Q/⌘W/⌘H** go to
  the remote computer, not your Mac. Use the menus (or Ctrl+Alt+Shift+Q) to close a session.
- **Windows and full screen:** each computer can open in its own window (computer menu → Open in new window);
  ⌃⌘F for full screen. Sound, clipboard sync, file downloads (to Downloads) and uploads work as in a browser.

## Headroom Viewer (Windows)

```bash
powershell -ExecutionPolicy Bypass -File dist\HeadroomViewer\install-viewer.ps1
```
- **Install:** per-user, no admin rights needed. It adds a Start-menu and desktop shortcut.
- **Adding a computer:** add it by address. The first time, the viewer shows that computer's **server key
  fingerprint**; compare it with Headroom Server → Connection, then confirm.
- **Certificate trust:** the viewer trusts that key for itself only. Nothing is installed into Windows'
  certificate store, and the key stays the same when the server renews its certificate.
- **Shortcuts:** while a session window is focused, **Win, Win+anything, Alt+Tab, Alt+F4, Ctrl+Esc and
  PrtScn go to the remote PC**. Ctrl+Alt+End sends Ctrl+Alt+Del.
- **Windows:** each computer can open in its own window (computer menu → Open in new window).

## Connecting from your iPhone / iPad

Browsers only decode video in hardware over HTTPS, so each device must trust the computer once. Pick one:

- **Tailscale (recommended, also works away from home):**
  1. Install Tailscale on the computer and the phone, and sign both into your tailnet.
  2. In the Tailscale admin console, turn on **MagicDNS** and **HTTPS Certificates**.
  3. Headroom fetches a real certificate automatically and prints `https://<computer>.<tailnet>.ts.net:7443/`.
  4. Open that address in Safari. No certificate install is needed.
- **Home network only (local certificate):** on the phone, open `http://<computer-ip>:7080/` in Safari and
  follow the steps:
  1. Download the profile.
  2. Install it under Settings → General → VPN & Device Management.
  3. Turn on Settings → General → About → Certificate Trust Settings → Headroom Local CA.
  4. Then open `https://<computer-ip>:7443/`.

Then install the app and pair:
1. In Safari, open the computer's `https://` address and tap **Share → Add to Home Screen**.
2. Open **Headroom** from your Home Screen. It finds the computer and asks to pair: enter the one-time code
   from Headroom Server → Pair a device (the password works too).

Pair *inside* the Home Screen app: iOS gives it its own storage, separate from Safari's, so a pairing made in
Safari doesn't carry over. Scanning the pairing QR code with the camera pairs Safari instead; that's handy if
you'd rather not install the app, and Safari shows the code to type into the app if you change your mind.

Sound needs iOS 26 or later (Safari's WebCodecs audio); on older versions everything else works, silently.

Tip: in the iPhone's Settings → Apps → Safari (or the home-screen app), allow "Paste from Other Apps" to
avoid paste prompts.

## Accounts (optional)

Pairing works computer by computer. With an account, each device signs in once and sees every computer:

1. Run the account server somewhere your devices can reach (a home server, a VPS, a Tailscale machine). It needs
   Node.js 20+ and nothing else:
   ```bash
   node account-server/server.mjs                # or: docker build -f account-server/Dockerfile -t headroom-accounts .
   ```
   The first account created is the owner's; after that, sign-up closes (`SIGNUP=open` to allow more, or
   `node account-server/server.mjs add-user <name>`). Give it HTTPS with a real certificate (`TLS_CERT`/`TLS_KEY`,
   `tailscale cert`, or a reverse proxy such as Caddy): the app can't reach a plain-HTTP server from an HTTPS page.
2. On each computer: Headroom Server → Settings → **Account** → sign in.
3. On each device: open Headroom (any Headroom Server's address, the account server's own address, or Headroom
   Viewer) → **Sign in to your account**.

Tap your account name to remove devices, make one view-only, turn on two-factor sign-in or change the password.
Pairing keeps working alongside. Details and the trust model: [docs/ACCOUNTS.md](docs/ACCOUNTS.md).

## Keyboard shortcuts in a session

| Keys | Action |
|---|---|
| Ctrl+Alt+Shift+M | show / hide the toolbar |
| Ctrl+Alt+Shift+F | full screen (Chrome/Edge also capture Alt+Tab / Win / Esc; hold Esc to leave) |
| Ctrl+Alt+Shift+S | performance overlay |
| Ctrl+Alt+Shift+R | capture the mouse (relative mode for games / 3D apps) |
| Ctrl+Alt+Shift+1…9, ←/→ | switch monitor |
| Ctrl+Alt+Shift+Q | disconnect |
| Ctrl+Alt+End | Ctrl+Alt+Del on the remote PC |

On iPad with a hardware keyboard, ⌘. sends Esc. Shortcuts that iPadOS or macOS reserve for themselves
(⌘Tab, ⌘Space) can't be captured by any web page; use the Shortcuts menu for those.

## Host commands

The same commands work on both platforms (`headroom.exe` on Windows; on a Mac, the `headroom` inside
`Headroom Server.app/Contents/MacOS`, linked onto your PATH by `install-macos.sh --cli`):
```bash
headroom                    # run in user mode (prints addresses + pairing code)
headroom set-password       # set the pairing password
headroom pair               # one-time pairing code (host must be running)
headroom devices            # list paired devices
headroom revoke <id>        # revoke a device
headroom service install    # service mode (admin, Windows)
headroom service uninstall  # remove the service (--purge also deletes pairings/certs) (Windows)
headroom permissions        # Screen Recording / Accessibility status; --request shows the prompts (Mac)
headroom selftest 5         # capture + encode test, writes an .h264 you can inspect with ffprobe
```

On Windows, data lives in `%ProgramData%\Headroom` (config, certificates and logs). In service mode, only SYSTEM
and Administrators can read it.

## Layout

```
host-windows/Headroom.Host/   C# / .NET 10 host
  Capture/   DXGI duplication (private device + keyed-mutex shared texture), monitors, cursor shapes
  Video/     D3D11 video processor (BGRA→NV12), Media Foundation H.264 encoder, SPS rewriter, pipeline
  Session/   WebSocket session: priority send queue, flow control, adaptive bitrate, input dispatch
  Input/     SendInput injection (scancodes / Unicode), desktop following for secure desktops
  Services/  clipboard, WASAPI→Opus audio, sessions/keep-awake
  Security/  pairing, tokens, TOTP, rate limiting, local CA + Tailscale certificates
  Service/   Windows service + session agent launcher (SYSTEM in the console session), installer
  Web/       Kestrel HTTPS/WSS server, file API, certificate trust page
host-windows/Headroom.Server/ HeadroomServer.exe: tray icon, notifications, settings window (WebView2)
viewer-windows/Headroom.Viewer/ HeadroomViewer.exe: WebView2 shell, pinned-key trust, system-shortcut hook
host-macos/                   Swift package (SwiftNIO + swift-nio-ssl + swift-certificates)
  Sources/HeadroomKit/        the engine, same structure as the Windows host:
    Capture/   ScreenCaptureKit per display, cursor tracker, synthetic test pattern
    Video/     VideoToolbox H.264 (low-latency mode), AVCC filtering, SPS rewriter, pipeline
    Session/   WebSocket session: flow control, adaptive bitrate, input dispatch
    Input/     CGEvent injection (W3C code → macOS virtual key codes)
    Services/  clipboard, ScreenCaptureKit audio → Opus, power, host info, permissions
    Security/  pairing, tokens, TOTP, rate limiting, local CA + Tailscale certificates
    Net/ Web/  HTTP/1.1 + WebSocket server on NIO with SNI certificate selection, file API, trust page
  Sources/headroom/           the CLI / engine executable (`headroom run`, `headroom agent`, …)
  Sources/HeadroomServer/     Headroom Server.app: menu-bar icon, notifications, settings window (WKWebView)
viewer-macos/                 Headroom Viewer.app: WKWebView shell, pinned-key trust, system-shortcut capture
web/                          the client (vanilla ES modules, no build step), also the PWA
  js/video/  worker decoder: VideoTrackGenerator→<video> on Safari, OffscreenCanvas elsewhere
  js/input/  keyboard (profiles, quirks), mouse, touch gestures, soft keyboard
account-server/               optional account server (Node.js, no dependencies): accounts, devices, per-computer keys
docs/PROTOCOL.md              wire protocol (the contract for other hosts)
docs/ACCOUNTS.md              accounts: setup, trust model, API
tools/                        publish / install / uninstall scripts (Windows .ps1, macOS .sh), icon generator,
                              protocol-check.mjs (headless end-to-end test of any host)
```

## Development

Run the host against the live `web/` folder with a separate data dir:
```bash
dotnet run --project host-windows/Headroom.Host -- run --data=.devdata --webroot=web
swift run --package-path host-macos headroom run --data=.devdata-mac --webroot=web
```
Then open http://localhost:7080/. Loopback counts as a secure context, so plain HTTP works on the PC
itself. Viewing the PC from itself mirrors the screen and disables audio to avoid feedback.

On a Mac, a host started from a terminal uses *the terminal's* Screen Recording and Accessibility permissions.

Development switches:
- `HEADROOM_BIND=loopback` keeps a dev host off the LAN, which also avoids firewall prompts.
- `HEADROOM_TEST_PATTERN=1` (or e.g. `1280x720`, Mac host) streams a synthetic display, so the whole pipeline
  runs without the Screen Recording permission.
- `HEADROOM_CLIENT=web` runs the Mac viewer (`swift run --package-path viewer-macos`) on the live client files.
- `HEADROOM_VIEWER_DATA=<dir>` gives the viewer a separate profile.
- `HEADROOM_CDP_PORT=<port>` exposes the Windows viewer's page over the Chrome DevTools Protocol for scripted tests;
  `HEADROOM_DEVTOOLS=1` makes the Mac viewer's page inspectable in Safari.

`node tools/protocol-check.mjs` (run on the host) pairs a throwaway device, streams video, checks keyframes,
epochs, acks, pings and stats, and validates the received H.264 with ffprobe. It works against either host.

## Roadmap

- **Mac login window:** a LaunchDaemon helper so a Mac can be reached after a restart, before anyone logs in
  (the counterpart of Windows service mode).
- Signed and notarized Mac builds (stable permissions across updates), and a Windows/Mac installer UI.
- A virtual display sized to the iPad, HEVC / 4:4:4 "sharp text" mode, and WebTransport for lossy
  networks.

## License

MIT. See [LICENSE](LICENSE).
