# Headroom design

The look and feel of the website (`web/index.html`, `web/css/app.css`), the session screen, and Headroom Server's
window (`web/admin.html`, `web/css/admin.css`). The native Mac and Windows pieces (Accept prompt, Stop bar, window
backgrounds, the offline page) follow the same rules where the platform allows.

## Direction: lit screens

- **Who:** someone reaching their own computer from a phone or laptop somewhere else; and someone being helped —
  often less technical, often with a person on the phone reading out a code.
- **The idea:** your computers are screens, and light is what they say. A computer that's on and reachable glows in
  its own colour; one that's off is dark glass. Warm light means a person is here (connected, or asking). Red means
  stop. Everything around the screens (the room) stays quiet: no decoration that doesn't say something.
- **Feel:** calm and dark-sleek at night, crisp by day; unmistakable when a person is involved. Operate mode:
  precision first, the identity lives in a few exact details.
- **Signature — the screen tile:** a 16:10 screen face with its light brightest at the top edge, falling to deep at
  the bottom and spilling a little onto the room. It is the device in your list, this computer on Headroom Server's
  Home, the chip in the session toolbar, the code box on the front page (a lit screen you type the code into) and
  the code on Headroom Server (shown on this computer's own lit screen). Tapping a device's screen grows it into the
  session; leaving shrinks it back into its tile.
- **Every computer has its own light** (`ui/light.js`: FNV-1a of its host id, one of five), so the same Mac is the
  same colour on the website, in the session toolbar, in its own Server window and for a guest who connects to it.
  Lights are never warm (warm is a person) and never red (red is stop).
- **The mark:** a screen outline with its top edge lit (the room above the picture: headroom).

## Tokens (`web/css/app.css`)

Named from the world: the room, panels, glass, ink, light, lamp, stop. Night is the default; day applies with
`prefers-color-scheme: light`. The session screen (`#viewer`, `.night`) and every lit screen (`.code-screen`) are
always night: a screen is a screen.

| Token | Night | Day | Use |
|---|---|---|---|
| `--room` | `#090b10` | `#eef1f5` | the page |
| `--room-2` | `#0e1118` | `#e3e7ed` | Headroom Server's side panel |
| `--panel` | `#10131a` | `#ffffff` | the few raised surfaces: sign-in, settings groups, Connected now |
| `--glass` / `--glass-solid` | 90% / `#141821` | 90% / `#fcfdfe` | floating layers: toolbar, sheets / dialogs, menus |
| `--field` / `--field-edge` | `#05070a` / `#6b7487` | `#f6f8fb` / `#7a8395` | fields sit below their surroundings; edges ≥ 3:1 |
| `--rule` / `--rim` / `--rim-strong` | white 7% / 11% / 20% | ink 8% / 9% / 17% | hairlines / the light catching an edge |
| `--ink` / `--ink-2` / `--ink-3` | `#eef1f6` / `#aab2c0` / `#8d96a7` | `#0c0f15` / `#454c59` / `#5c6474` | text: primary / supporting / meta |
| `--light` | `#a9dcff` | `#1f5fcf` | "on": focus, a lit LED, a held modifier, a done result |
| `--lamp` / `--lamp-ink` | `#faab3f` / `#ffc97a` | `#c27600` / `#8a5200` | warm light: a person (connected or asking) |
| `--stop` / `--stop-ink` / `--stop-fill` | `#ff6b5e` / `#ff9d93` / `#c9392e` | `#c9392e` / `#b02f25` / `#c9392e` | stop, delete, errors |
| `--primary` / `--on-primary` | `#eef4ff` / `#0a0d14` | `#0c0f15` / `#ffffff` | the one main button per screen (lit at night); the message bar |
| `--l-hi/-mid/-deep/-glow/-dot` | per light | same | a screen's light (`[data-light="0…4"]`: azure, jade, iris, orchid, lagoon) |

Contrast (WCAG 2.2 AA), measured against every surface they sit on: `--ink-3` ≥ 4.8:1 everywhere; status inks
≥ 5.1:1; primary buttons ≥ 17:1; white on `--stop-fill` 5.1:1. Text on a lit screen is white and left-aligned; the
light comes from the top right, away from it, so headings stay ≥ 4:1 and small text ≥ 5.7:1 on all five lights. Never
dim text with `opacity`: offline devices use `--ink-2`/`--ink-3`.

Old names (`--console`, `--fader`, `--air`, `--ready`, `--bg`, `--fg`, `--muted`, …) are aliases for markup that
still uses them; new code uses the names above.

## Type

- **Funnel Display** for headings, the wordmark and codes; **Funnel Sans** for everything else; **Atkinson
  Hyperlegible Mono** only for paths, links and key strings. Self-hosted in `web/fonts/` (variable, latin and
  latin-ext subsets, SIL OFL; licence in `web/fonts/OFL.txt`). Funnel's flared terminals give the display voice its
  character; its tabular figures keep 9-digit codes steady.
- Scale (about 1.25 from a 15px UI size), as tokens: `--t-meta` 12.5 · `--t-small` 13.5 · `--t-label` 14.5 ·
  `--t-control` 15 · `--t-body` 16 · `--t-h3` 19 · `--t-h2` 24 · `--t-h1` 34 · `--t-code` 44. The front page's
  headline is `clamp(36px, 5.4vw, 60px)`. Code fields are 26 (22 on very small phones).
- Weights: 400 body, 500 labels and buttons, 600 headings and the primary button, 650 the wordmark. Display sizes
  tighten their tracking (−0.02 to −0.035em); codes open theirs (+0.06 to +0.12em).
- Fields are 16px or larger (iOS doesn't zoom). Codes, countdowns and counts use tabular numbers.
- Sentence case everywhere. No uppercase eyebrows, no labels above headings.

## Space, shape, depth

- 4px grid: `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 24 · `--s6` 32 · `--s7` 48 · `--s8` 72.
- Radius: controls 10, screens 12 (14 for this computer on Home), panels 18, floating layers 22; nested surfaces are
  concentric (segmented control 12 around 9, toolbar 16 around 12, sheet 20 around 12).
- **Depth is light, not boxes.** Surfaces are tonal; edges are a 1px inset rim of light (`--rim`), not borders. Lit
  screens cast a soft glow in their own colour. Shadows only lift floating layers (`--float-shadow`). Glass (blur)
  only where a layer sits over a live remote picture: the toolbar, sheets, the connecting card, the extra keys.
- No cards for structure: the device shelf, the front page and the code view sit on the room; panels appear only
  where a group needs holding (sign-in, settings groups, Connected now, the Accept card).

## Components

- **Buttons:** default = transparent with a `--rim-strong` edge; `.primary` = lit (one per screen); inside a lit
  screen the submit is the screen's own `--l-hi`; `.danger` = stop-coloured text; `.danger-fill` only for the final
  destructive step; `.link` = underlined text. 44px tall (36 for `.small-btn`/`.sm`; 44 on touch screens). Busy state
  via `busy()` (never `disabled` mid-request: it drops focus).
- **Fields:** `field(label, input, { hint })` in `ui/dom.js` binds the label, hint and error; errors sit under the
  field, mark it `aria-invalid`, are read out, and clear as you type. Form-level problems go in `.form-error`.
- **New passwords are typed twice:** creating an account, resetting a forgotten password and changing it on the
  Account page each have a "Confirm password" box (`confirmField()` in `app.js`); a mismatch says so beside it and
  nothing is sent. The account server's command line (`add-user`, `reset-password`) asks twice at a terminal too.
- **Device tile (`.host`):** the whole tile is one button named with its status ("Studio Mac, Online"): the screen
  face, then name and status as its caption. Online = lit in its light, with a lit LED; offline = dark glass and
  "Offline, last seen 3 h ago". Hover lifts the screen 2px and brightens its glow; press 0.985. In Headroom Viewer,
  "Open in a new window" sits on the screen's corner.
- **Code screen (`.code-screen`):** the front page's "Got a code?" and its dialog, and the code on Headroom Server.
  Always night; white text; the code field is dark glass inside it.
- **This computer (Headroom Server Home):** its screen in its own light beside the status ("Nobody is connected",
  "Ready. Your devices can connect from anywhere."); warm with a person glyph while someone is connected or asking;
  dark with a red warning glyph while it can't be reached yet (missing permissions).
- **Accept card (`.card.request`):** the riskiest moment, so it is warm: lamp rim and glow, the name marked as
  typed-not-verified, approximate location, the scam warning at full size in `--lamp-wash`, files and clipboard
  unticked, answers in the order **Accept · View only · Decline** (the same in the Mac and Windows prompts), with the
  safe answer, Decline, as the strong button. "No answer in 2 minutes declines."
- **Message bar (`toast()`):** a lit strip (top layer, above dialogs), announced through `#announcer`, pauses while
  hovered or while the tab is hidden; longer messages stay longer.
- **Dialogs:** solid glass, named by their heading, open on the heading (not the first field), return focus on close.
  "Got a code?" opens on its field.
- **Account page:** lists, then one row per task (Password, Two-factor sign-in, Email, Delete account) that opens just
  that task's form; its result stays shown there when the lists reload.
- **Session toolbar:** Disconnect, then which computer this is (its lit mini screen, and its name on wide screens),
  then the tools. Keyboard route Ctrl+Alt+Shift+M (focuses the first tool, never Disconnect), arrows move along it,
  Escape returns to the remote; a hidden toolbar is `inert`. Sheets are named like their buttons (which close them
  again), have a Close button, keep Tab inside, close on Escape and give focus back.
  - With a mouse it hides by itself and comes back at the top edge.
  - On touch screens it stays put with 44px buttons, and the picture sits below it. "Hide tools" folds it to a small
    tab. A phone held upright keeps Keyboard, Trackpad/Touch and Extra keys on the bar and the rest under More.
  - The on-screen keyboard: the session shrinks to what's visible above it, the extra keys sit right on top of it,
    and the picture keeps its size and zoom, panning to the pointer. When there's no room, the bar steps aside.
  - Pinching zooms the remote screen, never the page.
- **Connecting:** the screen wakes up in the computer's light behind a glass card ("Connecting…", with Cancel until
  the session is up). Endings say why, with no "Reconnecting…" first.

## Motion

- **One authored moment:** the device's screen grows into the session (View Transitions, 420ms,
  `cubic-bezier(0.32, 0.72, 0, 1)`) and shrinks back into its tile on the way out (300ms). Where the browser can't, or
  motion is reduced, it cuts.
- Everything else is small and quick: transitions (not keyframes) for anything toggled; `@starting-style` for
  entrances; easing `cubic-bezier(0.23, 1, 0.32, 1)`; exits shorter than entrances (toast 260 in / 180 out; dialog
  220 / 150).
- Press: controls scale to 0.96 over 150ms; device tiles 0.985; rows and menu items don't scale. Hover styles only
  on hover-capable pointers.
- Reduced motion: movement becomes a fade or a cut; the press feedback and a (slower) spinner stay.

## Copy

Plain and friendly; verb-first buttons ("Create a code", "Save name", "Change password"); errors say what to do next,
beside the field that failed ("The passwords don't match. Type the same password in both boxes."); no "please",
"oops" or exclamation marks; counts through `plural()`; the person at the other computer is "them", the computer is
"this Mac" / "this PC". "Your devices" are the computers in your account.

## Accessibility floor

Every control has a name (visible label first); status changes are announced (`announce()`); a periodic refresh
never moves focus (the Server window redraws only when its data changes, and restores focus and scroll by
`data-key`); pinch-zoom stays on outside sessions; 24×24 minimum targets (44 on touch); WCAG 2.2 AA contrast in both
themes and on every light; colour never stands alone (every lit, warm or red state also has words).
