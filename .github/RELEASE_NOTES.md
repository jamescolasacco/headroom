Remote desktop for your own computers, and quick help with a code: **Headroom Server** on the computer you want to reach; **Headroom Viewer**, any browser, or an iPhone/iPad on the device you use.

## New in 0.4.11

- **Sound starts off.** Joining a session no longer plays the computer's sound, or stops the music on your phone. A red speaker in the toolbar turns it on, and the computer sends no sound until you do.

## New in 0.4.10: sharp right after you scroll

- **No more smudge after scrolling.** Through Headroom's relay, Headroom Server took the time its own first big picture needed to send for a slow network: within seconds of connecting it cut the picture to its lowest quality (0.8 Mb/s) and kept it there, so whatever changed came out smudged and took seconds to clear. It now judges the network only by what really tells, never drops to what it happened to send while the screen was still, and raises the quality only while the picture uses it. Measured through the relay on a 1920×1080 screen: 13–31 Mb/s instead of 0.8, and the picture sharp within a tenth of a second of a scroll stopping, where with 0.4.9 it stayed smudged.
- **The picture sharpens until it's sharp.** Once the screen stops moving, Headroom Server sends it again, sharper each time, until the text is fully sharp, using only time the connection would otherwise sit idle, so nothing you do next waits for it. Before, it tried four times in a quarter of a second and gave up.
- **After a fast scroll, one whole sharp picture.** When the picture a scroll stopped on came out smudged, it sends a complete new one at twice the bitrate instead of correcting the smudged one bit by bit: sharp in one go, within about a second even on a 10 Mb/s connection.
- **Windows: a whole new screen comes out readable.** One frame could carry only three frames' worth of data, so a new page (Page Down, a link) arrived smudged; now up to half a second's worth. At 30 frames a second or fewer, the encoder also uses its sharper setting.
- **15 frames a second by default**, a quarter of the frames to send. **Picture and network → Frame rate** has 30, 60 and more. On a Mac, very fast scrolling looks better at 30 or 60: between two of 15 frames a second it moves further than the Mac's encoder can follow, so it's blurred until you stop.
- **Fewer words on screen.** The explanations under headings, settings and fields are gone from the website and Headroom Server's window: labels, statuses and errors only.
- **Phones:** dialogs stay clear of the status bar and the home indicator (your account's close button was under the clock). In Firefox on an iPhone, Add to Home Screen opens the page in Safari, where the app gets Headroom's icon.

**Updating:** 0.4.3 and later update themselves (**Restart to update**, or the download button in the window's corner to check now): update Headroom Server on each computer for the sharper picture, and Headroom Viewer for 15 frames a second. From 0.4.2 or older, install this once from below: 0.4.2 can't update itself, and on a Mac, macOS asks for Screen Recording and Accessibility one last time, because the signature changes to Headroom's certificate; after that, updates keep them. Computers still on 0.4.7 or older can't be reached until they update (Headroom's address changed in 0.4.8). On your own Headroom server, `git pull` and run `tools/install-account-server-linux.sh` again for the website's part (15 frames a second, the shorter wording and the phone fixes here).

## New in 0.4.9: links that don't stay lit, and Headroom on your Home Screen

- **Links and buttons don't stay lit.** In Headroom Viewer, Create account and Forgot password? open your browser, which puts the Viewer in the background: the link stayed highlighted there, and hovering anything else did nothing until you clicked back into the window. Headroom Viewer's and Headroom Server's windows now show hover only while they're in front.
- **Your iPhone's Home Screen icon is Headroom's**, not a letter H. iPhones make that icon from the website's app details and fetch the picture only once Add to Home Screen opens; tapping Add before it arrived kept a letter instead. The picture is part of the details now, so it's there at once. (Already added with an H? Remove it and add it again.) Firefox still puts a letter on it, whatever a website does: a Firefox bug; add it from Safari for the icon.
- **An install button under your devices**, on the website: in Chrome and Edge (Android, Windows, Mac) **Install app** opens their install dialog. On an iPhone or iPad, **Add to Home Screen** shows the three taps for the browser you're in: a website can't open that menu for you there.

## New in 0.4.8: wake your Mac from your phone, and sign in

- **Headroom has a new address: https://headroom.colasac.co** (relay.colasac.co is gone). Headroom Server and Headroom Viewer move to it by themselves with this update, still signed in: until a computer has it, it can't be reached, so on each one press **Restart to update** (or **Check for updates** in its menu-bar or tray menu). On a phone or in a browser, open the new address and sign in again; a Home Screen icon made from the old one won't open, so add it again from the new one.
- **Connect to a Mac that's asleep.** Tap it anyway: **Waiting for …** stays up (with Cancel, for up to 10 minutes) and connects the moment the Mac is back. A sleeping Mac wakes for a moment every few minutes; Headroom Server now gets back online within seconds of that (it could take half a minute, often too late), and the connection wakes the Mac up. Before, the website said it couldn't be reached.
- **The picture starts when the display wakes.** Connecting to a Mac whose display had turned off said there was no display and stopped there, so you had to connect again. Now Headroom wakes the display and the picture starts by itself, usually within a few seconds. With the lid closed it says so: a closed MacBook has no screen to show.
- **Type your password at the lock screen.** What you typed on a phone went to the Mac as text without keys, and password fields and the lock screen can ignore that. Each character now goes as the key that types it on the Mac's keyboard layout, Shift included, the way a keyboard plugged into the Mac sends it. (Emoji and letters the layout has no key for still go as text.) If typing ever stops working, Headroom Server's log says which app has secure input on.
- **The phone keyboard doesn't go dead.** If the keyboard closed in the middle of a word (dictation, predictions, swipe typing), everything you typed after it was ignored until you reloaded the page. And after dragging the space bar as a trackpad, the next letter no longer comes with a burst of Backspaces.
- **What you type sits in a box on top of the keys** while the keyboard is up, and the picture stays above it, so nothing covers the bottom of the screen. Tap the text to copy it. The eye beside it shows it as dots (a password) and back, and tapping anything on the keys bar keeps the keyboard up (in Firefox on iPhone the eye closed it).
- **Updates: a button in the corner.** Headroom Server's and Headroom Viewer's windows have a download button at the top right: click it to check right away; an update shows its progress there, then the button becomes **Restart to update**.
- **One way out of each dialog:** the close button at the top. The Done and Cancel buttons that repeated it at the bottom are gone.

## New in 0.4.7: phones type where you can see it

- **The toolbar is at the bottom on phones and tablets**, in reach of your thumb. Its menus open upward, and ⌄ folds it to a small tab. While the on-screen keyboard is up, the keys bar takes its place. With a mouse it stays at the top edge, since the bottom edge is your computer's own taskbar or Dock.
- **What you type shows just above the keys** while you type, so you can read it when the field you're typing into is under the keyboard or too small to see. Backspace takes characters off, and shortcuts sent with a held Ctrl or ⌘ show as keys (⌃C), so a modifier left on is easy to spot. It fades a few seconds after you stop, and starts over when you tap the screen, press Return, Esc, Tab or an arrow key, or close the keyboard. The eye at the end of the keys bar hides the text itself, showing dots instead (typing a password), and shows it again; Hide keyboard is beside it.
- **Windows: connecting works with the PC's monitor off.** A monitor asleep from power saving is woken when you connect, and if it shows nothing the stream starts on a black picture that your first click or keypress replaces; before, you waited on "Starting stream…" for as long as it slept. A monitor switched off at its button can disappear from Windows (usual over DisplayPort): then Headroom says no display is connected, and the picture comes back by itself when the monitor does. With no display at all there's nothing to show: keep one on, or use an HDMI dummy plug or a virtual display driver.
- **Close anything from its top corner.** Your account page, Got a code? and the other dialogs have a close button at the top that stays in view while they scroll, and a tap outside closes them too; before, on a phone your account page's Done was a long scroll down. In a session, Settings and the other option panels keep their close button in view the same way.

## New in 0.4.6: a sharper, smoother picture

- **Sharp over the internet, not just at home.** Headroom Server mistook ordinary internet delay for a congested network: whenever a viewer was more than about 60 ms away (through Headroom's relay, most of the time) it dropped the picture to its lowest quality and kept it there. Now it only slows down when the network is actually full, and then a little at a time. Measured through a relay: 12–40 Mb/s instead of 0.8–3, and a picture as sharp as with no network in between.
- **Auto resolution: the picture is sent as big as you see it.** A phone showing a Retina Mac at a third of its size gets a lighter stream: less delay, smooth scrolling at 60 frames a second, and a sharper picture at the size it's shown. It grows to full resolution as you zoom in, and a big window gets every pixel. **Picture and network → Resolution** still has Native and fixed sizes.

## New in 0.4.5: Stop server keeps the window working

- **Stopping Headroom Server only stops people connecting.** Stop server (in the window, the menu-bar menu or the tray menu) takes this computer offline: sessions and codes end and nobody can connect, direct or through Headroom. Its window keeps working: sign in, settings, everything. Start server turns it back on. Before, stopping it shut the window down too.
- **Windows: no administrator prompt to stop or start it**, with the service installed too.

## New in 0.4.4: Remote Desktop's touch gestures, and instant clicks

- **Clicks on a phone or touchscreen are instant.** A tap's click goes out the moment your finger lifts, instead of a quarter of a second later in case a drag followed.
- **Every Microsoft Remote Desktop gesture, plus double- and triple-click drags.** Tap, then touch and drag: a click-drag (text by the character). Tap tap, then touch and drag: a double-click drag (by the word). Tap tap tap, then touch and drag: a triple-click drag (by the paragraph). The same with two fingers is a right-click drag. Taps count as double and triple clicks just as your computer counts them.
- **Headroom Server stays in reach on a full menu bar.** macOS hides menu-bar icons that don't fit (beside a MacBook's notch, the newest go first). When it hides Headroom's, Headroom Server keeps a Dock icon while it runs, even with its window closed: click it for the window, or right-click it for the same quick actions as the menu-bar icon.
- **Stop and start the server from its window**, not just the menu-bar or tray menu: Home has **Stop server** (it asks first if someone's connected, since their session ends), and once it's stopped the window shows **Start server**.
- **The extra-keys bar presses only on a tap.** Swiping along it scrolls it, without pressing the key you started on. Modifiers: tap for the next key or click (tap again to cancel), double-tap to lock until you tap them off.

## New in 0.4.3: download, install, and it keeps itself up to date

- **Real installers.** On a Mac, open **Headroom-macOS.dmg** and drag both apps to Applications. On Windows, run **Headroom-Server-Setup.exe** and **Headroom-Viewer-Setup.exe**. No Terminal, no PowerShell.
- **It updates itself.** Headroom Server and Headroom Viewer check for a new version every few hours and download it in the background. When it's ready they tell you (a notification, the menu-bar or tray menu, and the window); **Restart to update** swaps it in and opens it again in a few seconds. Nothing restarts on its own, so a computer you're reaching from far away never drops out from under you.
- **Permissions stay put.** Every Mac build is now signed with Headroom's own certificate, so macOS keeps Screen Recording and Accessibility (and Little Snitch keeps its rules) across updates.
- **Only real updates get in.** An update is installed only if its checksums are signed with Headroom's certificate, every file matches, and on a Mac the new app carries the same signature. On Windows, Headroom Server's update asks for administrator permission once (it replaces Program Files and restarts the service).
- **Dragging on a phone works like a laptop trackpad.** Tap, then touch again and drag: it's one press-and-drag, so a window moves instead of zooming and a file moves instead of opening, even if you hold a moment first. In trackpad mode, slow movements move the pointer further and fast ones accelerate less.
- **Windows: the service installs.** Setting up Headroom Server's service (what makes the lock screen, sign-in screen and UAC prompts reachable) failed with a command-line error, also from `install.ps1`. It works now, and Setup's log says why if it ever can't.

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

- **Your devices, signed in with your email.** Create an account at https://headroom.colasac.co (email, password, and a code we email you). Sign in with it in Headroom Server on each computer and it's one of your devices, listed even while it's off. Sign in at the website or in Headroom Viewer and click a computer to connect, from anywhere. No addresses, no pairing, no port forwarding. Rename a computer in Headroom Server.
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

Nothing to install: open https://headroom.colasac.co. In Safari, Share → Add to Home Screen gives a full-screen app.

`SHA256SUMS.txt` lists the checksums of every download; `SHA256SUMS.txt.sig` is their signature with Headroom's certificate (`assets/headroom-signing.cer` in the repository).
