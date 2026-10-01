// Physical keyboard -> host. Scancode-positional (event.code), so the host's layout decides characters and
// every shortcut works like a keyboard plugged into the host.
import * as P from '../protocol.js';
import { isApple, hasKeyboardLock } from '../platform.js';
import { codeFromEvent, isModifier, macCmdTranslation, macOptionTranslation } from './keymap.js';

export class KeyboardInput {
  /**
   * @param {object} ctx { conn, mods (sticky modifiers), sink (textarea), clipboard, onLocalHotkey(key) }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.profile = 'pc';
    this.enabled = false;
    this.down = new Set();          // codes we told the host are down
    this.deferred = new Map();      // modifier code -> { sent, used } (Mac profile)
    this.swallowUp = new Set();     // keys whose keyup must not be forwarded (translated chords)
    this.metaHeldKeys = new Set();  // keys pressed while Cmd held (their keyup may never arrive on macOS)
    this.pendingPaste = null;
    this.lastLocks = null;
    this._onDown = e => this._keydown(e);
    this._onUp = e => this._keyup(e);
    this._onPaste = e => this._paste(e);
    this._onBlur = () => this.releaseAll();
  }

  setProfile(p) { this.profile = p === 'auto' ? (isApple ? 'mac' : 'pc') : p; }

  attach() {
    this.enabled = true;
    window.addEventListener('keydown', this._onDown, true);
    window.addEventListener('keyup', this._onUp, true);
    document.addEventListener('paste', this._onPaste, true);
    window.addEventListener('blur', this._onBlur);
  }

  detach() {
    this.releaseAll();
    this.enabled = false;
    window.removeEventListener('keydown', this._onDown, true);
    window.removeEventListener('keyup', this._onUp, true);
    document.removeEventListener('paste', this._onPaste, true);
    window.removeEventListener('blur', this._onBlur);
  }

  // ------------------------------------------------------------------ host I/O

  send(code, isDown) {
    if (isDown) this.down.add(code); else this.down.delete(code);
    this.ctx.conn.sendBinary(P.key(code, isDown));
  }

  /**
   * Press codes in order then release in reverse. '+X' = release everything so far, then tap X.
   * '-Shift' = temporarily lift a physically held Shift for this chord.
   */
  chord(codes) {
    const held = [];
    const lifted = [];
    for (const c of codes) {
      if (c === '-Shift') {
        for (const s of ['ShiftLeft', 'ShiftRight']) if (this.down.has(s)) { this.send(s, false); lifted.push(s); }
        continue;
      }
      if (c.startsWith('+')) {
        while (held.length) this.send(held.pop(), false);
        this.send(c.slice(1), true); this.send(c.slice(1), false);
        continue;
      }
      if (this.down.has(c)) continue; // already physically held (e.g. Shift)
      this.send(c, true);
      held.push(c);
    }
    while (held.length) this.send(held.pop(), false);
    for (const s of lifted) this.send(s, true);
  }

  tap(code) { this.send(code, true); this.send(code, false); }

  releaseAll() {
    for (const c of [...this.down]) this.send(c, false);
    this.down.clear();
    this.deferred.clear();
    this.swallowUp.clear();
    this.metaHeldKeys.clear();
    this.ctx.conn.sendJson({ t: 'release' });
  }

  // ------------------------------------------------------------------ events

  _ours(e) {
    if (!this.enabled) return false;
    const t = e.target;
    if (t && t !== this.ctx.sink && t !== document.body && t.closest) {
      // Typing into our own UI (dialogs, sheets) stays local.
      if (t.closest('#sheet, dialog, .local-input')) return false;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t !== this.ctx.sink) return false;
    }
    if (this.ctx.softKeyboardHandles?.(e)) return false; // soft keyboard sends text instead
    return true;
  }

  _syncLocks(e) {
    if (!e.getModifierState) return;
    const caps = e.getModifierState('CapsLock'), num = e.getModifierState('NumLock');
    const key = `${caps}|${num}`;
    if (key === this.lastLocks) return;
    this.lastLocks = key;
    this.ctx.conn.sendJson({ t: 'locks', caps, num });
  }

  _keydown(e) {
    if (!this._ours(e)) return;
    this.ctx.onUserGesture?.(e);
    const code = codeFromEvent(e);
    if (!code) return;

    // Local hotkeys: Ctrl+Alt+Shift+<key> never reach the host.
    if (e.ctrlKey && e.altKey && e.shiftKey && !isModifier(code)) {
      if (this.ctx.onLocalHotkey?.(code)) { e.preventDefault(); e.stopPropagation(); return; }
    }

    if (!e.repeat) this._syncLocks(e);

    // Caps Lock on Apple keyboards reports state changes, not presses: each transition = one tap.
    if (code === 'CapsLock' && isApple) {
      e.preventDefault();
      this.tap('CapsLock');
      return;
    }

    // Paste: let the browser fire 'paste' so we get clipboard text without a permission prompt,
    // push it to the host, then replay the shortcut (Selkies-style ordering hold).
    const pasteCombo = code === 'KeyV' && (this.profile === 'pc' ? e.ctrlKey && !e.metaKey : (e.metaKey || e.ctrlKey)) && !e.altKey;
    if (pasteCombo && !e.repeat) {
      let action = this._resolve(code, e);
      // Replay as a self-contained chord: the user may release Ctrl before the replay fires.
      if (action.kind === 'key') {
        const mods = [];
        if (e.ctrlKey) mods.push(this.down.has('ControlRight') ? 'ControlRight' : 'ControlLeft');
        if (e.shiftKey) mods.push('ShiftLeft');
        if (e.altKey) mods.push('AltLeft');
        action = { kind: 'chord', codes: [...mods, action.code] };
      }
      // The deferred Cmd was "used" by this shortcut: releasing it must not tap Win (Start menu).
      for (const d of this.deferred.values()) d.used = true;
      if (this.pendingPaste) clearTimeout(this.pendingPaste.timer);
      this.pendingPaste = { action, timer: setTimeout(() => this._flushPaste(), 150) };
      this.swallowUp.add(code);
      this.ctx.sink?.focus({ preventScroll: true });
      return; // no preventDefault
    }

    // Copy/cut: keep a gesture-privileged clipboard write waiting for the host's new clipboard.
    if ((code === 'KeyC' || code === 'KeyX') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.repeat) {
      this.ctx.clipboard?.expectRemoteCopy();
    }

    e.preventDefault();
    e.stopPropagation();
    if (!isModifier(code)) this.ctx.mods?.pressForKey();
    this._perform(this._resolve(code, e), code, e);
    this.ctx.mods?.consume(code);
  }

  _keyup(e) {
    if (!this.enabled) return;
    const code = codeFromEvent(e);
    if (!code) return;
    if (!this._ours(e) && !this.down.has(code) && !this.deferred.has(code)) return;
    e.preventDefault();
    if (code === 'CapsLock' && isApple) { this.tap('CapsLock'); return; }

    // Deferred modifiers (Mac profile): released without being used = a tap (Cmd alone opens Start).
    const d = this.deferred.get(code);
    if (d) {
      this.deferred.delete(code);
      const hostCode = d.sentAs || this._mapModifier(code);
      if (d.sent) this.send(hostCode, false);
      else if (!d.used) this.tap(hostCode);
      if (code.startsWith('Meta')) {
        // macOS drops keyups for keys pressed while Cmd was held: release them now.
        for (const k of this.metaHeldKeys) if (this.down.has(k)) this.send(k, false);
        this.metaHeldKeys.clear();
      }
      return;
    }
    if (this.swallowUp.delete(code)) return;
    const hostCode = this._mapPlain(code);
    if (this.down.has(hostCode)) this.send(hostCode, false);
  }

  _paste(e) {
    if (!this.enabled) return;
    const t = e.target;
    if (t && t.closest && t.closest('#sheet, dialog, .local-input')) return;
    const text = e.clipboardData?.getData('text/plain');
    e.preventDefault();
    if (text) this.ctx.clipboard?.pushLocal(text);
    if (this.pendingPaste) {
      clearTimeout(this.pendingPaste.timer);
      const { action } = this.pendingPaste;
      this.pendingPaste = null;
      // Give the host a moment to set its clipboard before the keystroke lands.
      setTimeout(() => this._replay(action), text ? 40 : 0);
    } else if (text) {
      // Paste from the browser's menu: paste on the host too.
      setTimeout(() => this.chord(['ControlLeft', 'KeyV']), 40);
    }
  }

  _flushPaste() {
    if (!this.pendingPaste) return;
    const { action } = this.pendingPaste;
    this.pendingPaste = null;
    this._replay(action);
  }

  /** Replays a held-back shortcut as a complete press (its physical keyup is swallowed). */
  _replay(action) {
    if (action.kind === 'key') {
      this._perform(action, 'KeyV', null);
      if (this.down.has(action.code)) this.send(action.code, false);
    } else {
      this._perform(action, 'KeyV', null);
    }
  }

  /**
   * A mouse button is about to go down: deferred modifiers (Mac profile) must reach the host now so
   * Cmd+click = Ctrl+click (multi-select), Option+click = Alt+click, Cmd+Shift+click, etc.
   */
  prepareClick() {
    for (const [mod, d] of this.deferred) {
      d.used = true;
      if (d.sent) continue;
      const hostCode = this.profile === 'mac' && (mod.startsWith('Meta') || mod.startsWith('OS')) ? 'ControlLeft' : this._mapModifier(mod);
      this.send(hostCode, true);
      d.sent = true;
      d.sentAs = hostCode;
    }
  }

  // ------------------------------------------------------------------ translation

  _mapModifier(code) {
    if (this.profile === 'cmdctrl') {
      if (code === 'MetaLeft' || code === 'OSLeft') return 'ControlLeft';
      if (code === 'MetaRight' || code === 'OSRight') return 'ControlRight';
      if (code === 'ControlLeft') return 'MetaLeft';
      if (code === 'ControlRight') return 'MetaRight';
    }
    if (code === 'OSLeft') return 'MetaLeft';
    if (code === 'OSRight') return 'MetaRight';
    return code;
  }

  _mapPlain(code) { return isModifier(code) ? this._mapModifier(code) : code; }

  /** Returns { kind: 'chord', codes } | { kind: 'key', code } | { kind: 'defer' } */
  _resolve(code, e) {
    if (this.profile === 'mac') {
      if (code.startsWith('Meta') || code.startsWith('OS') || code === 'AltLeft') return { kind: 'defer' };
      const cmd = [...this.deferred.keys()].some(k => k.startsWith('Meta') || k.startsWith('OS'));
      const opt = this.deferred.has('AltLeft');
      if (cmd) {
        const tr = macCmdTranslation(code, { shift: e?.shiftKey });
        if (tr) return { kind: 'chord', codes: tr, uses: 'cmd' };
      } else if (opt) {
        const tr = macOptionTranslation(code);
        if (tr) return { kind: 'chord', codes: tr, uses: 'opt' };
      }
    }
    return { kind: 'key', code: this._mapPlain(code) };
  }

  _perform(action, physicalCode, e) {
    if (action.kind === 'defer') {
      if (!this.deferred.has(physicalCode)) this.deferred.set(physicalCode, { sent: false, used: false });
      return;
    }
    if (action.kind === 'chord') {
      for (const d of this.deferred.values()) d.used = true;
      // Shift may be physically held; keep it, the chord adds the rest.
      this.chord(action.codes);
      this.swallowUp.add(physicalCode);
      return;
    }
    // A plain key: any deferred modifiers now really go down (Cmd+E -> Win+E, Option+Tab -> Alt+Tab).
    for (const [mod, d] of this.deferred) {
      d.used = true;
      if (!d.sent) { this.send(this._mapModifier(mod), true); d.sent = true; }
    }
    const code = action.code;
    if (e?.repeat && !this.down.has(code) && !isModifier(code)) { /* repeat after a synthesized up */ }
    this.send(code, true);
    const metaHeld = e && e.metaKey && isApple && !isModifier(physicalCode);
    if (metaHeld) {
      // No keyup will come while Cmd is held on macOS/iPadOS: complete the press now.
      this.send(code, false);
      this.swallowUp.add(physicalCode);
      this.metaHeldKeys.add(code);
    }
  }

  // ------------------------------------------------------------------ keyboard lock (Chromium fullscreen)

  async lockSystemKeys() {
    if (!hasKeyboardLock) return false;
    try {
      await navigator.keyboard.lock(); // no args = everything, incl. Alt+Tab / Win (Chromium hooks only then)
      return true;
    } catch { return false; }
  }

  unlockSystemKeys() {
    try { navigator.keyboard?.unlock(); } catch { }
  }
}
