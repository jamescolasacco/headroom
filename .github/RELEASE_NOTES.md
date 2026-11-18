Remote desktop for your own computers, and quick help with a code: **Headroom Server** on the computer you want to reach; **Headroom Viewer**, any browser, or an iPhone/iPad on the device you use.

## New in 0.4.3: download, install, and it keeps itself up to date

- **Real installers.** On a Mac, open **Headroom-macOS.dmg** and drag both apps to Applications. On Windows, run **Headroom-Server-Setup.exe** and **Headroom-Viewer-Setup.exe**. No Terminal, no PowerShell.
- **It updates itself.** Headroom Server and Headroom Viewer check for a new version every few hours and download it in the background. When it's ready they tell you (a notification, the menu-bar or tray menu, and the window); **Restart to update** swaps it in and opens it again in a few seconds. Nothing restarts on its own, so a computer you're reaching from far away never drops out from under you.
- **Permissions stay put.** Every Mac build is now signed with Headroom's own certificate, so macOS keeps Screen Recording and Accessibility (and Little Snitch keeps its rules) across updates.
- **Only real updates get in.** An update is installed only if its checksums are signed with Headroom's certificate, every file matches, and on a Mac the new app carries the same signature. On Windows, Headroom Server's update asks for administrator permission once (it replaces Program Files and restarts the service).
- **Dragging on a phone works like a laptop trackpad.** Tap, then touch again and drag: it's one press-and-drag, so a window moves instead of zooming and a file moves instead of opening, even if you hold a moment first. In trackpad mode, slow movements move the pointer further and fast ones accelerate less.
- **Windows: the service installs.** Setting up Headroom Server's service (what makes the lock screen, sign-in screen and UAC prompts reachable) failed with a command-line error, also from `install.ps1`. It works now, and Setup's log says why if it ever can't.

**Already have 0.4.2?** Install 0.4.3 once from below (0.4.2 can't update itself). On a Mac, macOS asks for Screen Recording and Accessibility one last time, because the signature changes to Headroom's certificate; after that, updates keep them.

## New in 0.4.2: lit screens

- **A look of its own.** Your computers are screens now: each one glows in its own colour while it's online and goes dark while it's off. Warm light only ever means a person is connected or asking; red means stop. A computer keeps its colour everywhere: in your list, in the session toolbar, for a guest connecting to it and in its own Headroom Server window. See [DESIGN.md](https://github.com/jamescolasacco/headroom/blob/master/DESIGN.md).
- **Tap a screen to go in.** The screen you tap grows into the session and shrinks back into its tile when you leave. While it connects, it wakes up in that computer's light, with **Cancel**.
- **Codes on a lit screen:** "Got a code?" on the website is a screen you type the code into, and Headroom Server shows your code big on this computer's own screen, with the QR code beside it.
- **Know which computer you're on:** the session toolbar shows its little lit screen and its name.
- **New passwords are typed twice** when you create an account, reset a forgotten password or change it, so a typo can't lock you out. The account server's `add-user` and `reset-password` commands ask twice too.
- **New icon and type** for the apps, the menu bar and tray, and the website (Funnel Display and Funnel Sans).
- **Smaller fixes:** "Password changed" stays shown after the lists reload, and after a guest session you're back on the code box.

Updating on a Mac: the apps aren't notarized, so macOS asks for **Screen Recording** and **Accessibility** again after an update, and firewalls such as Little Snitch see it as a new app to allow.

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

1. Download **Headroom-macOS.dmg** below and open it.
2. Drag **Headroom Server** and **Headroom Viewer** onto **Applications**.
3. Open **Headroom Server** from Applications. The first time, macOS says it can't check it (Headroom isn't notarized by Apple): click **Done**, open **System Settings → Privacy & Security**, scroll down to *"Headroom Server" was blocked*, click **Open Anyway** and confirm. Headroom Viewer asks the same the first time you open it.
4. Allow **Screen Recording** and **Accessibility** when Headroom Server asks, sign in under **Account**, and turn on **Start at login** in **Settings**.

From then on, both update themselves. (Terminal fans: `curl -fsSL https://github.com/jamescolasacco/headroom/releases/latest/download/get-macos.sh | bash` installs both without the Open Anyway step.)

### Windows 10/11 (x64)

- **Headroom Server** (the PC you want to reach): download **Headroom-Server-Setup.exe** and run it. It installs a service, so the lock screen, sign-in screen, UAC prompts and Ctrl+Alt+Del work remotely, and puts Headroom Server in the notification area.
- **Headroom Viewer** (where you connect from): download **Headroom-Viewer-Setup.exe** and run it (no administrator rights needed).

The installers aren't code-signed, so Windows may say it protected your PC: choose **More info → Run anyway**. Both update themselves afterwards. The .zip files hold the same apps for installing by hand (`install.ps1`, `install-viewer.ps1`).

### iPhone / iPad, or any browser

Nothing to install: open https://relay.colasac.co. In Safari, Share → Add to Home Screen gives a full-screen app.

`SHA256SUMS.txt` lists the checksums of every download; `SHA256SUMS.txt.sig` is their signature with Headroom's certificate (`assets/headroom-signing.cer` in the repository).
