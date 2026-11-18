Remote desktop for your own computers, and quick help with a code: **Headroom Server** on the computer you want to reach; **Headroom Viewer**, any browser, or an iPhone/iPad on the device you use.

## New in 0.4.1: a new look, and everything easier to use

- **A new look** for the website and Headroom Server's window: a quiet studio console at night, warm paper by day, and type designed so codes can't be misread (0/O, 1/l/I). Colour now only means something: green is ready, amber means a person is connected or asking, red is stop. See [DESIGN.md](https://github.com/jamescolasacco/headroom/blob/master/DESIGN.md).
- **Accepting someone is unmistakable:** a warning card with their (unverified) name and rough location, the scam warning at full size, and the same Accept · View only · Decline order on Mac, Windows and in the window, with Decline as the strong button.
- **You see what happened:** messages now appear on every screen (and screen readers hear them), errors sit next to the field that's wrong, "Send a new code" really sends one, and deleting your account ends with a clear confirmation.
- **Simpler Account page:** one row per task — password, two-factor, email, delete.
- **Keyboard and screen readers:** the Server window no longer drops your place every two seconds; every switch and menu is named; in a session, Ctrl+Alt+Shift+M takes you to the toolbar and Escape back to the remote screen.
- **Safer codes:** **Decline** now also ends the code, so the same code can't ask again (make a new one for the right person). Return and Esc decline in the Mac and Windows prompts. Guests must give a name, and once let in they're told "You're connected… they can stop this at any time".
- **Clear endings:** when the person at the computer stops a session (or its sign-in is removed, or Headroom Server quits), the other side sees why, instead of "Reconnecting…".
- **Smaller fixes:** a "Get Headroom Server" button when you have no devices yet, a "View only" lamp for guests who can watch but not control, phone layouts that fit with 44-pixel targets, pinch-zoom allowed again, and less motion when your system asks for it. Signing out no longer undoes itself, the Server window keeps your place in every section, and the session's option panels keep keyboard focus inside them.

## New in 0.4: one account for your devices, and codes for everyone else

- **Your devices, signed in with your email.** Create an account at https://relay.colasac.co (email, password, and a code we email you). Sign in with it in Headroom Server on each computer and it's one of your devices, listed even while it's off. Sign in at the website or in Headroom Viewer and click a computer to connect, from anywhere. No addresses, no pairing, no port forwarding. Rename a computer in Headroom Server.
- **Let someone connect.** Headroom Server → *Let someone connect* gives a 9-digit code and a link. The other person enters it in their browser — no account, nothing to install. Your computer always asks first: it shows the name they typed (marked as not verified), roughly where they are, and a warning about support scams. **Accept**, **View only** or **Decline**; file transfer and clipboard are off unless you tick them. A bar at the top of your screen shows who's connected, with **Stop**, and you can switch their control, files and clipboard while they're connected. Works on computers that aren't signed in to an account too.
- **Account security:** email verification, "Forgot password?" by emailed code, a human check against bots, optional two-factor sign-in, an email for every new sign-in, *Where you're signed in* with Sign out for each, change email, delete account.
- **Simpler apps.** Headroom Server's window has four sections: Home, Let someone connect, Account, Settings. The website is a code box and a sign-in when signed out, and your devices when signed in.
- **Removed:** pairing (passwords, pairing codes, QR codes), adding computers by address, Headroom IDs, the people/invites page, and computers serving their own web pages and certificate pages. Old pairings and username accounts don't carry over: sign in again with an email.

**Running your own server:** `git pull && sudo tools/install-account-server-linux.sh --url https://your.domain`, then add your Resend and Turnstile keys to `/etc/headroom-accounts.env`. The old username database is set aside and the server starts fresh. See [docs/ACCOUNTS.md](https://github.com/jamescolasacco/headroom/blob/master/docs/ACCOUNTS.md).

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

### iPhone / iPad, or any browser

Nothing to install: open https://relay.colasac.co. In Safari, Share → Add to Home Screen gives a full-screen app.

`SHA256SUMS.txt` lists the checksums of every download.
