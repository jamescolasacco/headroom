// Bidirectional clipboard sync within browser rules:
//  local -> host: the 'paste' event (no prompt, every browser) + Chromium readText() on focus if already granted;
//  host -> local: writeText() when allowed, otherwise deferred to the next tap/keypress (a user gesture);
//  Cmd/Ctrl+C: a gesture-privileged ClipboardItem whose content is a promise that resolves when the host's
//  new clipboard arrives — the only way Safari lets a page write clipboard data that arrives later.

// Clipboard text goes in one WebSocket message, and every leg (the hosts, the relay) takes messages up to 16 MiB: more
// would drop the connection. Text over this isn't synced, either way (the hosts hold the same limit).
export const MAX_CLIP_BYTES = 4 * 1024 * 1024;
export function clipTooLarge(text) {
  if (text.length * 3 <= MAX_CLIP_BYTES) return false; // UTF-8 takes at most 3 bytes per UTF-16 unit
  return text.length > MAX_CLIP_BYTES || new TextEncoder().encode(text).length > MAX_CLIP_BYTES;
}

export class ClipboardSync extends EventTarget {
  constructor(conn, allowed) {
    super();
    this.conn = conn;
    this.allowed = allowed;
    this.remote = '';
    this.pending = null;
    this.lastPushed = null;
    this.waiting = null;
    this._onFocus = () => this._readLocalIfGranted();
    window.addEventListener('focus', this._onFocus);
    document.addEventListener('visibilitychange', this._onFocus);
  }

  dispose() {
    this.clear();
    window.removeEventListener('focus', this._onFocus);
    document.removeEventListener('visibilitychange', this._onFocus);
  }

  clear() {
    this.remote = '';
    this.pending = null;
    this.lastPushed = null;
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.reject(new Error('clipboard sync ended'));
      this.waiting = null;
    }
  }

  /** Host clipboard changed. */
  onRemote(text) {
    if (!this.allowed()) return;
    this.lastPushed = null;
    this.remote = text;
    this.dispatchEvent(new CustomEvent('remote', { detail: text }));
    // No text there (nothing copied, an image, or text too large to come over): this device's clipboard keeps what it
    // has. Writing "" would only wipe it.
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      if (text) this.waiting.resolve(text); else this.waiting.reject(new Error('no text on the other computer'));
      this.waiting = null;
      return;
    }
    if (text) this._tryWrite(text);
  }

  _tryWrite(text) {
    this.pending = text;
    if (!navigator.clipboard?.writeText || !document.hasFocus()) return;
    navigator.clipboard.writeText(text).then(() => {
      if (this.pending === text) this.pending = null;
      this.lastPushed = text;
    }, () => { /* needs a gesture: flushed by onUserGesture */ });
  }

  /** Call from keydown/pointerdown handlers (transient user activation). */
  onUserGesture() {
    if (!this.allowed() || this.pending == null || !navigator.clipboard?.writeText) return;
    const text = this.pending;
    navigator.clipboard.writeText(text).then(() => {
      if (this.pending === text) this.pending = null;
      this.lastPushed = text;
    }, () => { });
  }

  /** Cmd/Ctrl+C or X was just pressed (inside the keydown handler). */
  expectRemoteCopy() {
    if (!this.allowed() || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return;
    if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting.reject(new Error('superseded')); }
    const p = new Promise((resolve, reject) => {
      this.waiting = { resolve, reject, timer: setTimeout(() => { this.waiting = null; reject(new Error('no clipboard change')); }, 1500) };
    });
    try {
      const item = new ClipboardItem({ 'text/plain': p.then(t => new Blob([t], { type: 'text/plain' })) });
      navigator.clipboard.write([item]).then(() => { this.pending = null; }, () => { });
    } catch { /* older engines: fall back to the deferred path */ }
    p.catch(() => { });
  }

  /**
   * Local clipboard text to put on the host (from paste events / manual panel). Says what happened: 'sent', 'same' (the
   * host has it already), 'off' (not allowed, or not connected right now) or 'too-large'.
   */
  pushLocal(text) {
    if (!this.allowed() || text == null) return 'off';
    if (text === this.lastPushed || text === this.remote) return 'same';
    if (clipTooLarge(text)) return 'too-large';
    this.lastPushed = text;
    this.conn.sendJson({ t: 'clip', text });
    return 'sent';
  }

  async _readLocalIfGranted() {
    if (!this.allowed() || document.visibilityState !== 'visible' || !navigator.clipboard?.readText || !navigator.permissions) return;
    try {
      const st = await navigator.permissions.query({ name: 'clipboard-read' });
      if (!this.allowed() || st.state !== 'granted') return; // never prompt on focus
      const text = await navigator.clipboard.readText();
      if (text) this.pushLocal(text);
    } catch { /* Safari has no clipboard-read permission name */ }
  }

  /**
   * Explicit "send my clipboard" (button): prompts in Chromium, shows the Paste callout in Safari. Resolves with the
   * text and what pushLocal did with it.
   */
  async readLocalExplicit() {
    if (!this.allowed()) throw new Error('clipboard unavailable');
    const text = await navigator.clipboard.readText();
    if (!this.allowed()) throw new Error('clipboard unavailable');
    this.lastPushed = null;
    return { text, status: this.pushLocal(text) };
  }
}
