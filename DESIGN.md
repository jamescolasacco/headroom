# Headroom design

The look and feel of the website (`web/index.html`, `web/css/app.css`), the session screen, and Headroom Server's
window (`web/admin.html`, `web/css/admin.css`). The native Mac and Windows pieces (Accept prompt, Stop bar) follow
the same rules where the platform allows.

## Direction: a studio console

- **Who:** someone reaching their own computer from a phone or laptop somewhere else; and someone being helped —
  often less technical, often with a person on the phone reading out a code.
- **Feel:** calm and quiet until a person is involved, then unmistakable. Precision and restraint (Operate mode),
  not decoration.
- **World:** "headroom" is a studio word — the room before a signal clips. Warm graphite console panels with
  backlit off-white labels at night; warm paper by day; LEDs.
- **Colour only ever means status:** ready (green), **on air** (amber: someone is connected, or asking to be),
  stop (red: a problem to fix, or ending something). Everything else is ink on graphite or paper. There is no brand
  accent colour. Amber is only ever a person: a missing permission or a failed check-in is red, and "connecting…",
  "test pattern" or advice next to a code are plain ink.
- **Signature — the on-air lamp:** one amber "someone is here" signal everywhere a person is connected or asking:
  the Accept card, Home's status, the menu badge while someone waits, the session toolbar's "View only" lamp, and the
  native Stop bar.

## Tokens (`web/css/app.css`)

Named from the world, not from a template. Night is the default; day applies with `prefers-color-scheme: light`.
The session screen (`#viewer`, `.night`) is always night: it sits on the remote picture.

| Token | Night | Day | Use |
|---|---|---|---|
| `--console` | `#131312` | `#f6f4ef` | the page |
| `--panel` | `#1b1b19` | `#ffffff` | cards, rows |
| `--panel-2` | `#232320` | `#ffffff` | dialogs, menus, overlays |
| `--inset` | `#0e0e0d` | `#f6f4ef` | fields (a step below their surroundings) |
| `--field-edge` | `#75716b` | `#8a867f` | field borders: ≥ 3:1 against the field, cards and dialogs |
| `--rule` / `--rule-strong` | white 8% / 15% | ink 9% / 18% | hairlines; button edges |
| `--wash` | ink 6% | ink 5% | hover |
| `--ink` / `--ink-2` / `--ink-3` | `#eeebe5` / `#b9b4ab` / `#948f86` | `#1c1b18` / `#55514a` / `#6f6a62` | text: primary / supporting / meta and placeholders |
| `--ready` / `--ready-ink` | `#52c48a` / `#7ed6a7` | `#22a060` / `#177245` | online, allowed (dot / text) |
| `--air` / `--air-ink` / `--air-wash` / `--air-rule` | `#f2a93b` / `#f6c77e` | `#c27600` / `#8f5300` | on air: connected or asking (the lamp ≥ 3:1 on paper) |
| `--stop` / `--stop-ink` / `--stop-fill` | `#ee5d52` / `#ff8f86` / `#c9392e` | `#c9392e` / `#b42f25` / `#c9392e` | stop, delete, errors |
| `--fader` / `--on-fader` | `#eeebe5` / `#151513` | `#1c1b18` / `#f6f4ef` | the one main button per screen; the message bar |
| `--focus` | `#eeebe5` | `#1c1b18` | 2px focus ring, 2px offset |

Contrast (WCAG 2.2 AA), measured against the surfaces they sit on: `--ink-3` ≥ 4.8:1 everywhere; every `-ink`
status colour ≥ 5.4:1; fader buttons ≈ 16:1; white on `--stop-fill` 5.1:1. Never dim text with `opacity`: offline
rows use `--ink-2`/`--ink-3`.

Old names (`--bg`, `--fg`, `--muted`, `--accent`, `--ok`, `--warn`, `--bad`, `--line`) are aliases for markup that
still uses them; new code uses the names above.

## Type

- **Atkinson Hyperlegible Next** for text, **Atkinson Hyperlegible Mono** for codes, numbers in use, paths —
  self-hosted in `web/fonts/` (variable, latin subset, SIL OFL; licence in `web/fonts/OFL.txt`). Chosen because the
  moments that matter are reading and typing codes and emails: 0/O, 1/l/I and 5/S can't be confused.
- Scale (1.2 from 16px), as tokens: `--t-meta` 12 · `--t-small` 13.5 · `--t-label` 14.5 (labels, lists, menus) ·
  `--t-control` 15 (buttons, messages) · `--t-body` 16 · `--t-h3` 19 · `--t-h2` 23 · `--t-h1` 28 · `--t-code` 34.
  Code fields are 24 (21 in the compact row). No other sizes.
- Weights: 400 body, 500 labels/names/buttons, 650 headings. Hierarchy comes from weight and ink as much as size.
- Fields are 16px or larger (iOS doesn't zoom). Codes, countdowns and counts use tabular numbers.
- Sentence case everywhere. No uppercase eyebrows.

## Space, shape, depth

- 4px grid: `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 24 · `--s6` 32 · `--s7` 48. Cards pad 24
  (website) or 16–24 (Server window).
- Radius: controls 9, cards 14, floating layers 18; nested surfaces are concentric (outer = inner + padding), e.g.
  segmented control 9 around 6, toolbar 14 around 10, sheet 16 around 8.
- **Depth: tonal surfaces plus hairlines.** Shadows only for floating layers (dialogs, toast, toolbar, sheets,
  overlay card): `--float-shadow`. No glass or blur except the session toolbar and sheets, which must stay legible
  over any remote picture.

## Components

- **Buttons:** default = transparent with a `--rule-strong` edge; `.primary` = fader (one per screen);
  `.danger` = stop-coloured text; `.danger-fill` only for the final destructive step; `.link` = underlined text.
  44px tall (36 for `.small-btn`/`.sm`; 44 on touch screens). Busy state via `busy()` (never `disabled` mid-request:
  it drops focus). Buttons that ask in place ("Delete for good?") say so, and say it again when they give up.
- **Fields:** `field(label, input, { hint })` in `ui/dom.js` binds the label, hint and error; errors sit under the
  field (the hint steps aside meanwhile), mark it `aria-invalid`, are read out, and clear as you type. Form-level
  problems go in `.form-error` (`role="alert"`).
- **Device row:** the whole row is one button with the name and status as its text; a lit `--ready` dot when online,
  an unlit ring when offline.
- **Accept card (`.card.request`):** the riskiest moment, so it looks like it — amber rule and lamp, the name marked
  as typed-not-verified, approximate location, the scam warning at full size in `--air-wash`, files and clipboard
  unticked, answers in the order **Accept · View only · Decline** (the same in the Mac and Windows prompts), with the
  safe answer, Decline, as the strong button (Return and Esc in the native prompts). It says what each answer does,
  and "No answer in 2 minutes declines." Declining also ends the code, and the page says so.
- **Code display:** mono, groups of three (`123 456 789`), 34px; the scam line sits next to it, the QR code is small
  and secondary.
- **Message bar (`toast()`):** a top-layer popover (above dialogs), fader-coloured, announced through `#announcer`,
  pauses while hovered or while the tab is hidden; longer messages stay longer.
- **Dialogs:** named by their heading, open on the heading (not the first field), return focus on close. One
  exception: "Got a code?" opens on its field, because typing the code is the only thing it's for.
- **Account page:** lists, then one row per task (Password, Two-factor sign-in, Email, Delete account) that opens
  just that task's form with its result shown in place.
- **Session toolbar:** keyboard route Ctrl+Alt+Shift+M (focuses the first tool, never Disconnect), arrows move
  along it, Escape returns to the remote; hidden toolbar is `inert`. Until the computer lets you in it holds only
  Disconnect. Sheets are named like their buttons, take focus, keep Tab inside, close on Escape (from the remote
  too) and give focus back. Technical options fold under "Picture and network".
- **Endings:** the computer says why a session ended (its Stop, a removed sign-in, Headroom Server quitting) and the
  website shows that, with no "Reconnecting…" first. A guest who's let in hears "You're connected…" and that the
  other person can stop it at any time.

## Motion

- Transitions (not keyframes) for anything toggled; `@starting-style` for entrances. Easing
  `cubic-bezier(0.23, 1, 0.32, 1)`. Exits shorter than entrances (toast 260 in / 180 out; dialog 220 / 150).
- Press: controls scale to 0.96 over 150ms; full-width surfaces (device rows) 0.985; rows and menu items don't
  scale. Hover styles only on hover-capable pointers.
- Reduced motion: movement becomes a fade; the press feedback and a (slower) spinner stay.

## Copy

Plain and friendly; verb-first buttons ("Create a code", "Save name"); errors say what to do next, beside the field
that failed; no "please", "oops" or exclamation marks; counts through `plural()`; the person at the other computer is
"them", the computer is "this Mac" / "this PC".

## Accessibility floor

Every control has a name (visible label first); status changes are announced (`announce()`); a periodic refresh
never moves focus (Server window redraws only when its data changes, and restores focus and scroll by `data-key`);
pinch-zoom stays on; 24×24 minimum targets (44 on touch); WCAG 2.2 AA contrast in both themes.
