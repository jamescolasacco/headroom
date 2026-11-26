// Extra-keys bar (Esc, Tab, Ctrl, Alt, Win/⌘, arrows, F-keys...) with sticky modifiers:
//   tap = held for the next key or click (tap again: off), double-tap = locked until tapped off.
// A key goes on a tap: a swipe along the bar scrolls it and presses nothing (holding an arrow, del, pgup or pgdn
// still repeats it). Labels follow the host: a Mac host gets control/option/⌘ and Force Quit instead of Ctrl+Alt+Del.
// While the on-screen keyboard is up, the bar is a dock of two rows, as in VNC Viewer: on top what you type
// (ui/typing.js), in a box with the eye inside it (shows the text as dots, for a password) and Hide keyboard beside
// it (a tap on the text copies it); under it the keys. The picture sits above the whole dock. A phone on its side puts all of it in one row.
import { h, svg } from './dom.js';

const LOCK_TAP_MS = 500;        // two taps on a modifier this close lock it (a double-click's time on the computer)
const TAP_SLOP = 10;            // px a tap may wander; further is a swipe along the bar
const REPEAT_DELAY = 380, REPEAT_EVERY = 55;
const EYE = '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = '<path d="M10.6 5.1A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a16.4 16.4 0 0 1-2.4 3.2M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.4 9.4 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>';
const HIDE_KEYBOARD = '<rect x="2.5" y="3" width="19" height="11.5" rx="2"/><path d="M6.5 7h.01M10.5 7h.01M14.5 7h.01M17.5 7h.01M7.5 11h9M8.5 18.5l3.5 3 3.5-3"/>';

export class StickyModifiers extends EventTarget {
  constructor(keyboard) {
    super();
    this.keyboard = keyboard;
    this.state = new Map();     // code -> 'once' | 'locked'
    this.pressed = new Set();   // codes we pressed on the host for the current key/click
    this.lastTap = null;        // { code, t }: the last tap on a modifier, for a double tap
  }

  /** A tap on a modifier: on for the next key or click, or off again. Two taps in a row lock it until the next tap. */
  tap(code) {
    const now = performance.now(), l = this.lastTap;
    const double = !!l && l.code === code && now - l.t < LOCK_TAP_MS;
    this.lastTap = double ? null : { code, t: now };
    if (double) this.state.set(code, 'locked');
    else if (this.state.has(code)) {
      this.state.delete(code);
      if (this.pressed.has(code)) { this.keyboard.send(code, false); this.pressed.delete(code); }
    } else this.state.set(code, 'once');
    this.dispatchEvent(new Event('change'));
  }

  hasActive() { return this.state.size > 0; }

  pressForKey() {
    for (const code of this.state.keys()) {
      if (!this.keyboard.down.has(code)) { this.keyboard.send(code, true); this.pressed.add(code); }
    }
  }

  pressForClick() { this.pressForKey(); }

  /** After a non-modifier key/click: release everything we pressed; one-shots disarm. */
  consume(code) {
    if (code && /^(Shift|Control|Alt|Meta|OS)/.test(code)) return;
    if (!this.state.size && !this.pressed.size) return;
    for (const c of this.pressed) this.keyboard.send(c, false);
    this.pressed.clear();
    let changed = false;
    for (const [c, s] of this.state) if (s === 'once') { this.state.delete(c); changed = true; }
    if (changed) this.dispatchEvent(new Event('change'));
  }

  releaseAfterClick() { this.consume(); }

  clear() {
    for (const c of this.pressed) this.keyboard.send(c, false);
    this.pressed.clear();
    this.state.clear();
    this.dispatchEvent(new Event('change'));
  }
}

const KEYS = [
  { label: 'esc', code: 'Escape' },
  { label: 'tab', code: 'Tab' },
  { sep: true },
  { label: 'ctrl', mac: 'control', code: 'ControlLeft', mod: true },
  { label: 'alt', mac: 'option', code: 'AltLeft', mod: true },
  { label: 'win', mac: '⌘ cmd', code: 'MetaLeft', mod: true, title: 'Windows key', macTitle: 'Command key' },
  { label: 'shift', code: 'ShiftLeft', mod: true },
  { sep: true },
  { label: '←', code: 'ArrowLeft', repeat: true },
  { label: '↑', code: 'ArrowUp', repeat: true },
  { label: '↓', code: 'ArrowDown', repeat: true },
  { label: '→', code: 'ArrowRight', repeat: true },
  { sep: true },
  { label: 'del', code: 'Delete', repeat: true },
  { label: 'home', code: 'Home' }, { label: 'end', code: 'End' },
  { label: 'pgup', code: 'PageUp', repeat: true }, { label: 'pgdn', code: 'PageDown', repeat: true },
  { sep: true },
  ...Array.from({ length: 12 }, (_, i) => ({ label: `F${i + 1}`, code: `F${i + 1}` })),
  { sep: true },
  { label: 'ins', code: 'Insert', pcOnly: true }, { label: 'prtsc', code: 'PrintScreen', pcOnly: true },
  { label: 'ctrl+alt+del', mac: 'force quit', action: 'cad', wide: true, macTitle: 'Force Quit Applications (⌥⌘Esc)' },
];

export class ExtraKeysBar {
  /**
   * @param {object} o { keyboard, mods, conn, onLayout(px), onKey(code) (a key went to the computer), typingEl (the
   *   box what you type shows in: ui/typing.js), onCopyText() (a tap on the text in it), onHideText(on) (the eye),
   *   onHideKeyboard(), keyboardUp() (the on-screen keyboard's input has focus), reopenKeyboard() (focus it again,
   *   from inside a tap) }
   */
  constructor(el, { signal, keyboard, mods, conn, special, onLayout, onKey, typingEl, onCopyText, onHideText, onHideKeyboard, keyboardUp, reopenKeyboard }) {
    this.el = el;
    this.keyboard = keyboard;
    this.mods = mods;
    this.conn = conn;
    this.special = special || (action => conn.sendJson({ t: 'special', action })); // the session's: only with control
    this.onLayout = onLayout;
    this.onKey = onKey;
    this.visible = false;
    this.macHost = false;
    this.keyboardOpen = false; // the on-screen keyboard is up (the session says: setKeyboardOpen)
    this.keys = h('div', { class: 'xk-keys', role: 'group', 'aria-label': 'Extra keys' });
    this.typeBox = typingEl || h('div');
    this.typeBox.classList.add('xk-type');
    this.typeBox.hidden = true;
    this.eyeBtn = this._endButton('Hide typed text', () => onHideText?.(!this.textHidden), null, 'xk-eye');
    this.typeBox.append(this.eyeBtn);
    const line = this.typeBox.querySelector('.typed');
    if (line) this._onTap(line, () => onCopyText?.());
    this.hideBtn = this._endButton('Hide keyboard', () => { this.hideAsked = true; onHideKeyboard?.(); }, HIDE_KEYBOARD, 'xk xk-icon xk-hide');
    this.hideBtn.hidden = true;
    el.replaceChildren(this.typeBox, this.keys, this.hideBtn);
    this.setTextHidden(false);
    this._render();
    mods.addEventListener('change', () => this._sync());
    // Tapping the bar must never take the keyboard away. Browsers follow a tap with a mouse press and a click, and some
    // (Firefox on iPhone) move focus off the keyboard's hidden input for them, which closes the keyboard: the bar
    // cancels both (a tap here is handled on its own: keys on the lift, the end buttons on touchend). If the keyboard
    // went anyway, it's brought back while the tap still counts as one (iOS opens a keyboard only then).
    el.addEventListener('mousedown', e => e.preventDefault(), { signal });
    el.addEventListener('touchstart', () => { this.upAtTouch = !!keyboardUp?.(); this.hideAsked = false; }, { passive: true, signal });
    el.addEventListener('touchend', e => {
      if (e.cancelable) e.preventDefault();
      if (this.upAtTouch && !this.hideAsked && !keyboardUp?.()) reopenKeyboard?.();
    }, { signal });
  }

  /**
   * The eye or Hide keyboard. A tap acts when the finger lifts on it (its click is cancelled: see the constructor); a
   * mouse, Enter or Space click it.
   */
  _endButton(label, onClick, icon, cls) {
    const b = h('button', { type: 'button', class: cls, 'aria-label': label, title: label }, icon ? svg(icon) : null);
    this._onTap(b, onClick);
    return b;
  }

  /** `fn` on a tap that ends on `el` (on touchend: its click is cancelled), or on a click from a mouse or keyboard. */
  _onTap(el, fn) {
    let tappedAt = -1e9;
    el.addEventListener('pointerdown', e => e.preventDefault());
    el.addEventListener('touchend', e => {
      const t = e.changedTouches[0], r = el.getBoundingClientRect();
      if (!t || t.clientX < r.left || t.clientX > r.right || t.clientY < r.top || t.clientY > r.bottom) return; // slid off it
      tappedAt = performance.now();
      fn();
    });
    // (A click right after a tap is that tap's own, should a browser send it anyway: the eye mustn't flip back.)
    el.addEventListener('click', () => { if (performance.now() - tappedAt > 700) fn(); });
  }

  /** The eye: open while the text you type shows, struck through while it's hidden as dots. */
  setTextHidden(on) {
    this.textHidden = on;
    this.eyeBtn.replaceChildren(svg(on ? EYE_OFF : EYE));
    this.eyeBtn.setAttribute('aria-pressed', String(on));
  }

  /** The on-screen keyboard came up (the dock gets the typing row) or went away (just the keys, if they stay). */
  setKeyboardOpen(open) {
    this.keyboardOpen = open;
    this.el.classList.toggle('typing-on', open);
    this.typeBox.hidden = !open;
    this.hideBtn.hidden = !open;
    this.position();
  }

  /** Re-label for the host's platform ('macos' | 'windows'). */
  setHost(os) {
    const mac = os === 'macos';
    if (mac === this.macHost) return;
    this.macHost = mac;
    this._render();
    this._sync();
  }

  _render() {
    this.keys.replaceChildren();
    for (const k of KEYS) {
      if (k.sep) { const s = document.createElement('span'); s.className = 'xk-sep'; this.keys.append(s); continue; }
      if (k.pcOnly && this.macHost) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'xk' + (k.mod ? ' mod' : '') + (k.wide ? ' xk-wide' : ''); // not .wide: that's a full-width button
      b.textContent = this.macHost && k.mac ? k.mac : k.label;
      if (k.mod) b.setAttribute('aria-pressed', 'false'); // held for the next key (or locked) = pressed
      const title = this.macHost && k.macTitle ? k.macTitle : k.title;
      if (title) b.title = title;
      if (k.code) b.dataset.code = k.code;
      // A key goes when the finger lifts without having moved: a swipe scrolls the bar (the browser then cancels
      // the touch) and presses nothing. (pointerdown's default is prevented to keep focus on the hidden input, so
      // the iOS keyboard stays up while tapping bar keys.)
      b.addEventListener('pointerdown', e => { e.preventDefault(); this._down(k, e); });
      b.addEventListener('pointermove', e => this._move(e));
      b.addEventListener('pointerup', e => this._up(k, e));
      b.addEventListener('pointercancel', () => this._cancel());
      b.addEventListener('pointerleave', () => this._cancel());
      // From a keyboard (Enter or Space: a click with no pointer), press it once.
      b.addEventListener('click', e => { if (e.detail === 0) this._press(k); });
      this.keys.append(b);
    }
  }

  _down(k, e) {
    this._cancel();
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY, repeating: false, wait: 0, every: 0 };
    // Held still, an arrow (or del, pgup, pgdn) repeats.
    if (k.repeat) {
      p.wait = setTimeout(() => {
        p.repeating = true;
        this._fire(k);
        p.every = setInterval(() => this._fire(k), REPEAT_EVERY);
      }, REPEAT_DELAY);
    }
    this.touch = p;
  }

  _move(e) {
    const p = this.touch;
    if (p && e.pointerId === p.id && Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP) this._cancel();
  }

  _up(k, e) {
    const p = this.touch;
    if (!p || e.pointerId !== p.id) return;
    this._cancel();
    if (!p.repeating && Math.hypot(e.clientX - p.x, e.clientY - p.y) <= TAP_SLOP) this._press(k);
  }

  /** The touch on a key is over without a tap (a swipe, or the finger left it): nothing more happens. */
  _cancel() {
    const p = this.touch;
    if (!p) return;
    clearTimeout(p.wait);
    clearInterval(p.every);
    this.touch = null;
  }

  _press(k) {
    if (k.mod) { this.mods.tap(k.code); return; }
    if (k.action === 'cad') { this.special('cad'); return; }
    this._fire(k);
  }

  _fire(k) {
    this.mods.pressForKey();
    this.keyboard.tap(k.code);
    this.mods.consume(k.code);
    this.onKey?.(k.code);
  }

  _sync() {
    for (const b of this.keys.querySelectorAll('.xk.mod')) {
      const s = this.mods.state.get(b.dataset.code);
      if (s) b.dataset.state = s; else delete b.dataset.state;
      b.setAttribute('aria-pressed', String(!!s));
      if (s === 'locked') b.setAttribute('aria-label', `${b.textContent}, locked`); else b.removeAttribute('aria-label');
    }
  }

  show() { this.visible = true; this.el.hidden = false; this.position(); }
  hide() { this.visible = false; this.el.hidden = true; this.onLayout?.(0); }
  toggle() { if (this.visible) this.hide(); else this.show(); }

  /**
   * Sits at the bottom of the session, which the session keeps inside the visible area: right above the
   * on-screen keyboard when it's up (where the home-indicator spacing isn't needed).
   */
  position() {
    if (!this.visible) return;
    this.el.style.paddingBottom = this.keyboardOpen ? '6px' : '';
    this.onLayout?.(this.el.offsetHeight);
  }
}
