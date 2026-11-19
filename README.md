# Headroom

Remote desktop for your own computers, and quick help with a code, in the spirit of RealVNC and AnyDesk.
Open source, and you can run the whole service yourself.

- **Your devices:** sign in with your email on each computer (Headroom Server) and it joins your account. Sign in
  at the Headroom website or in Headroom Viewer on any device and every one of your computers is listed: click one
  to connect, from anywhere. No addresses, no pairing, no port forwarding.
- **Let someone connect:** on the computer, click *Let someone connect* and give them the 9-digit code (or the
  link). They enter it in their browser — no account, nothing to install — and you click **Accept** and choose
  what they can do.

| Device | Be reached (server) | Reach others (viewer) |
|---|---|---|
| **Windows** | **Headroom Server**: background service + tray icon + window | **Headroom Viewer** desktop app (captures Win, Alt+Tab, PrtScn), or any browser |
| **Mac** | **Headroom Server**: menu-bar app + window | **Headroom Viewer** desktop app (captures ⌘Tab, ⌘Space, Mission Control), or any browser |
| **iPhone / iPad** | — | the website, installed via Share → Add to Home Screen (no App Store) |

The public service runs at **https://relay.colasac.co** (the apps use it unless you set another); the same server
is in this repository for running your own.

## Install

Everything is on the [latest release](https://github.com/jamescolasacco/headroom/releases/latest), and updates
itself afterwards (see [Updates](#updates)).

**Mac** (macOS 13+, Apple silicon or Intel): download **Headroom-macOS.dmg**, open it and drag both apps onto
Applications, then open Headroom Server. Headroom isn't notarized by Apple, so the first time macOS says it can't
check it: click Done, then **System Settings → Privacy & Security → Open Anyway** (once per app). Allow Screen
Recording and Accessibility when Headroom Server asks. (Or in Terminal, without the Open Anyway step:
`curl -fsSL https://github.com/jamescolasacco/headroom/releases/latest/download/get-macos.sh | bash`.)

**Windows** (10/11, x64): download and run **Headroom-Server-Setup.exe** on the PC you want to reach, and
**Headroom-Viewer-Setup.exe** where you connect from. They aren't code-signed, so Windows may say it protected
your PC: More info → Run anyway.

**iPhone / iPad, or any browser:** nothing to install. Open https://relay.colasac.co.

To build from source instead, see [Build](#build).

## Using it

1. **Create an account** at https://relay.colasac.co (email and password; we email you a code to confirm).
2. **On each computer** you want to reach: Headroom Server → **Account** → sign in with that email. It shows up in
   your list, named after the computer (rename it there).
3. **On any device:** sign in at the website or in Headroom Viewer and click a computer. Your own devices connect
   straight away; nobody has to accept.

**Helping someone, or being helped:** the person at the computer opens Headroom Server → **Let someone connect** →
*Create a code* and reads out the code or sends the link. The helper opens the website, types the code under
**Got a code?** and their name. The computer shows who is asking (the name is not verified) and roughly where
from, with a warning about scams; **Accept**, **View only** or **Decline**. File transfer and clipboard sharing
are off unless ticked. While anyone is connected, a bar at the top of the screen says who, with **Stop**.
A code works for one person, for 10 minutes, and computers that aren't signed in to an account can use codes too.

Account security: optional two-factor sign-in (authenticator app), an email for every new sign-in, *Where you're
signed in* with Sign out for each, password reset by email code, change email, delete account. Details:
[docs/ACCOUNTS.md](docs/ACCOUNTS.md).

## What you get

| | |
|---|---|
| **Video** | GPU capture (Windows: DXGI Desktop Duplication; Mac: ScreenCaptureKit) → GPU colour conversion → **hardware H.264** (Windows: NVENC / Quick Sync / AMF via Media Foundation; Mac: VideoToolbox in Apple's low-latency mode; software fallback on both) → **hardware decode in the browser** (WebCodecs). Measured at 1080p on an RTX 3070: about 3 ms encode, under 1 ms decode, 60 fps; on an M3 MacBook Air at 720p: 3–5 ms encode, 1 ms decode. Frames are sent only when the screen changes, with a few refinement frames so text goes sharp once things stop moving. |
| **Latency control** | No frame queues. The client acks each frame, and the host encodes only while the link has room. Bitrate adapts to measured delivery rate and queueing delay. The SPS declares zero frame reordering, so Safari and Chrome display each frame immediately. |
| **Cursor** | Drawn locally, so it moves with zero lag, using the host's real cursor shape (I-beam, resize arrows…). |
| **Keyboard** | Positional key codes, so every shortcut works with the host's layout. Profiles adapt to both ends: from a Mac or iPad to a **Windows** host, **Mac-style shortcuts** by default (⌘C/V/X/Z/A/S/F/T/W… act as Ctrl, ⌘Q → Alt+F4, ⌘ alone opens Start, ⌥←/→ jumps by word); to a **Mac** host, keys go as pressed (⌘ is ⌘), and from a PC, Ctrl acts as ⌘. Other profiles: "PC" and "⌘ = Ctrl". In Chrome/Edge full screen, **Alt+Tab, Win and Esc** go to the remote (Keyboard Lock). Caps Lock and Num Lock stay in sync, and keys never get stuck after a disconnect. |
| **Touch** (iPhone/iPad) | The same gestures as Microsoft Remote Desktop, and clicks go out the moment your finger lifts. **Trackpad mode** (its mouse pointer mode): slide to move, tap to click (tap tap to double-click, tap tap tap to triple-click), then touch and drag to drag with that click (in text: by character, word or paragraph), two-finger tap or tap and hold to right-click (then touch and drag with two fingers: a right-click drag), two-finger scroll with momentum, pinch to zoom with cursor-follow. **Touch mode** (its direct touch): click where you touch. Apple Pencil and iPad trackpads/mice work too. |
| **On-screen keyboard** | The iOS keyboard (with dictation, emoji and predictive text), plus an **extra-keys bar**: Esc, Tab, Ctrl, Alt, Win (⌘ on a Mac host), Shift, arrows, F1–F12, Del/Home/End/PgUp/PgDn and Ctrl+Alt+Del (Force Quit on a Mac host). Keys press on a tap, so swiping along the bar just scrolls it. Modifiers are sticky: tap for the next key or click (tap again to cancel), double-tap to lock until you tap it off. **What you type shows just above the keys** while you type (shortcuts as keys, like ⌃C), and starts over when you click, press Enter or an arrow key, or close the keyboard; the eye at the end of the bar turns it off. |
| **Toolbar** | On phones and tablets it sits at the bottom, in reach of your thumb, and folds away to a small tab; while the keyboard is up, the keys bar takes its place. With a mouse it hides at the top edge and comes back when you point there (the bottom edge is the computer's own taskbar or Dock). |
| **Shortcuts menu** | Windows hosts: Ctrl+Alt+Del, Task Manager, Lock, Start, Alt+Tab, Task View, Show desktop, Explorer, Run, Settings, Snip, PrtScn and Alt+F4. Mac hosts: Force Quit, Activity Monitor, Lock screen, App switcher, Spotlight, Mission Control, screenshots, Close/Quit/Hide/Minimize and Emoji. "Type text" helps at login screens. |
| **Clipboard** | Text syncs both ways (for guests only if you allow it). Safari is handled with gesture-privileged writes. There is also a manual clipboard panel. |
| **Files** | Browse the remote computer's folders and download files (resumable ranges); upload with a picker or by dragging onto the window (lands in Downloads). For guests only if you allow it. |
| **Audio** | System audio as Opus (Windows: WASAPI loopback; Mac: ScreenCaptureKit + AudioToolbox's encoder), with roughly 40 ms of buffering. |
| **Displays** | Pick or cycle monitors (Ctrl+Alt+Shift+1…9 / ←→). Fit, 1:1 or Fill scaling, resolution (Auto: as big as the picture is shown, or native/1440p/1080p/720p), and frame-rate and bandwidth limits. |
| **Service mode** (Windows) | Runs as a Windows service, so it works **at the sign-in screen, lock screen and UAC prompts**, starts before anyone logs in, and supports **real Ctrl+Alt+Del**. On a Mac, Headroom Server runs in your session (start it at login); the login window after a restart isn't reachable yet. |
| **From anywhere** | Computers keep an outbound connection to the relay, so browsers reach them on any network with no port forwarding, VPN or certificate install. Headroom Viewer connects directly when it's on the same network. |
| **Security** | HTTPS/TLS on every connection. Accounts: scrypt password hashing, breached-password check, rate limiting, optional TOTP, sign-in alerts, enumeration-safe answers, Turnstile against bots. Each sign-in gets a revocable key made for each computer alone; signing out cuts it off everywhere within seconds. Guests: the code's last 5 digits are checked only on the computer, 5 wrong tries end it, and nobody gets in without Accept. Sessions through the relay are encrypted on both legs (end-to-end encryption is next on the roadmap). |
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

## Headroom Server (Windows)

- **Install** (recommended): the release's **Headroom-Server-Setup.exe** (`tools/windows-installer`, built by the
  release workflow with Inno Setup), or from a build, as administrator:
  ```bash
  powershell -ExecutionPolicy Bypass -File dist\Headroom\install.ps1
  ```
  It installs to `C:\Program Files\Headroom` and registers the `Headroom` service, which starts with
  Windows, works before anyone signs in, and can show and control **UAC prompts, the lock screen and
  Ctrl+Alt+Del**. It also adds a Start-menu entry and the tray icon at sign-in.
- **Or just try it:** run `dist\Headroom\HeadroomServer.exe`. The tray app runs the server for you in "user mode";
  UAC prompts and the lock screen appear as a notice instead of video.

## Headroom Server (Mac)

```bash
tools/install-macos.sh          # add --cli to also put `headroom` on your PATH
```
- **Install:** copies both apps to `/Applications` (or `~/Applications`) and starts Headroom Server. It lives in
  the **menu bar**; turn on **Start at login** in its Settings. When the menu bar is too full to show its icon
  (macOS hides icons that don't fit beside a MacBook's notch), it keeps a **Dock** icon instead while it runs:
  click it for the window, or right-click it for the same quick actions.
- **Permissions:** macOS asks for two, and the window shows both with buttons to fix them:
  - **Screen Recording** (Privacy & Security → Screen & System Audio Recording): video and sound. macOS restarts
    the app after you turn it on.
  - **Accessibility** (Privacy & Security → Accessibility): mouse and keyboard control.
- **Locking:** "Lock this Mac when the last person disconnects" is in Settings. The login window after a restart
  can't be shown yet (see the roadmap).

Data lives in `~/Library/Application Support/Headroom` (config and certificates, readable only by you) and logs
in `~/Library/Logs/Headroom`. `tools/uninstall-macos.sh [--purge]` removes everything.

**On both**, the window has four sections: **Home** (who's connected, with Stop, and for guests their control,
files and clipboard switches; **Stop server**, and **Start server** once it's stopped: while stopped nobody can
connect, but the window works as usual), **Let someone connect** (codes), **Account** (sign in, this computer's name) and
**Settings** (start at login, what your devices may do, quality, permissions). The tray / menu-bar icon has the
same essentials, and the Accept prompt appears there.

## Headroom Viewer (Mac and Windows)

Sign in once; your computers are listed, online first. On the same network it connects directly (trusting the
computer's key as vouched for by your account), otherwise through the relay. "Got a code?" works here too.
- **Mac:** while a session window is focused, **⌘Tab, ⌘Space, ⌃↑/⌃↓, ⌘⇧3/4/5 and ⌘Q/⌘W/⌘H** go to the remote
  computer, not your Mac. Use the menus (or Ctrl+Alt+Shift+Q) to close a session.
- **Windows:** per-user install, no admin rights (`dist\HeadroomViewer\install-viewer.ps1`). While a session
  window is focused, **Win, Win+anything, Alt+Tab, Alt+F4, Ctrl+Esc and PrtScn go to the remote PC**.
  Ctrl+Alt+End sends Ctrl+Alt+Del.
- Each computer can open in its own window (the arrow button next to it).

## Updates

Headroom Server and Headroom Viewer check for a new release every few hours and download it in the background.
When it's ready they say so (a notification, the menu-bar or tray menu, and the window): **Restart to update**
quits, swaps in the new version and opens it again in a few seconds. Nothing restarts by itself, so a computer
you're reaching from far away never drops out from under you. On Windows, Headroom Server's update asks for
administrator permission once (it replaces Program Files and restarts the service).

An update is installed only when it checks out: the release's checksum list must be signed with Headroom's
certificate (`assets/headroom-signing.cer`), every file must match it, and on a Mac the new apps must be signed
with that same certificate. That signature is also what lets macOS keep Screen Recording and Accessibility, and
firewalls like Little Snitch keep their rules, from one version to the next.

Forks: run `tools/make-signing-cert.sh` once (it makes your own certificate and saves it as the GitHub secrets
`MACOS_SIGN_P12` and `MACOS_SIGN_PASSWORD`; commit the `assets/headroom-signing.cer` it writes), and build with
`HEADROOM_UPDATE_REPO=you/repo` (Mac) / `-p:HeadroomUpdateRepo=you/repo` (Windows) so the apps look at your releases.

## iPhone / iPad

Open https://relay.colasac.co in Safari, sign in (or enter a code), then **Share → Add to Home Screen** for a
full-screen app. The Home Screen app has its own storage, so sign in again inside it. Sound needs iOS 26 or later
(Safari's WebCodecs audio). Tip: allow "Paste from Other Apps" for Safari (or the home-screen app) in Settings to
avoid paste prompts.

## Running your own server

The account server and relay is one Node.js file with no dependencies (`account-server/server.mjs`). On a Linux
server or VPS (systemd), behind HTTPS (Cloudflare Tunnel, Caddy, nginx):
```bash
sudo tools/install-account-server-linux.sh --url https://relay.example.com
```
Then put your [Resend](https://resend.com) API key and sender address, and your Cloudflare Turnstile keys, in
`/etc/headroom-accounts.env` and `sudo systemctl restart headroom-accounts`. Moderation from the command line:
`sudo headroom-accounts list-users` (also `disable-user`, `enable-user`, `reset-2fa`, `delete-user`). Point the
apps at it: `DEFAULT_ACCOUNT_SERVER` in `web/js/config.js`, and `"server"` in each Headroom Server's config.json.
See [docs/ACCOUNTS.md](docs/ACCOUNTS.md) and [docs/RELAY.md](docs/RELAY.md).

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
headroom                    # run in user mode
headroom service install    # service mode (admin, Windows)
headroom service uninstall  # remove the service (--purge also deletes settings/certs) (Windows)
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
  Security/  session tokens, rate limiting, local CA + Tailscale certificates
  Service/   Windows service + session agent launcher (SYSTEM in the console session), installer
  Web/       Kestrel HTTPS/WSS server, file API, settings API
host-windows/Headroom.Server/ HeadroomServer.exe: tray icon, notifications, settings window (WebView2)
update-windows/Updater.cs     updates for HeadroomServer.exe and HeadroomViewer.exe (one file, in both)
viewer-windows/Headroom.Viewer/ HeadroomViewer.exe: WebView2 shell, pinned-key trust, system-shortcut hook
host-macos/                   Swift package (SwiftNIO + swift-nio-ssl + swift-certificates)
  Sources/HeadroomKit/        the engine, same structure as the Windows host:
    Capture/   ScreenCaptureKit per display, cursor tracker, synthetic test pattern
    Video/     VideoToolbox H.264 (low-latency mode), AVCC filtering, SPS rewriter, pipeline
    Session/   WebSocket session: flow control, adaptive bitrate, input dispatch
    Input/     CGEvent injection (W3C code → macOS virtual key codes)
    Services/  clipboard, ScreenCaptureKit audio → Opus, power, host info, permissions
    Security/  session tokens, rate limiting, local CA + Tailscale certificates
    Net/ Web/  HTTP/1.1 + WebSocket server on NIO, relay connection, file API, settings API
  Sources/headroom/           the CLI / engine executable (`headroom run`, `headroom agent`, …)
  Sources/HeadroomServer/     Headroom Server.app: menu-bar icon, notifications, settings window (WKWebView)
viewer-macos/                 Headroom Viewer.app: WKWebView shell, pinned-key trust, system-shortcut capture
update-macos/                 updates for both Mac apps (Swift package, no dependencies) and its test harness
web/                          the client (vanilla ES modules, no build step), also the PWA
  js/video/  worker decoder: VideoTrackGenerator→<video> on Safari, OffscreenCanvas elsewhere
  js/input/  keyboard (profiles, quirks), mouse, touch gestures, soft keyboard
account-server/               the account server and relay (Node.js, no dependencies): accounts, devices, guest codes
docs/PROTOCOL.md              wire protocol (the contract for other hosts)
docs/ACCOUNTS.md              accounts: setup, trust model, API
docs/RELAY.md                 the relay, guest codes, putting the server on the internet
tools/                        publish / install / uninstall scripts (Windows .ps1, macOS .sh), icon generator,
                              protocol-check.mjs, account-check.mjs and stream-check.mjs (headless end-to-end
                              tests of any host)
```

## Development

Run the host against the live `web/` folder with a separate data dir:
```bash
dotnet run --project host-windows/Headroom.Host -- run --data=.devdata --webroot=web
swift run --package-path host-macos headroom run --data=.devdata-mac --webroot=web
```
Then open http://localhost:7080/ for the window. Run the account server too (`DEV_MAIL=1 node account-server/server.mjs`,
then `"server": "http://127.0.0.1:8780"` in the dev data dir's config.json) and open http://localhost:8780/ for the
website; with `DEV_MAIL=1`, emailed codes are at `/api/dev/mail?to=<email>`.

On a Mac, a host started from a terminal uses *the terminal's* Screen Recording and Accessibility permissions.

Development switches:
- `HEADROOM_BIND=loopback` keeps a dev host off the LAN, which also avoids firewall prompts.
- `HEADROOM_TEST_PATTERN=1` (or e.g. `1280x720`, Mac host) streams a synthetic display, so the whole pipeline
  runs without the Screen Recording permission.
- `HEADROOM_CLIENT=web` runs the Mac viewer (`swift run --package-path viewer-macos`) on the live client files.
- `HEADROOM_VIEWER_DATA=<dir>` gives the viewer a separate profile.
- `HEADROOM_CDP_PORT=<port>` exposes the Windows viewer's page over the Chrome DevTools Protocol for scripted tests;
  `HEADROOM_DEVTOOLS=1` makes the Mac viewer's page inspectable in Safari.

`node tools/protocol-check.mjs` (run on the host) connects as a guest with a code through the relay, accepts
itself, streams video, checks keyframes, epochs, acks, pings, stats, permission changes, resuming and Stop, and
validates the received H.264 with ffprobe. `node tools/account-check.mjs` signs the host in to an account and
connects through the relay as one of your devices. `node tools/stream-check.mjs` measures what a viewer gets:
frame rate, bitrate and the host's target, delay, resolution and the encoder's QP (with ffmpeg), optionally on
a simulated longer path (`--ack-delay`, `--link-kbps`); the Mac host started with `--test-pattern` and
`HEADROOM_TEST_PATTERN_STYLE=desktop` shows a scrolling page of text instead of colour bars. All three work against
either host.

## Roadmap

- **End-to-end encryption** of sessions through the relay (keys only on the two ends; for guests, proven by the
  code), so the relay can't see them.
- **Mac login window:** a LaunchDaemon helper so a Mac can be reached after a restart, before anyone logs in
  (the counterpart of Windows service mode).
- Notarized Mac builds (an Apple Developer ID: no "unidentified developer" on first install), and an installer UI.
- A virtual display sized to the iPad, HEVC / 4:4:4 "sharp text" mode, and WebTransport for lossy
  networks.

## License

MIT. See [LICENSE](LICENSE).
