// Extra-keys bar (Esc, Tab, Ctrl, Alt, Win, arrows, F-keys...) with sticky modifiers:
//   tap = one-shot (applies to the next key or click), tap again = lock, tap a locked one = release.
import { isApple } from '../platform.js';

export class StickyModifiers extends EventTarget {
  constructor(keyboard) {
    super();
    this.keyboard = keyboard;
    this.state = new Map();     // code -> 'once' | 'locked'
    this.pressed = new Set();   // codes we pressed on the host for the current key/click
  }

  toggle(code) {
    const s = this.state.get(code);
    if (!s) this.state.set(code, 'once');
    else if (s === 'once') this.state.set(code, 'locked');
    else { this.state.delete(code); if (this.pressed.has(code)) { this.keyboard.send(code, false); this.pressed.delete(code); } }
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
  { label: 'ctrl', code: 'ControlLeft', mod: true },
  { label: 'alt', code: 'AltLeft', mod: true },
  { label: 'win', code: 'MetaLeft', mod: true, title: 'Windows key' },
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
  { label: 'ins', code: 'Insert' }, { label: 'prtsc', code: 'PrintScreen' },
  { label: 'ctrl+alt+del', action: 'cad', wide: true },
];

export class ExtraKeysBar {
  constructor(el, { keyboard, mods, conn, onLayout }) {
    this.el = el;
    this.keyboard = keyboard;
    this.mods = mods;
    this.conn = conn;
    this.onLayout = onLayout;
    this.visible = false;
    this._render();
    mods.addEventListener('change', () => this._sync());
    const vv = window.visualViewport;
    vv?.addEventListener('resize', () => this.position());
    vv?.addEventListener('scroll', () => this.position());
  }

  _render() {
    this.el.replaceChildren();
    for (const k of KEYS) {
      if (k.sep) { const s = document.createElement('span'); s.className = 'xk-sep'; this.el.append(s); continue; }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'xk' + (k.mod ? ' mod' : '') + (k.wide ? ' wide' : '');
      b.textContent = k.code === 'MetaLeft' && isApple ? 'win' : k.label;
      if (k.title) b.title = k.title;
      if (k.code) b.dataset.code = k.code;
      // Keep focus on the hidden input so the iOS keyboard stays up while tapping bar keys.
      b.addEventListener('pointerdown', e => { e.preventDefault(); this._press(k, b); });
      b.addEventListener('pointerup', () => this._stopRepeat());
      b.addEventListener('pointercancel', () => this._stopRepeat());
      b.addEventListener('pointerleave', () => this._stopRepeat());
      this.el.append(b);
    }
  }

  _press(k, btn) {
    if (k.mod) { this.mods.toggle(k.code); return; }
    if (k.action === 'cad') { this.conn.sendJson({ t: 'special', action: 'cad' }); return; }
    const fire = () => { this.mods.pressForKey(); this.keyboard.tap(k.code); this.mods.consume(k.code); };
    fire();
    if (k.repeat) {
      this._stopRepeat();
      this._repeatT = setTimeout(() => { this._repeatI = setInterval(fire, 55); }, 380);
    }
  }

  _stopRepeat() {
    clearTimeout(this._repeatT); clearInterval(this._repeatI);
    this._repeatT = this._repeatI = 0;
  }

  _sync() {
    for (const b of this.el.querySelectorAll('.xk.mod')) {
      const s = this.mods.state.get(b.dataset.code);
      if (s) b.dataset.state = s; else delete b.dataset.state;
    }
  }

  show() { this.visible = true; this.el.hidden = false; this.position(); }
  hide() { this.visible = false; this.el.hidden = true; this.onLayout?.(0); }
  toggle() { if (this.visible) this.hide(); else this.show(); }

  /** Sit directly above the on-screen keyboard (visualViewport shrinks when it's up). */
  position() {
    if (!this.visible) return;
    const vv = window.visualViewport;
    const kbHeight = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    this.el.style.bottom = `${kbHeight}px`;
    this.el.style.paddingBottom = kbHeight > 0 ? '6px' : '';
    this.onLayout?.(this.el.offsetHeight + kbHeight);
  }
}
