// On-screen (software) keyboard support — iOS/Android.
// The keyboard only opens when a text field is focused synchronously inside a user gesture, so a tiny
// transparent textarea is the "input sink". Its value is kept as SENT+SENT with the caret in the middle;
// after every input event we diff against that: lost chars on the left = Backspaces, on the right =
// Deletes, anything new in the middle = typed text (works for autocorrect, predictive text, dictation,
// emoji and IME composition). iOS fires nothing for Backspace on an empty field — hence the sentinel.
import { charToCode } from './keymap.js';

// Different invisible characters before and after the caret, so the diff can tell a Backspace
// (left side shrinks) from a forward Delete (right side shrinks).
const LEFT = '​'.repeat(12);   // zero-width space
const RIGHT = '⁠'.repeat(12);  // word joiner
const STRIP = /[​⁠]/g;

export class SoftKeyboard extends EventTarget {
  /** @param {object} ctx { sink, conn, keyboard (KeyboardInput), mods } */
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.open = false;
    this.composing = false;
    const s = ctx.sink;
    s.addEventListener('input', () => this._input());
    s.addEventListener('compositionstart', () => { this.composing = true; });
    s.addEventListener('compositionend', () => { this.composing = false; this._input(); });
    s.addEventListener('blur', () => { if (this.open) { this.open = false; this.dispatchEvent(new Event('change')); } });
    s.addEventListener('focus', () => this._reset());
    this._reset();
  }

  /** Must be called synchronously from a tap/click handler. */
  show() {
    const s = this.ctx.sink;
    this._reset();
    s.focus({ preventScroll: true });
    this.open = true;
    this.dispatchEvent(new Event('change'));
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

  _input() {
    if (this.composing) return;
    const v = this.ctx.sink.value;
    if (v === LEFT + RIGHT) return;
    let left = 0;
    while (left < v.length && v[left] === '​') left++;
    let right = 0;
    while (right < v.length - left && v[v.length - 1 - right] === '⁠') right++;
    const backspaces = Math.max(0, LEFT.length - left);
    const deletes = Math.max(0, RIGHT.length - right);
    const inserted = v.slice(left, v.length - right).replace(STRIP, '');
    const kb = this.ctx.keyboard;
    for (let i = 0; i < backspaces; i++) this._key('Backspace');
    for (let i = 0; i < deletes; i++) this._key('Delete');
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
        mods.pressForKey();
        if (m.shift || ch !== ch.toLowerCase()) this.ctx.keyboard.chord(['ShiftLeft', m.code]); else this.ctx.keyboard.tap(m.code);
        mods.consume();
      }
      return;
    }
    // Plain text: layout-independent Unicode injection on the host.
    this.ctx.conn.sendJson({ t: 'text', s: text });
  }
}
