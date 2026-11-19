// On-screen (software) keyboard support — iOS/Android.
// The keyboard only opens when a text field is focused synchronously inside a user gesture, so a tiny
// transparent textarea is the "input sink". Its value is kept as SENT+SENT with the caret in the middle;
// after every input event we diff against that: lost chars on the left = Backspaces, on the right =
// Deletes, anything new in the middle = typed text (works for autocorrect, predictive text, dictation,
// emoji and IME composition). iOS fires nothing for Backspace on an empty field — hence the sentinel.
import { charToCode } from './keymap.js';

// Different invisible characters before and after the caret, so the diff can tell a Backspace
// (left side shrinks) from a forward Delete (right side shrinks).
const ZWSP = '​', WJ = '⁠'; // zero-width space, word joiner
const LEFT = ZWSP.repeat(12);
const RIGHT = WJ.repeat(12);
const STRIP = /[​⁠]/g;

export class SoftKeyboard extends EventTarget {
  /**
   * @param {object} ctx { sink, conn, keyboard (KeyboardInput), mods, touch (focus means the keyboard is up),
   *   echo (ui/typing.js: what went to the computer, shown above the keys) }
   */
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.open = false;
    this.composing = false;
    const s = ctx.sink;
    // While a word is being composed (Asian keyboards, dictation, swipe typing, Android's suggestions) the field
    // holds a draft: what it becomes is sent when the composition ends. Each input event says itself whether it's
    // part of one (isComposing): a composition whose end never came (the keyboard went away mid-word, a browser that
    // skips compositionend) must not leave every later keystroke ignored until the page is reloaded.
    s.addEventListener('input', e => this._input(e));
    s.addEventListener('compositionstart', () => { this.composing = true; });
    s.addEventListener('compositionend', () => { this.composing = false; this._input(); });
    s.addEventListener('blur', () => {
      this.composing = false;
      if (this.open) { this.open = false; this.dispatchEvent(new Event('change')); }
    });
    s.addEventListener('focus', () => {
      this.composing = false;
      this._reset();
      // On a touch screen the keyboard comes up whenever this field has focus, also when iOS gives it back by
      // itself (after the app switcher, or a hardware keyboard coming and going): say so.
      if (ctx.touch && !this.open) { this.open = true; this.dispatchEvent(new Event('change')); }
    });
    this._reset();
  }

  /** Must be called synchronously from a tap/click handler. */
  show() {
    const s = this.ctx.sink;
    this.composing = false;
    this._reset();
    s.focus({ preventScroll: true });
    if (!this.open) { this.open = true; this.dispatchEvent(new Event('change')); } // (focus may have said so already)
  }

  hide() {
    this.ctx.sink.blur();
    this.open = false;
    this.dispatchEvent(new Event('change'));
  }

  toggle() { if (this.open) this.hide(); else this.show(); }

  /**
   * Whether a keydown belongs to the text path. Printable keys typed while the soft keyboard is open go
   * through input-event diffing; named keys / shortcuts from an attached hardware keyboard still go
   * through the scancode path.
   */
  handles(e) {
    if (!this.open || document.activeElement !== this.ctx.sink) return false;
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
    for (let i = 0; i < backspaces; i++) this._key('Backspace');
    for (let i = 0; i < deletes; i++) this._key('Delete');
    if (backspaces) this.ctx.echo?.back(backspaces);
    if (inserted) this._text(inserted);
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
