// Bidirectional clipboard sync within browser rules:
//  local -> host: the 'paste' event (no prompt, every browser) + Chromium readText() on focus if already granted;
//  host -> local: writeText() when allowed, otherwise deferred to the next tap/keypress (a user gesture);
//  Cmd/Ctrl+C: a gesture-privileged ClipboardItem whose content is a promise that resolves when the host's
//  new clipboard arrives — the only way Safari lets a page write clipboard data that arrives later.

export class ClipboardSync extends EventTarget {
  constructor(conn) {
    super();
    this.conn = conn;
    this.remote = '';
    this.pending = null;
    this.lastPushed = null;
    this.waiting = null;
    this._onFocus = () => this._readLocalIfGranted();
    window.addEventListener('focus', this._onFocus);
    document.addEventListener('visibilitychange', this._onFocus);
  }

  dispose() {
    window.removeEventListener('focus', this._onFocus);
    document.removeEventListener('visibilitychange', this._onFocus);
  }

  /** Host clipboard changed. */
  onRemote(text) {
    this.remote = text;
    this.dispatchEvent(new CustomEvent('remote', { detail: text }));
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.resolve(text);
      this.waiting = null;
      return;
    }
    this._tryWrite(text);
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
    if (this.pending == null || !navigator.clipboard?.writeText) return;
    const text = this.pending;
    navigator.clipboard.writeText(text).then(() => {
      if (this.pending === text) this.pending = null;
      this.lastPushed = text;
    }, () => { });
  }

  /** Cmd/Ctrl+C or X was just pressed (inside the keydown handler). */
  expectRemoteCopy() {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return;
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

  /** Local clipboard text to put on the host (from paste events / manual panel). */
  pushLocal(text) {
    if (text == null || text === this.lastPushed || text === this.remote) return;
    this.lastPushed = text;
    this.conn.sendJson({ t: 'clip', text });
  }

  async _readLocalIfGranted() {
    if (document.visibilityState !== 'visible' || !navigator.clipboard?.readText || !navigator.permissions) return;
    try {
      const st = await navigator.permissions.query({ name: 'clipboard-read' });
      if (st.state !== 'granted') return; // never prompt on focus
      const text = await navigator.clipboard.readText();
      if (text) this.pushLocal(text);
    } catch { /* Safari has no clipboard-read permission name */ }
  }

  /** Explicit "send my clipboard" (button): prompts in Chromium, shows the Paste callout in Safari. */
  async readLocalExplicit() {
    const text = await navigator.clipboard.readText();
    this.lastPushed = null;
    this.pushLocal(text);
    return text;
  }
}
