// A live remote-desktop session: wires connection, video, audio, input, clipboard and UI together.
import { Connection } from './connection.js';
import { VideoPresenter } from './video/presenter.js';
import { AudioPlayer } from './audio/player.js';
import { Viewport } from './viewport.js';
import { CursorRenderer } from './cursor.js';
import { KeyboardInput } from './input/keyboard.js';
import { MouseInput } from './input/mouse.js';
import { TouchInput } from './input/touch.js';
import { SoftKeyboard } from './input/softkbd.js';
import { StickyModifiers, ExtraKeysBar } from './ui/extrakeys.js';
import { ClipboardSync } from './clipboard.js';
import { Toolbar } from './ui/toolbar.js';
import { StatsOverlay } from './ui/stats.js';
import { loadPrefs, savePrefs, touchHost } from './store.js';
import { isIPhone, isIPad, isTouchPrimary, hasWebCodecs, secure, canFullscreen, isApple, postNative, onNative } from './platform.js';
import { toast, closeSheet, h } from './ui/dom.js';

const $ = id => document.getElementById(id);

export class Session {
  constructor(host, { onExit, onUnauthorized }) {
    this.host = host;
    this.onExit = onExit;
    this.onUnauthorized = onUnauthorized;
    this.prefs = loadPrefs(host.id);
    this.monitors = [];
    this.monitorId = this.prefs.monitor || null;
    this.permissions = { input: true, clipboard: true, files: true, audio: true };
    this.hostStats = null;
    this.videoConfig = null;
    this.lastFrameAt = 0;
    this.frameStats = { receiveMs: 0, encodeMs: 0 };
    this.keyframeAskedAt = 0;
    this.wakeLock = null;
    this.relative = false;
    this.disposed = false;
    this.audio = new AudioPlayer();
  }

  /** Must run inside the user's tap (audio unlock + fullscreen need a gesture). */
  unlockFromGesture() {
    if (this.prefs.audio) this.audio.unlock();
  }

  async start() {
    if (!secure || !hasWebCodecs) {
      this._overlay('This browser can\'t decode the stream', !secure
        ? 'Open Headroom over HTTPS (or localhost). Video decoding needs a secure connection.'
        : 'WebCodecs is required (Safari 16.4+, Chrome/Edge 94+, Firefox 130+).', false, [{ label: 'Back', onClick: () => this.stop() }]);
      return;
    }
    $('home').hidden = true;
    $('viewer').hidden = false;
    document.title = `${this.host.name} — Headroom`;

    const viewer = $('viewer'), stage = $('stage'), layer = $('input-layer'), sink = $('kbd-sink');
    this.viewport = new Viewport(viewer, stage);
    this.viewport.mode = this.prefs.scaling;
    this.cursor = new CursorRenderer(layer, $('remote-cursor'), this.viewport);
    this.presenter = new VideoPresenter({ video: $('video'), canvas: $('canvas'), preference: this.prefs.renderer });
    this.conn = new Connection(this.host);
    this.clipboard = new ClipboardSync(this.conn);
    this.mods = new StickyModifiers(null);

    const inputAllowed = () => this.permissions.input && this.conn.isOpen;
    const onUserGesture = () => { this.clipboard.onUserGesture(); this.audio.ctx?.state === 'suspended' && this.audio.ctx.resume().catch(() => { }); };

    this.keyboard = new KeyboardInput({
      conn: this.conn, mods: this.mods, sink, clipboard: this.clipboard, onUserGesture,
      onLocalHotkey: code => this._hotkey(code),
      softKeyboardHandles: e => this.softkbd?.handles(e),
    });
    this.mods.keyboard = this.keyboard;
    this.keyboard.setProfile(this.prefs.keyboardProfile);

    this.mouse = new MouseInput({
      conn: this.conn, viewport: this.viewport, cursor: this.cursor, layer, mods: this.mods, keyboard: this.keyboard,
      sink: isTouchPrimary ? null : sink, onUserGesture, inputAllowed,
      onRelativeChange: rel => { this.relative = rel; this.toolbar?.refresh(); if (rel) toast('Mouse captured — press Esc to release'); },
    });

    this.softkbd = new SoftKeyboard({ sink, conn: this.conn, keyboard: this.keyboard, mods: this.mods });
    this.extraKeys = new ExtraKeysBar($('extra-keys'), {
      keyboard: this.keyboard, mods: this.mods, conn: this.conn,
      onLayout: px => this.viewport.setInsetBottom(px),
    });
    this.softkbd.addEventListener('change', () => {
      if (this.softkbd.open) this.extraKeys.show();
      this.toolbar?.refresh();
    });

    this.touch = new TouchInput({
      conn: this.conn, viewport: this.viewport, cursor: this.cursor, layer, mods: this.mods, onUserGesture,
      ripple: (x, y, kind) => this._ripple(x, y, kind),
      toggleKeyboard: () => this.toggleKeyboard(),
      prefs: () => this.prefs,
    });
    this.touch.setMode(this.inputMode);
    if (!isTouchPrimary) this.cursor.setMode('css');

    this.toolbar = new Toolbar(this);
    this.stats = new StatsOverlay($('stats'), this);
    this.stats.setVisible(this.prefs.stats);

    this._wireConnection();
    this._wirePresenter();
    this._wireLifecycle();

    await this.presenter.start();
    this.keyboard.attach();
    this.mouse.attach();
    this.touch.attach();
    this.audio.setEnabled(this.prefs.audio);
    if (!isTouchPrimary) sink.focus({ preventScroll: true });
    this._overlay('Connecting…', this.host.url.replace(/^https?:\/\//, ''), true);
    // Headroom Viewer (Windows): its keyboard hook captures Win/Alt+Tab/PrtScn while a session is up.
    this._offNative = onNative(m => {
      if (m?.type === 'nativeKey') this.keyboard.nativeKey(m.code, m.down);
    });
    postNative({ cmd: 'session', active: true, host: this.host.name });
    this.conn.connect();
    this.toolbar.peek(3500);
    this._requestWakeLock();
    touchHost(this.host.id, { lastConnected: Date.now() });
  }

  get inputMode() {
    const m = this.prefs.inputMode;
    if (m === 'trackpad' || m === 'touch') return m;
    return isIPhone ? 'trackpad' : 'touch';
  }

  setPref(key, value) {
    this.prefs[key] = value;
    savePrefs(this.host.id, { [key]: value });
    switch (key) {
      case 'inputMode': this.touch.setMode(this.inputMode); break;
      case 'keyboardProfile': this.keyboard.setProfile(value); break;
      case 'scaling': this.viewport.setMode(value); break;
      case 'audio':
        if (value) this.audio.unlock();
        this.audio.setEnabled(value);
        this.conn.sendJson({ t: 'audio', enabled: value });
        break;
      case 'stats': this.stats.setVisible(value); break;
      case 'maxFps': case 'maxBitrateKbps': case 'resolution': this.sendStart(); break;
    }
    this.toolbar?.refresh();
  }

  // ------------------------------------------------------------------ connection

  _wireConnection() {
    const c = this.conn;
    c.addEventListener('welcome', e => {
      const w = e.detail;
      this.monitors = w.monitors || [];
      this.permissions = w.permissions || this.permissions;
      this.elevated = w.elevated;
      if (!this.monitors.some(m => m.id === this.monitorId)) this.monitorId = (this.monitors.find(m => m.primary) || this.monitors[0])?.id;
      this.sendStart();
      this.toolbar.refresh();
    });
    c.addEventListener('video-config', e => {
      const cfg = e.detail;
      this.videoConfig = cfg;
      this.presenter.configure(cfg);
      this.viewport.setSizes(cfg.width, cfg.height, cfg.sourceWidth, cfg.sourceHeight);
      this.monitorId = cfg.monitor;
      this._hideOverlay();
    });
    c.addEventListener('video-frame', e => {
      const f = e.detail;
      this.lastFrameAt = performance.now();
      this.frameStats.receiveMs = f.receiveMs;
      this.frameStats.encodeMs = f.encodeMs;
      this.presenter.frame(f);
    });
    c.addEventListener('cursor-shape', e => this.cursor.setShape(e.detail));
    c.addEventListener('cursor-pos', e => {
      const p = e.detail;
      this.cursor.setPosition(p.x, p.y, p.visible);
      const v = this.viewport;
      if (v.srcW) this.touch.remoteCursor(p.x / v.srcW, p.y / v.srcH);
    });
    c.addEventListener('audio', e => this.audio.packet(e.detail));
    c.addEventListener('clip', e => this.clipboard.onRemote(e.detail.text || ''));
    c.addEventListener('stats', e => { this.hostStats = e.detail; });
    c.addEventListener('notice', e => toast(e.detail.message, 5000));
    c.addEventListener('monitors', e => { this.monitors = e.detail.monitors; this.toolbar.refresh(); });
    c.addEventListener('status', e => {
      const s = e.detail;
      if (s.capture === 'secure-desktop') {
        this._overlay('Secure desktop', s.elevated
          ? 'Switching to the Windows secure desktop…'
          : 'A UAC prompt or the lock screen is showing. Windows only lets Headroom see it when running as a service (headroom service install).',
          !!s.elevated);
      } else if (s.capture === 'unavailable') {
        this._overlay('Display unavailable', s.detail || 'The host can\'t capture this display right now. Retrying…', true);
      } else if (s.capture === 'ok' && this.videoConfig) {
        this._hideOverlay();
      }
    });
    c.addEventListener('fatal', e => {
      const m = e.detail;
      if (m.code === 'unauthorized') {
        this._overlay('Not paired', m.message || 'This device is no longer paired with the computer.', false, [
          { label: 'Pair again', primary: true, onClick: () => { this.stop(); this.onUnauthorized?.(this.host); } },
          { label: 'Back', onClick: () => this.stop() },
        ]);
      } else if (m.code === 'rate-limited') {
        this._overlay('Too many attempts', `Try again in ${m.retryAfter || 60} seconds.`, false, [{ label: 'Back', onClick: () => this.stop() }]);
      }
    });
    c.addEventListener('state', e => {
      const { state, attempt, reason } = e.detail;
      if (state === 'reconnecting') {
        this.keyboard?.releaseAll();
        this._overlay('Reconnecting…', attempt > 2 ? `Can't reach ${this.host.name}. Still trying (${reason || 'network'}).` : '', true,
          [{ label: 'Disconnect', onClick: () => this.stop() }]);
      } else if (state === 'open') {
        if (!this.videoConfig) this._overlay('Starting stream…', '', true);
      }
    });
  }

  sendStart() {
    if (!this.conn?.isOpen) return;
    const res = this.prefs.resolution;
    const dpr = window.devicePixelRatio || 1;
    let maxWidth = 0, maxHeight = 0;
    if (res === '1080') { maxWidth = 1920; maxHeight = 1080; }
    else if (res === '720') { maxWidth = 1280; maxHeight = 720; }
    else if (res === '1440') { maxWidth = 2560; maxHeight = 1440; }
    else if (res === 'device') {
      // Cap both dimensions at this screen's long side in device pixels (works in either orientation;
      // the host preserves aspect ratio).
      maxWidth = maxHeight = Math.round(Math.max(screen.width, screen.height) * dpr);
    }
    this.conn.sendJson({
      t: 'start',
      monitor: this.monitorId,
      maxFps: this.prefs.maxFps,
      maxBitrateKbps: this.prefs.maxBitrateKbps || undefined,
      maxWidth, maxHeight,
      audio: !!this.prefs.audio && this.audio.supported,
    });
  }

  selectMonitor(id) {
    this.monitorId = id;
    savePrefs(this.host.id, { monitor: id });
    this.sendStart();
    this.toolbar.refresh();
  }

  cycleMonitor(dir) {
    if (this.monitors.length < 2) return;
    const i = this.monitors.findIndex(m => m.id === this.monitorId);
    const next = this.monitors[(i + dir + this.monitors.length) % this.monitors.length];
    this.selectMonitor(next.id);
    toast(next.name);
  }

  _wirePresenter() {
    this.presenter.addEventListener('need-keyframe', () => {
      const now = performance.now();
      if (now - this.keyframeAskedAt < 500) return;
      this.keyframeAskedAt = now;
      this.conn.sendJson({ t: 'keyframe' });
    });
    this.presenter.addEventListener('decoded', e => { this.frameStats.decodeMs = e.detail.decodeMs; });
  }

  // ------------------------------------------------------------------ lifecycle

  _wireLifecycle() {
    this._onVis = () => {
      if (document.visibilityState === 'hidden') {
        this.keyboard.releaseAll();
        this.mouse.releaseAll();
      } else {
        this._requestWakeLock();
        if (this.conn.state !== 'open' && !this.conn.closedByUser) this.conn.reconnectNow();
        else this.conn.sendJson({ t: 'keyframe' });
      }
    };
    this._onPageShow = e => { if (e.persisted && !this.conn.isOpen) this.conn.reconnectNow(); };
    this._onGesture = e => e.preventDefault();
    this._onTouchMove = e => { if (!e.target.closest?.('#sheet, #extra-keys')) e.preventDefault(); };
    this._onFs = () => this._fullscreenChanged();
    this._onMouseTop = e => { if (e.clientY < 6 && e.pointerType === 'mouse') this.toolbar.peek(2500); };
    this._onDragOver = e => { if (this.permissions.files && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); this._dropHint(true); } };
    this._onDragLeave = e => { if (!e.relatedTarget) this._dropHint(false); };
    this._onDrop = e => {
      this._dropHint(false);
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      this.toolbar.uploadFiles([...e.dataTransfer.files]);
    };
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('pageshow', this._onPageShow);
    document.addEventListener('gesturestart', this._onGesture, { passive: false });
    document.addEventListener('gesturechange', this._onGesture, { passive: false });
    document.addEventListener('touchmove', this._onTouchMove, { passive: false });
    document.addEventListener('fullscreenchange', this._onFs);
    document.addEventListener('webkitfullscreenchange', this._onFs);
    window.addEventListener('pointermove', this._onMouseTop);
    window.addEventListener('dragover', this._onDragOver);
    window.addEventListener('dragleave', this._onDragLeave);
    window.addEventListener('drop', this._onDrop);
    $('toolbar-handle').onclick = () => this.toolbar.peek(4000);
    $('toolbar-handle').onpointerdown = e => e.stopPropagation();
  }

  _dropHint(on) {
    let el = document.querySelector('.drop-hint');
    if (on && !el) $('viewer').append(h('div', { class: 'drop-hint' }, `Drop to send to ${this.host.name}`));
    if (!on && el) el.remove();
  }

  async _requestWakeLock() {
    try {
      if (navigator.wakeLock && document.visibilityState === 'visible' && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
      }
    } catch { /* not allowed (e.g. low battery) */ }
  }

  // ------------------------------------------------------------------ actions

  toggleKeyboard() {
    if (isTouchPrimary || isIPad) {
      this.softkbd.toggle();
      if (!this.softkbd.open && !this.extraKeysPinned) this.extraKeys.hide();
    } else {
      this.extraKeys.toggle();
    }
    this.toolbar.refresh();
  }

  toggleExtraKeys() {
    this.extraKeysPinned = !this.extraKeys.visible;
    this.extraKeys.toggle();
    this.toolbar.refresh();
  }

  get fullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }

  async toggleFullscreen() {
    if (!canFullscreen()) return;
    if (this.fullscreen) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) {
        // Safari 26.4+: lets the page receive Escape and Cmd shortcuts (feature may be disabled).
        try { await el.requestFullscreen({ navigationUI: 'hide', keyboardLock: 'browser' }); }
        catch { await el.requestFullscreen({ navigationUI: 'hide' }); }
      } else el.webkitRequestFullscreen();
    } catch (e) { toast('Full screen was blocked'); }
  }

  async _fullscreenChanged() {
    if (this.fullscreen) {
      const locked = await this.keyboard.lockSystemKeys();
      if (locked) toast(isApple ? 'Full screen — system shortcuts go to the remote. Hold Esc to exit.' : 'Full screen — Alt+Tab, Win and Esc go to the remote. Hold Esc to exit.', 4000);
    } else {
      this.keyboard.unlockSystemKeys();
    }
    setTimeout(() => this.viewport.layout(), 50);
    this.toolbar.refresh();
  }

  async toggleRelativeMouse() {
    if (this.relative) await this.mouse.setRelative(false);
    else await this.mouse.setRelative(true);
  }

  special(action) {
    switch (action) {
      case 'cad': this.conn.sendJson({ t: 'special', action: 'cad' }); break;
      case 'lock': this.conn.sendJson({ t: 'special', action: 'lock' }); break;
      case 'taskmgr': this.keyboard.chord(['ControlLeft', 'ShiftLeft', 'Escape']); break;
      case 'win': this.keyboard.tap('MetaLeft'); break;
      case 'alttab': this.keyboard.chord(['AltLeft', 'Tab']); break;
      case 'wintab': this.keyboard.chord(['MetaLeft', 'Tab']); break;
      case 'desktop': this.keyboard.chord(['MetaLeft', 'KeyD']); break;
      case 'explorer': this.keyboard.chord(['MetaLeft', 'KeyE']); break;
      case 'run': this.keyboard.chord(['MetaLeft', 'KeyR']); break;
      case 'settings': this.keyboard.chord(['MetaLeft', 'KeyI']); break;
      case 'altf4': this.keyboard.chord(['AltLeft', 'F4']); break;
      case 'snip': this.keyboard.chord(['MetaLeft', 'ShiftLeft', 'KeyS']); break;
      case 'prtsc': this.keyboard.tap('PrintScreen'); break;
      case 'esc': this.keyboard.tap('Escape'); break;
      case 'ctrlesc': this.keyboard.chord(['ControlLeft', 'Escape']); break;
    }
  }

  typeText(text) {
    if (text) this.conn.sendJson({ t: 'text', s: text });
  }

  _hotkey(code) {
    switch (code) {
      case 'KeyM': this.toolbar.toggle(); return true;
      case 'KeyF': this.toggleFullscreen(); return true;
      case 'KeyS': this.setPref('stats', !this.prefs.stats); return true;
      case 'KeyQ': this.stop(); return true;
      case 'KeyR': this.toggleRelativeMouse(); return true;
      case 'ArrowRight': this.cycleMonitor(1); return true;
      case 'ArrowLeft': this.cycleMonitor(-1); return true;
    }
    const m = /^Digit([1-9])$/.exec(code);
    if (m) { const mon = this.monitors[+m[1] - 1]; if (mon) this.selectMonitor(mon.id); return true; }
    return false;
  }

  _ripple(x, y, kind) {
    const layer = $('ripples');
    const r = document.createElement('div');
    r.className = 'ripple' + (kind === 'right' ? ' right' : kind === 'hold' ? ' hold' : '');
    r.style.left = `${x}px`; r.style.top = `${y}px`;
    layer.append(r);
    setTimeout(() => r.remove(), 800);
  }

  // ------------------------------------------------------------------ overlay

  _overlay(title, detail = '', spinner = true, actions = []) {
    $('overlay').hidden = false;
    $('overlay-title').textContent = title;
    $('overlay-detail').textContent = detail;
    $('overlay-spinner').hidden = !spinner;
    const a = $('overlay-actions');
    a.replaceChildren(...actions.map(x => h('button', { type: 'button', class: x.primary ? 'primary' : '', onclick: x.onClick }, x.label)));
  }

  _hideOverlay() { $('overlay').hidden = true; }

  // ------------------------------------------------------------------ teardown

  stop() {
    if (this.disposed) return;
    this.disposed = true;
    this._offNative?.();
    postNative({ cmd: 'session', active: false });
    closeSheet();
    try { this.keyboard?.detach(); } catch { }
    try { this.mouse?.detach(); } catch { }
    try { this.touch?.detach(); } catch { }
    this.softkbd?.hide();
    this.extraKeys?.hide();
    this.conn?.close();
    this.presenter?.close();
    this.audio?.close();
    this.clipboard?.dispose();
    this.stats?.dispose();
    this.wakeLock?.release().catch(() => { });
    if (this.fullscreen) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('pageshow', this._onPageShow);
    document.removeEventListener('gesturestart', this._onGesture);
    document.removeEventListener('gesturechange', this._onGesture);
    document.removeEventListener('touchmove', this._onTouchMove);
    document.removeEventListener('fullscreenchange', this._onFs);
    document.removeEventListener('webkitfullscreenchange', this._onFs);
    window.removeEventListener('pointermove', this._onMouseTop);
    window.removeEventListener('dragover', this._onDragOver);
    window.removeEventListener('dragleave', this._onDragLeave);
    window.removeEventListener('drop', this._onDrop);
    $('overlay').hidden = true;
    $('stats').hidden = true;
    $('toolbar').replaceChildren();
    $('viewer').hidden = true;
    document.title = 'Headroom';
    this.onExit?.();
  }
}
