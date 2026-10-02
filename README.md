# Headroom

Self-hosted remote desktop for your own computers, in the spirit of RealVNC, Jump Desktop and Parsec.
It has no accounts, no cloud and no subscriptions.

Like VNC Server + VNC Viewer, every device gets the half it needs:

| Device | Be controlled (server) | Control others (viewer) |
|---|---|---|
| **Windows** | **Headroom Server**: background service + tray icon + settings window | **Headroom Viewer**: desktop app; captures Win, Alt+Tab, PrtScn |
| **Mac** | *next*: menu-bar app ([protocol](docs/PROTOCOL.md) is ready) | the web app in Safari/Chrome today; native viewer *next* |
| **iPhone / iPad** | — | the web app, installed via Share → Add to Home Screen (no App Store or developer account) |

The same web client also runs in any modern browser, served by each Headroom Server.

## What you get

| | |
|---|---|
| **Video** | GPU capture (DXGI Desktop Duplication) → GPU colour conversion → **hardware H.264** (NVENC / Quick Sync / AMF via Media Foundation, software fallback) → **hardware decode in the browser** (WebCodecs). Measured on an RTX 3070 at 1080p: about 3 ms encode, under 1 ms decode, 60 fps. Frames are sent only when the screen changes, with a few refinement frames so text goes sharp once things stop moving. |
| **Latency control** | No frame queues. The client acks each frame, and the host encodes only while the link has room. Bitrate adapts to measured delivery rate and queueing delay. The SPS declares zero frame reordering, so Safari and Chrome display each frame immediately. |
| **Cursor** | Drawn locally, so it moves with zero lag, using the host's real cursor shape (I-beam, resize arrows…). |
| **Keyboard** | Positional scancodes, so every shortcut works with the host's layout. **Mac-style shortcuts** by default on Apple devices: ⌘C/V/X/Z/A/S/F/T/W… act as Ctrl, ⌘Q → Alt+F4, ⌘ alone opens Start, ⌥←/→ jumps by word. Other profiles: "PC" and "⌘ = Ctrl". In Chrome/Edge full screen, **Alt+Tab, Win and Esc** go to the remote (Keyboard Lock). Caps Lock and Num Lock stay in sync, and keys never get stuck after a disconnect. |
| **Touch** (iPhone/iPad) | **Trackpad mode**: slide to move, tap to click, two-finger tap for right-click, tap-then-drag, hold-to-drag, two-finger scroll with momentum, pinch to zoom with cursor-follow. **Touch mode**: click where you touch. Apple Pencil and iPad trackpads/mice work too. |
| **On-screen keyboard** | The iOS keyboard (with dictation, emoji and predictive text), plus an **extra-keys bar**: Esc, Tab, Ctrl, Alt, Win, Shift, arrows, F1–F12, Del/Home/End/PgUp/PgDn and Ctrl+Alt+Del. Modifiers are sticky: tap once for one key, tap twice to lock. |
| **Shortcuts menu** | Ctrl+Alt+Del, Task Manager, Lock, Start, Alt+Tab, Task View, Show desktop, Explorer, Run, Settings, Snip, PrtScn and Alt+F4. "Type text" helps at login screens. |
| **Clipboard** | Text syncs both ways. Paste on your device pastes on the PC, and copying on the PC lands in your device's clipboard; Safari is handled with gesture-privileged writes. There is also a manual clipboard panel. |
| **Files** | Browse the PC's folders and download files; upload with a picker or by dragging onto the window (lands in Downloads). |
| **Audio** | System audio via WASAPI loopback and Opus, with roughly 40 ms of buffering. |
| **Displays** | Pick or cycle monitors (Ctrl+Alt+Shift+1…9 / ←→). Fit, 1:1 or Fill scaling, a resolution cap (native/1440p/1080p/720p/"this screen"), and frame-rate and bandwidth limits. |
| **Service mode** | Runs as a Windows service, so it works **at the sign-in screen, lock screen and UAC prompts**, starts before anyone logs in, and supports **real Ctrl+Alt+Del**. |
| **Security** | TLS everywhere. Devices pair once (password, optional TOTP, or a one-time code); after that only a revocable 256-bit device token is used. Brute-force protection, view-only devices, loopback-only admin page, optional lock-on-disconnect. |
| **Resilience** | Auto-reconnect with backoff, recovery when the app returns from the background (iOS), keep-awake during sessions, and a decoder watchdog that falls back to software decoding. |

## Build

This needs the .NET 10 SDK, from https://dot.net or the per-user `dotnet-install.ps1`:
```bash
powershell -ExecutionPolicy Bypass -File tools\publish.ps1
```
That produces two self-contained folders, so target PCs don't need .NET installed:
`dist\Headroom` (Server) and `dist\HeadroomViewer` (Viewer).

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

Browsers only decode video in hardware over HTTPS, so each device must trust the PC once. Pick one:

- **Tailscale (recommended, also works away from home):**
  1. Install Tailscale on the PC and the phone, and sign both into your tailnet.
  2. In the Tailscale admin console, turn on **MagicDNS** and **HTTPS Certificates**.
  3. Headroom fetches a real certificate automatically and prints `https://<pc>.<tailnet>.ts.net:7443/`.
  4. Open that address in Safari. No certificate install is needed.
- **Home network only (local certificate):** on the phone, open `http://<pc-ip>:7080/` in Safari and
  follow the steps:
  1. Download the profile.
  2. Install it under Settings → General → VPN & Device Management.
  3. Turn on Settings → General → About → Certificate Trust Settings → Headroom Local CA.
  4. Then open `https://<pc-ip>:7443/`.

Then **pair**: in Headroom Server → Pair a device, scan the QR code with the phone's camera, or type the
one-time code (the password works too). Finally, in Safari tap **Share → Add to Home Screen** to get a
full-screen app.

Tip: in the iPhone's Settings → Apps → Safari (or the home-screen app), allow "Paste from Other Apps" to
avoid paste prompts.

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

```bash
headroom                    # run in user mode (prints addresses + pairing code)
headroom set-password       # set the pairing password
headroom pair               # one-time pairing code (host must be running)
headroom devices            # list paired devices
headroom revoke <id>        # revoke a device
headroom service install    # service mode (admin)
headroom service uninstall  # remove the service (--purge also deletes pairings/certs)
headroom selftest 5         # capture + encode test, writes an .h264 you can inspect with ffprobe
```

Data lives in `%ProgramData%\Headroom` (config, certificates and logs). In service mode, only SYSTEM and
Administrators can read it.

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
web/                          the client (vanilla ES modules, no build step), also the PWA
  js/video/  worker decoder: VideoTrackGenerator→<video> on Safari, OffscreenCanvas elsewhere
  js/input/  keyboard (profiles, quirks), mouse, touch gestures, soft keyboard
docs/PROTOCOL.md              wire protocol (the contract for other hosts)
tools/                        publish / install / uninstall scripts, icon generator
```

## Development

Run the host against the live `web/` folder with a separate data dir:
```bash
dotnet run --project host-windows/Headroom.Host -- run --data=.devdata --webroot=web
```
Then open http://localhost:7080/. Loopback counts as a secure context, so plain HTTP works on the PC
itself. Viewing the PC from itself mirrors the screen and disables audio to avoid feedback.

Development switches:
- `HEADROOM_BIND=loopback` keeps a dev host off the LAN, which also avoids firewall prompts.
- `HEADROOM_VIEWER_DATA=<dir>` gives the viewer a separate profile.
- `HEADROOM_CDP_PORT=<port>` exposes the viewer's page over the Chrome DevTools Protocol for scripted tests.

## Roadmap

- **macOS Server + Viewer:**
  - Server: menu-bar app on ScreenCaptureKit + VideoToolbox + CGEvent; needs the Screen Recording and
    Accessibility permissions. It implements [docs/PROTOCOL.md](docs/PROTOCOL.md).
  - Viewer: WKWebView shell with an event tap for ⌘Tab and friends.
- A virtual display sized to the iPad, HEVC / 4:4:4 "sharp text" mode, and WebTransport for lossy
  networks.
