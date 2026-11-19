// What you type on a phone's or tablet's on-screen keyboard, in a box on top of the keys while the keyboard is up (as in
// VNC Viewer): the field you're typing into on the computer may be under the keyboard, or too small to read. It shows
// what went to the computer since you last put the cursor somewhere, ending where the cursor is, and starts over
// when you click or tap the screen, press Enter, Esc, Tab or an arrow key, or close the keyboard. Shortcuts (a held
// Ctrl or ⌘ with a letter) show as keys, so a modifier left on is easy to spot. The eye in the box (ui/extrakeys.js)
// hides the text itself (dots instead, as in a password field) and shows it again.
import { h } from './dom.js';

const MAX_UNITS = 200;     // it shows the end of what you typed; older characters are dropped
const DOT = '•';
// Keys that take the cursor somewhere else, or finish what you were typing.
const MOVES = new Set(['Enter', 'NumpadEnter', 'Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown']);
const ORDER = ['ControlLeft', 'AltLeft', 'ShiftLeft', 'MetaLeft'];
const MAC_MODS = { ControlLeft: '⌃', AltLeft: '⌥', ShiftLeft: '⇧', MetaLeft: '⌘' };
const PC_MODS = { ControlLeft: 'Ctrl', AltLeft: 'Alt', ShiftLeft: 'Shift', MetaLeft: 'Win' };

export class TypingPreview {
  constructor(el) {
    this.el = el;
    this.line = h('div', { class: 'typed' });
    el.replaceChildren(this.line); // (the eye goes after it: ui/extrakeys.js)
    el.setAttribute('aria-hidden', 'true'); // it repeats the keyboard's own echo for screen readers
    this.units = [];         // what you typed: characters, and shortcuts as { keys: '⌘C' }
    this.hidden = false;     // the eye: dots instead of the text (a password, someone looking over your shoulder)
    this.mac = false;
    this._render();
  }

  setHost(os) { this.mac = os === 'macos'; }

  /** The eye: hide the text itself (it shows as dots) or show it. What's showing changes at once. */
  setHidden(on) {
    this.hidden = on;
    this.el.classList.toggle('dots', on);
    this._render();
  }

  /** The on-screen keyboard came up or went away: going away starts it over. */
  setActive(on) {
    if (!on) this.reset();
  }

  /** Text that went to the computer. A line break or a tab finishes what's shown: what follows is a new line or field. */
  text(s) {
    if (!s) return;
    const end = Math.max(s.lastIndexOf('\n'), s.lastIndexOf('\r'), s.lastIndexOf('\t'));
    if (end >= 0) { this.units = []; s = s.slice(end + 1); }
    for (const ch of s) this.units.push(ch);
    this._render();
  }

  /** Backspaces that went to the computer. */
  back(n = 1) {
    if (!this.units.length || n < 1) return;
    this.units.splice(-n, n);
    this._render();
  }

  /** A named key that went to the computer (from the keys bar, or a keyboard attached to the tablet). */
  key(code) {
    if (MOVES.has(code)) this.reset();
  }

  /** A letter typed while modifiers were held on the keys bar: it went as a shortcut. */
  shortcut(codes, ch) {
    const mods = ORDER.filter(c => codes.includes(c));
    const key = ch === ' ' ? 'Space' : ch.toUpperCase();
    const keys = this.mac ? mods.map(c => MAC_MODS[c]).join('') + key : [...mods.map(c => PC_MODS[c]), key].join('+');
    this.units.push({ keys });
    this._render();
  }

  /** You clicked, closed the keyboard, moved the cursor: what's shown no longer leads to it. */
  reset() {
    if (!this.units.length) return;
    this.units = [];
    this._render();
  }

  _render() {
    if (this.units.length > MAX_UNITS) this.units.splice(0, this.units.length - MAX_UNITS);
    const empty = !this.units.length;
    this.el.classList.toggle('blank', empty);
    if (empty) {
      this.line.replaceChildren(h('span', { class: 'typed-hint' }, 'What you type shows here'));
      this.el.classList.remove('clipped');
      return;
    }
    const nodes = [];
    let run = '';
    for (const u of this.units) {
      if (typeof u === 'string') { run += this.hidden ? DOT : u; continue; }
      if (run) { nodes.push(run); run = ''; }
      nodes.push(h('kbd', {}, u.keys)); // a shortcut isn't a secret: it stays readable
    }
    if (run) nodes.push(run);
    this.line.replaceChildren(...nodes);
    // The end shows (where the cursor is); when the start is cut off, it fades out at the left.
    this.line.scrollLeft = this.line.scrollWidth;
    this.el.classList.toggle('clipped', this.line.scrollLeft > 0);
  }
}
