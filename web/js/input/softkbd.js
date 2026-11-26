// On-screen (software) keyboard support — iOS/Android.
// The keyboard only opens when a text field is focused synchronously inside a user gesture, so a tiny
// transparent textarea is the "input sink". Its value is kept as SENT+SENT with the caret in the middle;
// after every input event we diff against that: lost chars on the left = Backspaces, on the right =
// Deletes, anything new in the middle = typed text (works for autocorrect, predictive text, dictation,
// emoji and IME composition). iOS fires nothing for Backspace on an empty field — hence the sentinel.
//
// Whether the keyboard is up is read off the page, never assumed from the field's focus: a phone gives the field its
// focus back by itself (after the app switcher or the lock screen) with or without the keyboard, Android's Back and a
// hardware keyboard take the keyboard away and leave the field focused. So typing (`open`: the typing dock, the
// toolbar's Keyboard button) follows the keyboard the page can see: one that comes back by itself opens it, one that
// goes away by itself closes it. A tap on Keyboard always ends with a keyboard: a field that kept its focus is focused
// afresh inside the tap, the only way a phone shows one.
import { charToCode } from './keymap.js';

// Different invisible characters before and after the caret, so the diff can tell a Backspace
// (left side shrinks) from a forward Delete (right side shrinks).
const ZWSP = '​', WJ = '⁠'; // zero-width space, word joiner
const LEFT = ZWSP.repeat(12);
const RIGHT = WJ.repeat(12);
const STRIP = /[​⁠]/g;
// An on-screen keyboard covers at least this much of the page (a hardware keyboard's bar alone is about 45-70 px).
const KEYBOARD_MIN = 100;
// A keyboard gone this long after the visible area last changed is gone, not resizing, turning with the phone (iOS
// reports no keyboard, even a negative height, while it turns) or changing layouts.
const GONE_MS = 700;

export class SoftKeyboard extends EventTarget {
  /**
   * @param {object} ctx { sink, signal (the session's life), conn, keyboard (KeyboardInput), mods, touch (a phone or
   *   tablet: its keyboard is on screen), echo (ui/typing.js: what went to the computer, shown above the keys),
   *   inputAllowed() (the computer takes input now: control is on and the connection is open) }
   */
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.open = false;
    this.composing = false;
    this.seen = false;      // an on-screen keyboard showed since typing began (so its going away can be seen too)
    this.own = false;       // show() is focusing the field: its focus and blur say nothing new
    this.goneTimer = 0;
    const s = ctx.sink;
    const options = { signal: ctx.signal };
    // While a word is being composed (Asian keyboards, dictation, swipe typing, Android's suggestions) the field
    // holds a draft: what it becomes is sent when the composition ends. Each input event says itself whether it's
    // part of one (isComposing): a composition whose end never came (the keyboard went away mid-word, a browser that
    // skips compositionend) must not leave every later keystroke ignored until the page is reloaded.
    s.addEventListener('input', e => this._input(e), options);
    s.addEventListener('compositionstart', () => { this.composing = true; }, options);
    s.addEventListener('compositionend', () => { this.composing = false; this._input(); }, options);
    s.addEventListener('blur', () => {
      if (this.own) return;
      this.composing = false;
      this._set(false);
    }, options);
    s.addEventListener('focus', () => {
      if (this.own) return;
      this.composing = false;
      this._reset();
      // The focus came back by itself (iOS after the app switcher or the lock screen, a hardware keyboard coming or
      // going): typing goes on once a keyboard shows, not before. If none comes, Keyboard opens one in one tap.
      this.viewportChanged();
    }, options);
    ctx.signal?.addEventListener('abort', () => clearTimeout(this.goneTimer));
    this._reset();
  }

  /**
   * Must be called synchronously from a tap/click handler: it ends with a keyboard. A field that kept its focus
   * without one (it came back without it, Back hid it) is focused afresh: a phone shows a keyboard only for a field
   * focused inside a tap.
   */
  show() {
    const s = this.ctx.sink;
    this.composing = false;
    this._reset();
    this.own = true;
    try {
      if (document.activeElement === s && this.covered() < KEYBOARD_MIN) s.blur();
      s.focus({ preventScroll: true });
    } finally { this.own = false; }
    this.seen = this.covered() >= KEYBOARD_MIN;
    this._set(true);
  }

  hide() {
    this.ctx.sink.blur();
    this._set(false);
  }

  toggle() { if (this.open) this.hide(); else this.show(); }

  /** The page went to the background: whatever keyboard there was went with it (it may come back: viewportChanged). */
  suspend() {
    this.composing = false;
    this._set(false);
  }

  /**
   * How much of the page's bottom an on-screen keyboard covers now (0: none): the page keeps its height (innerHeight)
   * and only what shows of it (the visual viewport) ends above the keyboard. (A browser that shrinks the page itself
   * for the keyboard shows 0 here: typing then opens and closes only from Keyboard and Hide keyboard.)
   */
  covered() {
    const vv = window.visualViewport;
    return vv ? Math.max(0, Math.round((window.innerHeight || 0) - vv.offsetTop - vv.height)) : 0;
  }

  /**
   * The visible area changed (the session calls this before it lays itself out): a keyboard that came up by itself
   * starts typing, one that went away by itself while the field kept its focus ends it.
   */
  viewportChanged() {
    if (!this.ctx.touch) return;
    const focused = document.activeElement === this.ctx.sink && document.visibilityState !== 'hidden';
    if (focused && this.covered() >= KEYBOARD_MIN) {
      clearTimeout(this.goneTimer); this.goneTimer = 0;
      this.seen = true;
      this._set(true);
    } else if (this.open && this.seen) {
      clearTimeout(this.goneTimer); // counted from the last change: a phone turning goes through several
      this.goneTimer = setTimeout(() => {
        this.goneTimer = 0;
        const still = document.activeElement === this.ctx.sink && this.covered() >= KEYBOARD_MIN;
        if (this.open && this.seen && !still) this._set(false);
      }, GONE_MS);
    }
  }

  _set(open) {
    clearTimeout(this.goneTimer); this.goneTimer = 0;
    if (!open) this.seen = false;
    if (open === this.open) return;
    this.open = open;
    this.dispatchEvent(new Event('change'));
  }

  /**
   * Whether a keydown belongs to the text path. Printable keys typed while the soft keyboard is open go
   * through input-event diffing; named keys / shortcuts from an attached hardware keyboard still go
   * through the scancode path.
   */
  handles(e) {
    // On a phone or tablet the field's text path holds whenever it has focus, also while a returning keyboard is still
    // on its way (or a hardware keyboard types into it): what's typed must go one way only, as text.
    if (document.activeElement !== this.ctx.sink || !(this.open || this.ctx.touch)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key && e.key.length === 1) return true;
    // Let the field handle Backspace/Enter too: preventDefault on iOS kills Backspace auto-repeat,
    // which arrives as repeated deleteContentBackward input events (picked up by the diff).
    return e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Unidentified' || e.key === 'Process' || e.isComposing;
  }

  _reset() {
    const s = this.ctx.sink;
    s.value = LEFT + RIGHT;
    try { s.setSelectionRange(LEFT.length, LEFT.length); } catch { }
  }

  _input(e) {
    // Mid-composition: wait for its end. The event's own word counts over ours (ours may be stale).
    if (e && typeof e.isComposing === 'boolean') { if (e.isComposing) return; this.composing = false; }
    else if (this.composing) return;
    const v = this.ctx.sink.value;
    if (v === LEFT + RIGHT) return;
    // Counted, not read off the ends: a caret dragged in among them (iOS's space bar is a trackpad) leaves them out of
    // place, and typing there must not count as deleting them.
    let lefts = 0, rights = 0;
    for (const ch of v) { if (ch === ZWSP) lefts++; else if (ch === WJ) rights++; }
    let backspaces = Math.max(0, LEFT.length - lefts);
    let deletes = Math.max(0, RIGHT.length - rights);
    // Which way a deletion went, when the event says (from a caret among the right-hand ones, Backspace eats those).
    const type = e?.inputType || '';
    if (/^delete.*Backward$/.test(type)) { backspaces += deletes; deletes = 0; }
    else if (/^delete.*Forward$/.test(type)) { deletes += backspaces; backspaces = 0; }
    const inserted = v.replace(STRIP, '');
    const kb = this.ctx.keyboard;
    // While the computer takes no input (reconnecting, or watching only) what's typed goes nowhere: it isn't sent, and
    // the box over the keys doesn't show it as sent.
    if (!this.ctx.inputAllowed || this.ctx.inputAllowed()) {
      for (let i = 0; i < backspaces; i++) this._key('Backspace');
      for (let i = 0; i < deletes; i++) this._key('Delete');
      if (backspaces) this.ctx.echo?.back(backspaces);
      if (inserted) this._text(inserted);
    }
    this._reset();
    kb?.ctx.onUserGesture?.();
  }

  _key(code) {
    const mods = this.ctx.mods;
    mods?.pressForKey();
    this.ctx.keyboard.tap(code);
    mods?.consume();
  }

  _text(text) {
    const mods = this.ctx.mods;
    if (mods?.hasActive()) {
      // Ctrl/Alt/Win armed on the extra-keys bar: send real key chords (Ctrl+C, Win+R...).
      for (const ch of text) {
        const m = charToCode(ch.toLowerCase());
        if (!m) continue;
        const shift = m.shift || ch !== ch.toLowerCase();
        const held = [...mods.state.keys(), ...(shift ? ['ShiftLeft'] : [])];
        mods.pressForKey();
        if (shift) this.ctx.keyboard.chord(['ShiftLeft', m.code]); else this.ctx.keyboard.tap(m.code);
        mods.consume();
        this.ctx.echo?.shortcut(held, /^(Key|Digit)/.test(m.code) ? m.code.replace(/^(Key|Digit)/, '') : ch);
      }
      return;
    }
    // Plain text: layout-independent Unicode injection on the host.
    this.ctx.conn.sendJson({ t: 'text', s: text });
    this.ctx.echo?.text(text);
  }
}
