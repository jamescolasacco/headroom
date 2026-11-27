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
import { TypingPreview } from './ui/typing.js';
import { ClipboardSync } from './clipboard.js';
import { Toolbar } from './ui/toolbar.js';
import { StatsOverlay } from './ui/stats.js';
import { loadPrefs, savePrefs, touchHost } from './store.js';
import { isIPhone, isIPad, isTouchPrimary, hasWebCodecs, secure, canFullscreen, isApple, postNative, onNative } from './platform.js';
import { toast, closeSheet, h } from './ui/dom.js';
import { lightOf } from './ui/light.js';

const $ = id => document.getElementById(id);

export class Session {
  constructor(host, { onExit, onUnauthorized, leaveWith }) {
    this.host = host;
    this.onExit = onExit;
    this.onUnauthorized = onUnauthorized;
    this.leaveWith = leaveWith; // wraps the last step of leaving (the screen shrinks back into its tile)
    this.light = lightOf(host.hostId || host.id); // the computer's own light (ui/light.js)
    // A guest's settings belong to the computer (its id from the code's look-up), not to the code: every code is new.
    this.prefsId = host.support && host.hostId ? host.hostId : host.id;
    this.prefs = loadPrefs(this.prefsId);
    this.monitors = [];
    this.monitorId = this.prefs.monitor || null;
    // Until the computer says what this session may do (welcome), offer nothing beyond watching.
    this.permissions = { input: false, clipboard: false, files: false, audio: false };
    this.hostStats = null;
    this.videoConfig = null;
    this.lastFrameAt = 0;
    this.frameStats = { receiveMs: 0, encodeMs: 0 };
    this.keyframeAskedAt = 0;
    this.wakeLock = null;
    this.relative = false;
    this.disposed = false;
    this.life = new AbortController();
    this.audio = new AudioPlayer();
    // Whether this browser decodes Opus is known a moment after start: if it can't, the computer sends lossless.
    this.audio.addEventListener('support', () => {
      if (this.audioOn && this.audio.opusSupported === false) this._audioSettingsChanged();
    }, { signal: this.life.signal });
    // A computer with an older Headroom sends only Opus, which this browser can't decode.
    this.audio.addEventListener('opus-unsupported', () => {
      if (this.audioOn) toast('This browser can\'t play this computer\'s sound until Headroom there is updated.', 6000);
    }, { signal: this.life.signal });
    // Every session starts muted: nothing plays, or stops this device's own music, until Unmute (setAudio).
    this.audioOn = false;
    this.audioMode = null; // the computer's last `audio-mode`: what it sends (old hosts never say: Opus)
  }

  /**
   * The session screen, at once (inside the tap, so the tile can grow into it): it wakes up in this computer's
   * light while the connection is still being found. Cancel leaves; start() takes over from here.
   */
  prepare() {
    if (this.disposed) return;
    $('home').hidden = true;
    const viewer = $('viewer');
    viewer.dataset.light = String(this.light);
    viewer.hidden = false;
    document.title = `${this.host.name} — Headroom`;
    if (!this.conn) this._overlay('Connecting…', this.host.support ? '' : this.host.name, true, [{ label: 'Cancel', onClick: () => this.stop() }]);
  }

  /** The computer is asleep or off: the session screen waits for it (app.js waitForComputer), with Cancel. */
  waitingFor(detail) {
    if (this.disposed) return;
    this._overlay(`Waiting for ${this.host.name}…`, detail, true, [{ label: 'Cancel', onClick: () => this.stop() }]);
  }

  async start() {
    if (!secure || !hasWebCodecs) {
      this._overlay('This browser can\'t decode the stream', !secure
        ? 'Open Headroom over HTTPS (or localhost). Video decoding needs a secure connection.'
        : 'WebCodecs is required (Safari 16.4+, Chrome/Edge 94+, Firefox 130+).', false, [{ label: 'Back', onClick: () => this.stop() }]);
      return;
    }
    $('home').hidden = true;
    $('viewer').dataset.light = String(this.light);
    $('viewer').hidden = false;
    document.title = `${this.host.name} — Headroom`;

    const viewer = $('viewer'), stage = $('stage'), layer = $('input-layer'), sink = $('kbd-sink');
    this.viewport = new Viewport(viewer, stage);
    this.viewport.mode = this.prefs.scaling;
    // Auto resolution follows the picture's size here: the window resized, the phone turned, zoomed in or out.
    this.viewport.addEventListener('change', () => this._followSize());
    this.cursor = new CursorRenderer(layer, $('remote-cursor'), this.viewport);
    this.presenter = new VideoPresenter({ video: $('video'), canvas: $('canvas'), preference: this.prefs.renderer });
    this.conn = new Connection(this.host);
    this.clipboard = new ClipboardSync(this.conn, () => !this.disposed && this.conn.isOpen && this.permissions.clipboard);
    this.mods = new StickyModifiers(null);

    const inputAllowed = () => this.permissions.input && this.conn.isOpen;
    const onUserGesture = () => { this.clipboard.onUserGesture(); this.audio.ctx?.state === 'suspended' && this.audio.ctx.resume().catch(() => { }); };

    // What you type on a phone's keyboard, in a box on top of the keys while the keyboard is up (its eye hides it).
    this.typing = new TypingPreview($('typing'));
    this.typing.setHidden(this.prefs.typingHidden === true);
    this.typing.setHost(this.hostOs);

    this.keyboard = new KeyboardInput({
      conn: this.conn, mods: this.mods, sink, clipboard: this.clipboard, onUserGesture, inputAllowed,
      onLocalHotkey: code => this._hotkey(code),
      softKeyboardHandles: e => this.softkbd?.handles(e),
      onKey: code => this.typing.key(code),
    });
    this.mods.keyboard = this.keyboard;
    this.keyboard.setProfile(this.prefs.keyboardProfile, this.hostOs);

    this.mouse = new MouseInput({
      conn: this.conn, viewport: this.viewport, cursor: this.cursor, layer, mods: this.mods, keyboard: this.keyboard,
      sink: isTouchPrimary ? null : sink, onUserGesture, inputAllowed,
      touchActive: () => !!this.touch?.touches.size,
      pinchTarget: source => {
        const target = this.prefs.pinchTarget;
        if (target === 'touch' && !this.touchPinch) return 'remote';
        if (target === 'auto') return source === 'touch' || this.macHost ? 'viewer' : 'remote';
        return target;
      },
      onRelativeChange: rel => { this.relative = rel; this.toolbar?.refresh(); if (rel) toast('Mouse captured — press Esc to release'); },
      onPress: () => this.typing.reset(), // a click puts the cursor somewhere else
    });

    this.softkbd = new SoftKeyboard({ sink, signal: this.life.signal, conn: this.conn, keyboard: this.keyboard, mods: this.mods, touch: isTouchPrimary || isIPad, echo: this.typing, inputAllowed });
    this.extraKeys = new ExtraKeysBar($('extra-keys'), {
      signal: this.life.signal, keyboard: this.keyboard, mods: this.mods, conn: this.conn,
      special: action => this.special(action),
      onLayout: () => this.layoutChrome(),
      onKey: code => this.typing.key(code),
      typingEl: $('typing'),
      onCopyText: () => this._copyTyped(),
      onHideText: on => this._hideTypedText(on),
      onHideKeyboard: () => this.softkbd.hide(),
      keyboardUp: () => this.softkbd.open && document.activeElement === sink,
      reopenKeyboard: () => this.softkbd.show(),
    });
    this.extraKeys.setHost(this.hostOs);
    this.extraKeys.setTextHidden(this.typing.hidden);
    this.softkbd.addEventListener('change', () => {
      const open = this.softkbd.open;
      // First: the picture keeps its size while the keyboard takes the bottom of the screen (it pans instead).
      this.viewport.setKeyboard(open);
      this.typing.setActive(open);
      this.extraKeys.setKeyboardOpen(open);
      if (open) { this.extraKeys.show(); this._followUntil = performance.now() + 1500; }
      else if (!this.extraKeysPinned) this.extraKeys.hide();
      this.toolbar?.refresh();
    });

    this.touch = new TouchInput({
      conn: this.conn, viewport: this.viewport, cursor: this.cursor, layer, mods: this.mods, onUserGesture, inputAllowed,
      pinch: (...args) => this.mouse.pinch(...args),
      endPinch: cancel => this.mouse.endPinch(cancel),
      ripple: (x, y, kind) => this._ripple(x, y, kind),
      toggleKeyboard: () => this.toggleKeyboard(),
      onPress: () => this.typing.reset(), // a tap's click puts the cursor somewhere else
      prefs: () => this.prefs,
      // The streamed screen's pixels per point (Retina 2, Windows at 150% 1.5).
      screenScale: () => this.monitors.find(m => m.id === this.monitorId)?.scale || 1,
    });
    this.touch.setMode(this.inputMode);
    if (!isTouchPrimary) this.cursor.setMode('css');

    this.toolbar = new Toolbar(this);
    this.stats = new StatsOverlay($('stats'), this);
    this.stats.setVisible(this.prefs.stats);
    this._lockPageZoom(true);
    this._onScreen = () => this._fitToScreen();
    window.addEventListener('resize', this._onScreen);
    window.visualViewport?.addEventListener('resize', this._onScreen);
    window.visualViewport?.addEventListener('scroll', this._onScreen);
    this._fitToScreen();

    this._wireConnection();
    this._wirePresenter();
    this._wireLifecycle();

    await this.presenter.start();
    if (this.disposed) return;
    this.keyboard.attach();
    this.mouse.attach();
    this.touch.attach();
    if (!isTouchPrimary) sink.focus({ preventScroll: true });
    this._overlay('Connecting…', this.host.support ? '' : this.host.name, true);
    // Headroom Viewer for Windows: its keyboard hook captures Win/Alt+Tab/PrtScn while a session is up. (The Mac
    // viewer switches the system shortcuts off instead, so ⌘Tab and friends arrive as ordinary key events.)
    this._offNative = onNative(m => {
      if (m?.type === 'nativeKey') this.keyboard.nativeKey(m.code, m.down);
      if (m?.type === 'magnify') this.mouse.nativeMagnify(m);
    });
    postNative({ cmd: 'session', active: true, host: this.host.name });
    this.conn.connect();
    this.toolbar.peek(3500);
    this._requestWakeLock();
    touchHost(this.host.id, { lastConnected: Date.now() });
  }

  /** 'windows' | 'macos': from the host's welcome, else what the account says. */
  get hostOs() { return this.hostInfo?.os || this.host.os || 'windows'; }
  get macHost() { return this.hostOs === 'macos'; }

  get inputMode() {
    const m = this.prefs.inputMode;
    if (m === 'trackpad' || m === 'touch') return m;
    return isIPhone ? 'trackpad' : 'touch';
  }

  setPref(key, value) {
    this.prefs[key] = value;
    savePrefs(this.prefsId, { [key]: value });
    switch (key) {
      case 'pinchTarget': this.mouse.endPinch(true); break;
      case 'inputMode': this.touch.setMode(this.inputMode); break;
      case 'keyboardProfile': this.keyboard.setProfile(value, this.hostOs); break;
      case 'scaling': this.viewport.setMode(value); break;
      case 'stats': this.stats.setVisible(value); break;
      case 'maxFps': case 'maxBitrateKbps': case 'resolution': this.sendStart(); break;
      case 'audioPriority': case 'audioQuality': this._audioSettingsChanged(); break;
    }
    this.toolbar?.refresh();
  }

  /**
   * The sound to ask the computer for. With audio priority on: lossless (24-bit PCM) or the best Opus, as chosen in
   * Settings. PCM needs no decoder, so it's also what a browser without WebCodecs' Opus decoder asks for.
   */
  _audioRequest() {
    const priority = !!this.prefs.audioPriority;
    const opus = this.audio.opusSupported !== false;
    const lossless = !opus || (priority && this.prefs.audioQuality === 'lossless');
    return { mode: lossless ? 'pcm24' : 'opus', priority };
  }

  /** Audio priority or its quality changed: the player and, while sound is on, the computer follow at once. */
  _audioSettingsChanged() {
    const req = this._audioRequest();
    this.audio.configure?.(req);
    if (this.audioOn) this.conn?.sendJson({ t: 'audio', enabled: true, ...req });
  }

  /** The computer says which sound it sends this session, and when the connection made it change. */
  _onAudioMode(m) {
    const was = this.audioMode;
    this.audioMode = m;
    if (m.reason !== 'bandwidth' || !this.audioOn) return;
    if (m.mode === 'opus' && was?.mode !== 'opus') toast('This connection is too slow for lossless sound. Switched to compressed.', 6000);
    else if (m.kbps) toast(`This connection is too slow for full-quality sound. Now at ${m.kbps} kb/s.`, 6000);
  }

  /** One line about the sound, for Settings and the stats: what arrives, how much is held in reserve, any dropouts. */
  soundStatus() {
    if (!this.audioOn) return 'Muted';
    const st = this.audio.stats || {};
    const pcm = st.codec ? st.codec === 'pcm' : this.audioMode?.mode === 'pcm24';
    const parts = [pcm ? 'Lossless' : `Compressed${this.audioMode?.kbps && this.audioMode.mode === 'opus' ? `, ${this.audioMode.kbps} kb/s` : ''}`];
    if (Number.isFinite(st.bufferedMs)) parts.push(`${Math.round(st.bufferedMs)} ms`);
    const drops = st.underruns || 0;
    parts.push(drops ? `${drops} dropout${drops === 1 ? '' : 's'}` : 'no dropouts');
    return parts.join(' · ');
  }

  /**
   * The toolbar's Unmute and Mute. Unmuting runs inside that tap: a browser starts sound only from one. Muting
   * lets go of this device's audio altogether, so its own music can play again; the computer stops sending sound.
   */
  setAudio(on) {
    on = !!on && this.audio.supported;
    if (on === this.audioOn) return;
    this.audioOn = on;
    if (on) {
      this.audio.configure?.(this._audioRequest());
      const start = this.audio.unlock();
      this.audioStart = start;
      this.audio.setEnabled(true);
      start.catch(() => {
        if (this.audioStart !== start || !this.audioOn || this.disposed) return;
        toast('This browser can\'t play the computer\'s sound');
        this.setAudio(false);
      });
    } else {
      this.audio.close();
    }
    this.conn?.sendJson({ t: 'audio', enabled: on, ...(on ? this._audioRequest() : {}) });
    this.toolbar?.refresh();
  }

  // ------------------------------------------------------------------ connection

  _wireConnection() {
    const c = this.conn;
    c.addEventListener('welcome', e => {
      const w = e.detail;
      this.audioMode = null; // a new session on the computer: it says again what it sends
      this.monitors = w.monitors || [];
      // Back after a reconnect: what changed meanwhile (control turned off while it was away) applies as it would live.
      if (this._welcomed && w.permissions) this._applyPermissions(w.permissions);
      else this.permissions = w.permissions || this.permissions;
      this.touchPinch = w.touchPinch === true;
      this.elevated = w.elevated;
      this.hostInfo = w.host;
      if (w.host?.os && w.host.os !== this.host.os) { this.host.os = w.host.os; touchHost(this.host.id, { os: w.host.os }); }
      this.keyboard.setProfile(this.prefs.keyboardProfile, this.hostOs);
      this.extraKeys.setHost(this.hostOs);
      this.typing.setHost(this.hostOs);
      if (!this.monitors.some(m => m.id === this.monitorId)) this.monitorId = (this.monitors.find(m => m.primary) || this.monitors[0])?.id;
      this.sendStart();
      this.toolbar.refresh();
      // A guest's first welcome: they let you in. Say so, and what they can do about it.
      if (this.host.support && !this._welcomed) {
        toast(this.permissions.input
          ? `You're connected to ${this.host.name}. They can stop this at any time.`
          : `You're connected to ${this.host.name} to watch: they didn't give you control. They can stop this at any time.`, 6000);
      }
      this._welcomed = true;
    });
    c.addEventListener('video-config', e => {
      const cfg = e.detail;
      // Another display: where the pointer was, and the last taps, were on the one before (touch.js sends the
      // pointer's place again before its next click).
      const otherDisplay = this.videoConfig && cfg.monitor !== this.videoConfig.monitor;
      if (otherDisplay) this.touch.releaseAll();
      this.videoConfig = cfg;
      this.presenter.configure(cfg);
      if (otherDisplay) this.viewport.zoom = 1; // another display starts unzoomed, even one the same size as the last
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
      // While a finger here moves the pointer, the computer's reports lag a round trip behind: drawing them
      // would tug the pointer back and forth. Show its shape and visibility only, until the finger is done.
      clearTimeout(this._lateCursorTimer);
      if (this.touch.drivingCursor()) {
        this.cursor.setVisible(p.visible);
        // Its last word still counts once the finger is done (an app may have moved the pointer meanwhile).
        const settle = () => {
          if (this.disposed) return;
          if (this.touch.drivingCursor()) { this._lateCursorTimer = setTimeout(settle, 300); return; }
          this.cursor.setPosition(p.x, p.y, p.visible);
        };
        this._lateCursorTimer = setTimeout(settle, 800);
      } else {
        this.cursor.setPosition(p.x, p.y, p.visible);
      }
      const v = this.viewport;
      if (v.srcW) this.touch.remoteCursor(p.x / v.srcW, p.y / v.srcH);
    });
    c.addEventListener('audio', e => this.audio.packet(e.detail));
    c.addEventListener('audio-mode', e => this._onAudioMode(e.detail));
    c.addEventListener('clip', e => this.clipboard.onRemote(e.detail.text || ''));
    c.addEventListener('stats', e => { this.hostStats = e.detail; });
    c.addEventListener('pinchUnavailable', () => {
      this.touchPinch = false;
      this.mouse.endPinch(true);
      toast('Windows touch input is unavailable. Pinch now uses Ctrl + wheel.');
    });
    c.addEventListener('notice', e => toast(e.detail.message, 5000));
    // The person at the other computer changed what this session may do (control, clipboard, files).
    c.addEventListener('permissions', e => this._applyPermissions({ ...this.permissions, ...(e.detail.permissions || {}) }));
    c.addEventListener('monitors', e => {
      this.monitors = e.detail.monitors;
      if (!this.monitors.some(m => m.id === this.monitorId)) this.monitorId = (this.monitors.find(m => m.primary) || this.monitors[0])?.id;
      // A display woke up (the stream starts on it now): Auto's size for it, at once, so the first picture is that size.
      const res = this.prefs.resolution;
      if (res === 'auto' || res === 'device') {
        const { maxWidth, maxHeight } = this._autoSize();
        if (`${maxWidth}x${maxHeight}` !== this._sentSize) this.sendStart();
      }
      this.toolbar.refresh();
    });
    c.addEventListener('status', e => {
      const s = e.detail;
      if (s.capture === 'secure-desktop') {
        if (this.macHost) this._overlay('Screen locked', s.detail || 'The Mac is showing its lock screen.', true);
        else this._overlay('Secure desktop', s.elevated
          ? 'Switching to the Windows secure desktop…'
          : 'A UAC prompt or the lock screen is showing. Windows only lets Headroom see it when running as a service (headroom service install).',
          !!s.elevated);
      } else if (s.capture === 'unavailable') {
        this._overlay('Display unavailable', s.detail || 'The host can\'t capture this display right now. Retrying…', true);
      } else if (s.capture === 'ok' && this.videoConfig) {
        this._hideOverlay();
      }
    });
    c.addEventListener('pending', () => {
      // Our own words (the computer repeats its message every 20 s to keep the connection alive).
      this._overlay('Waiting for them to accept…', '', true, [{ label: 'Cancel', onClick: () => this.stop() }]);
    });
    c.addEventListener('fatal', e => {
      const m = e.detail;
      const back = [{ label: 'Back', primary: true, onClick: () => this.stop() }];
      if (m.code === 'ended') {
        // The other computer ended it (its Stop, its sign-in removed, Headroom Server quit): no reconnecting.
        this._releaseInput();
        this._overlay('Session ended', `${m.message || 'The other computer ended the session.'}${this.host.support ? ' To connect again, ask them for a new code.' : ''}`, false, back);
      } else if (this.host.support && (m.code === 'unauthorized' || m.code === 'bad-code' || m.code === 'declined')) {
        // A guest: a wrong or used code, "Decline", or the session ended from the other computer.
        // Always words written for guests (the computer's own message may be about account sign-ins).
        const titles = { 'bad-code': 'Code not accepted', declined: 'Not accepted', unauthorized: 'Session ended' };
        const text = {
          'bad-code': 'That code is wrong, expired or already used. Ask the person at the other computer for a new one.',
          declined: 'They declined, or didn\'t answer within 2 minutes. You can ask them for a new code.',
          // (A resume key that no longer works: away for more than 2 minutes, or the other computer restarted Headroom.)
          unauthorized: 'This session can\'t continue. To connect again, ask the person at the other computer for a new code.',
        };
        this._overlay(titles[m.code], text[m.code], false, back);
      } else if (m.code === 'unauthorized') {
        this._overlay('No access', 'This device doesn\'t accept your sign-in. It may have left your account.', false, [
          { label: 'Back', primary: true, onClick: () => { this.stop(); this.onUnauthorized?.(this.host); } },
        ]);
      } else if (m.code === 'rate-limited') {
        this._overlay('Too many attempts', `Try again in ${m.retryAfter || 60} seconds.`, false, [{ label: 'Back', onClick: () => this.stop() }]);
      } else {
        this._overlay('Can\'t connect', m.message || m.code, false, back);
      }
    });
    c.addEventListener('state', e => {
      const { state, attempt, reason } = e.detail;
      if (state === 'reconnecting') {
        this._releaseInput();
        this.typing?.reset();
        this.clipboard.clear();
        if (!this._opened && this.host.account) {
          // It was listed as there, but it doesn't answer: it just fell asleep. It's tried again until it's back.
          if (attempt > 2) this.waitingFor('It isn\'t answering.');
          return;
        }
        this._overlay('Reconnecting…', attempt > 2 ? `Can't reach ${this.host.name}. Still trying (${reason || 'network'}).` : '', true,
          [{ label: 'Disconnect', onClick: () => this.stop() }]);
      } else if (state === 'open') {
        this._opened = true;
        if (!this.videoConfig) this._overlay('Starting stream…', '', true);
      }
    });
  }

  /**
   * The person at the other computer changed what this session may do (control, clipboard, files, sound): live, or
   * while it was reconnecting (its welcome says so).
   */
  _applyPermissions(next) {
    const was = this.permissions;
    this.permissions = next;
    if (was.clipboard && !next.clipboard) this.clipboard.clear();
    // Only the sheet that needed it closes (or More, which lists it): Settings, Displays or Shortcuts stay open.
    const lost = [...(was.clipboard && !next.clipboard ? ['Clipboard'] : []), ...(was.files && !next.files ? ['Files'] : [])];
    if (lost.length && [...lost, 'More'].includes(this.toolbar?._sheetLabel)) closeSheet();
    if (was.audio && !next.audio) this.setAudio(false);
    // Watching only: the keyboard goes too (its toolbar button goes; what's typed would go nowhere).
    if (was.input && !next.input) {
      this._releaseInput();
      this.softkbd?.hide();
      this.extraKeys?.hide(); // (kept pinned: it comes back with control)
      toast('View only: they turned off control.', 5000);
    } else if (!was.input && next.input) {
      if (this.extraKeysPinned) this.extraKeys?.show();
      toast('You can control the screen now.', 4000);
    }
    this.toolbar?.refresh();
  }

  sendStart() {
    if (!this.conn?.isOpen) return;
    const res = this.prefs.resolution;
    let maxWidth = 0, maxHeight = 0;
    if (res === '1080') { maxWidth = 1920; maxHeight = 1080; }
    else if (res === '720') { maxWidth = 1280; maxHeight = 720; }
    else if (res === '1440') { maxWidth = 2560; maxHeight = 1440; }
    else if (res !== 'native') ({ maxWidth, maxHeight } = this._autoSize()); // Auto (and "This screen", which it replaced)
    this._sentSize = `${maxWidth}x${maxHeight}`;
    const sound = this._audioRequest();
    this.conn.sendJson({
      t: 'start',
      monitor: this.monitorId,
      maxFps: this.prefs.maxFps,
      maxBitrateKbps: this.prefs.maxBitrateKbps || undefined,
      maxWidth, maxHeight,
      audio: this.audioOn,
      audioMode: sound.mode,
      audioPriority: sound.priority,
    });
  }

  /**
   * Auto resolution: the stream is as big as the whole desktop is drawn on this screen, in device pixels, and as
   * you zoom in it grows, up to the computer's own size. Pixels nobody sees cost encode time, delay and bitrate: a
   * phone showing a Retina Mac at a third of its size gets a light, fast stream, a 4K screen every pixel. In
   * tenths of the computer's size (half at least), so small changes don't restart the stream.
   */
  _autoSize() {
    const m = this.monitors.find(x => x.id === this.monitorId) || this.monitors[0];
    const v = this.viewport, dpr = window.devicePixelRatio || 1;
    // No display listed yet (asleep: the computer starts the stream once one wakes): at most this screen's pixels, not
    // all of the computer's (its first picture would be the session's biggest). The `monitors` message corrects it.
    if (!m?.width || !m?.height) return { maxWidth: Math.round(v.viewer.clientWidth * dpr), maxHeight: Math.round(v.viewer.clientHeight * dpr) };
    // Before any video: the desktop fitted into this window.
    const shownW = v.encW ? v.encW * v.scale * dpr : Math.min(v.viewer.clientWidth, v.viewer.clientHeight * m.width / m.height) * dpr;
    const s = Math.min(1, Math.max(0.5, Math.ceil(shownW / m.width * 10 - 0.05) / 10));
    return s >= 1 ? { maxWidth: 0, maxHeight: 0 } : { maxWidth: Math.round(m.width * s), maxHeight: Math.round(m.height * s) };
  }

  /** The picture changed size here: with Auto resolution, ask for the size that fits now (once it settles). */
  _followSize() {
    const res = this.prefs.resolution;
    if (res !== 'auto' && res !== 'device') return;
    clearTimeout(this._sizeTimer);
    this._sizeTimer = setTimeout(() => {
      const { maxWidth, maxHeight } = this._autoSize();
      if (`${maxWidth}x${maxHeight}` !== this._sentSize) this.sendStart();
    }, 700);
  }

  selectMonitor(id) {
    this.mouse.endPinch(true);
    this.monitorId = id;
    this.typing?.reset();
    savePrefs(this.prefsId, { monitor: id });
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

  _releaseInput() {
    this.mouse?.releaseAll();
    this.touch?.releaseAll();
    this.keyboard?.releaseAll();
    // Ctrl, Alt, ⌘ or Shift left on from the keys bar would turn the first key after this into a shortcut.
    this.mods?.clear();
  }

  _wireLifecycle() {
    window.addEventListener('blur', () => this.touch.releaseAll(), { signal: this.life.signal });
    this._onVis = () => {
      if (document.visibilityState === 'hidden') {
        // The keyboard goes with the page; if the phone brings it back, typing picks up again (softkbd).
        this.softkbd.suspend();
        this._releaseInput();
      } else {
        this.softkbd.viewportChanged();
        this._requestWakeLock();
        this.conn.resume();
      }
    };
    this._onPageShow = e => { if (e.persisted) this.conn.resume(); };
    this._onGesture = e => e.preventDefault();
    this._onTouchMove = e => { if (!e.target.closest?.('#sheet, #extra-keys, #toolbar')) e.preventDefault(); };
    this._onFs = () => this._fullscreenChanged();
    this._onMouseTop = e => { if (e.clientY < 6 && e.pointerType === 'mouse') this.toolbar.peek(2500); };
    // Files dragged over the session are never left to the browser: it would open them in place of the session.
    this._onDragOver = e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); this._dropHint(this.permissions.files); } };
    this._onDragLeave = e => { if (!e.relatedTarget) this._dropHint(false); };
    this._onDrop = e => {
      this._dropHint(false);
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      if (!this.permissions.files) { toast('File transfer isn\'t allowed'); return; }
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

  /**
   * Keeps the whole session (picture, toolbar, extra keys) inside the part of the page that's showing. When the
   * on-screen keyboard comes up, iOS shrinks that part, and can shift it, without resizing the page itself.
   */
  _fitToScreen() {
    const vv = window.visualViewport, viewer = $('viewer');
    if (vv) {
      Object.assign(viewer.style, {
        top: `${vv.offsetTop}px`, left: `${vv.offsetLeft}px`, width: `${vv.width}px`, height: `${vv.height}px`, right: 'auto', bottom: 'auto',
      });
    }
    // A keyboard that came back or went away by itself: typing (the dock, the toolbar, the picture's keyboard mode)
    // follows it before anything is laid out.
    this.softkbd?.viewportChanged();
    // What the on-screen keyboard covers of the page (messages are shown outside the session: layoutChrome).
    this._covered = vv ? Math.max(0, document.documentElement.clientHeight - vv.offsetTop - vv.height) : 0;
    this.layoutChrome();
    this.viewport.layout();
    // The keyboard just came up: bring the pointer (where you clicked to type) into view above it.
    if (this.viewport.keyboard && performance.now() < (this._followUntil || 0)) {
      const n = this.cursor.normalized;
      this.viewport.follow(n.nx, n.ny, 72);
    }
  }

  /**
   * Where the session's own bars go, and the room they leave the picture: the extra keys at the bottom (with what you
   * type on top of them while the on-screen keyboard is up), and on touch screens the toolbar above them (or nothing,
   * while the keyboard is up), clear of the status bar or notch at the top. Runs when any of them changes size and
   * when the visible area does.
   */
  layoutChrome() {
    const v = this.viewport;
    if (!v || !this.extraKeys) return;
    const keys = this.extraKeys.visible ? this.extraKeys.el.offsetHeight : 0;
    v.viewer.style.setProperty('--keys-h', `${keys}px`);
    const top = this.toolbar?.touchUi ? this._safeTop() : 0;
    const bar = this.toolbar ? this.toolbar.place(keys, top) : 0;
    v.setInsets(top, Math.max(keys, bar));
    // Messages sit above the keyboard, the toolbar and the extra keys.
    document.documentElement.style.setProperty('--inset-bottom', `${Math.round((this._covered || 0) + v.insetBottom)}px`);
  }

  /** The status bar or notch at the top of a phone (env(safe-area-inset-top)): the picture keeps clear of it. */
  _safeTop() {
    if (!this._safeProbe) {
      this._safeProbe = h('div', { 'aria-hidden': 'true' });
      this._safeProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top,0px)';
    }
    if (!this._safeProbe.isConnected) document.body.append(this._safeProbe);
    return this._safeProbe.offsetHeight;
  }

  /** A tap on what you typed copies it, on this device. The box says so for a moment, instead of the text. */
  _copyTyped() {
    const text = this.typing.plain();
    if (!text) return;
    const done = () => this.typing.flash('Copied'), failed = () => this.typing.flash('Couldn\'t copy');
    try { navigator.clipboard.writeText(text).then(done, failed); } catch { failed(); }
  }

  /** The eye in the typing box: what you type shows as dots (a password), or as text. Kept for every computer. */
  _hideTypedText(on) {
    this.prefs.typingHidden = on;
    savePrefs('global', { typingHidden: on });
    this.typing.setHidden(on);
    this.extraKeys.setTextHidden(on);
  }

  /** While a session is up, pinching zooms the remote screen, never the page (that would throw the layout off). */
  _lockPageZoom(on) {
    const meta = document.querySelector('meta[name=viewport]');
    if (!meta) return;
    if (on) {
      this._viewportMeta ??= meta.content;
      meta.content = `${this._viewportMeta}, maximum-scale=1, user-scalable=no`;
    } else if (this._viewportMeta != null) {
      meta.content = this._viewportMeta;
    }
  }

  _dropHint(on) {
    let el = document.querySelector('.drop-hint');
    if (on && !el) $('viewer').append(h('div', { class: 'drop-hint' }, `Drop to send to ${this.host.name}`));
    if (!on && el) el.remove();
  }

  async _requestWakeLock() {
    try {
      if (navigator.wakeLock && document.visibilityState === 'visible' && !this.disposed && !this.wakeLock && !this.requestingWakeLock) {
        this.requestingWakeLock = true;
        try {
          const lock = await navigator.wakeLock.request('screen');
          if (this.disposed) { await lock.release(); return; }
          this.wakeLock = lock;
          lock.addEventListener('release', () => { if (this.wakeLock === lock) this.wakeLock = null; });
        } finally { this.requestingWakeLock = false; }
      }
    } catch { /* not allowed (e.g. low battery) */ }
  }

  // ------------------------------------------------------------------ actions

  toggleKeyboard() {
    // Watching only, there's nothing to type into: it can close, not open (a three-finger tap asks too).
    if (!this.permissions.input && !this.softkbd.open && !this.extraKeys.visible) return;
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
    if (!this.permissions.input || !this.conn.isOpen) return; // watching only, or not connected: nothing to press
    switch (action) {
      case 'cad': this.conn.sendJson({ t: 'special', action: 'cad' }); break;
      case 'lock': this.conn.sendJson({ t: 'special', action: 'lock' }); break;
      case 'taskmgr':
        if (this.macHost) this.conn.sendJson({ t: 'special', action: 'taskmgr' }); // opens Activity Monitor
        else this.keyboard.chord(['ControlLeft', 'ShiftLeft', 'Escape']);
        break;
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
      // Mac hosts ('cad' = Force Quit, 'lock', 'taskmgr' = Activity Monitor are handled by the host).
      case 'cmdtab': this.keyboard.chord(['MetaLeft', 'Tab']); break;
      case 'spotlight': this.keyboard.chord(['MetaLeft', 'Space']); break;
      case 'mission': this.keyboard.chord(['ControlLeft', 'ArrowUp']); break;
      case 'appwindows': this.keyboard.chord(['ControlLeft', 'ArrowDown']); break;
      case 'shot': this.keyboard.chord(['MetaLeft', 'ShiftLeft', 'Digit3']); break;
      case 'shotarea': this.keyboard.chord(['MetaLeft', 'ShiftLeft', 'Digit4']); break;
      case 'shottools': this.keyboard.chord(['MetaLeft', 'ShiftLeft', 'Digit5']); break;
      case 'closewin': this.keyboard.chord(['MetaLeft', 'KeyW']); break;
      case 'quit': this.keyboard.chord(['MetaLeft', 'KeyQ']); break;
      case 'hide': this.keyboard.chord(['MetaLeft', 'KeyH']); break;
      case 'minimize': this.keyboard.chord(['MetaLeft', 'KeyM']); break;
      case 'emoji': this.keyboard.chord(['ControlLeft', 'MetaLeft', 'Space']); break;
    }
  }

  typeText(text) {
    if (text && this.permissions.input && this.conn.isOpen) this.conn.sendJson({ t: 'text', s: text });
  }

  _hotkey(code) {
    switch (code) {
      case 'KeyM': this.toolbar.toggle({ focus: true }); return true;
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
    const box = layer.getBoundingClientRect(); // x, y are page coordinates; the session may sit lower (keyboard)
    const r = document.createElement('div');
    r.className = 'ripple' + (kind === 'right' ? ' right' : kind === 'hold' ? ' hold' : '');
    r.style.left = `${x - box.left}px`; r.style.top = `${y - box.top}px`;
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
    // An ending (no spinner): put focus on what to do next, so Enter works.
    if (!spinner && a.firstChild) (a.querySelector('.primary') || a.firstChild).focus({ preventScroll: true });
  }

  _hideOverlay() { $('overlay').hidden = true; }

  // ------------------------------------------------------------------ teardown

  stop() {
    if (this.disposed) return;
    this.disposed = true;
    this.life.abort();
    clearTimeout(this._sizeTimer);
    clearTimeout(this._lateCursorTimer);
    this._offNative?.();
    postNative({ cmd: 'session', active: false });
    closeSheet();
    try { this.keyboard?.detach(); } catch { }
    try { this.mouse?.detach(); } catch { }
    try { this.touch?.detach(); } catch { }
    this.softkbd?.hide();
    clearTimeout(this.toolbar?.hideTimer);
    this.extraKeys?.hide();
    this.typing?.reset();
    this._safeProbe?.remove();
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
    window.removeEventListener('resize', this._onScreen);
    window.visualViewport?.removeEventListener('resize', this._onScreen);
    window.visualViewport?.removeEventListener('scroll', this._onScreen);
    this._lockPageZoom(false);
    for (const k of ['top', 'left', 'width', 'height', 'right', 'bottom', '--keys-h', '--inset-bottom']) $('viewer').style.removeProperty(k);
    document.documentElement.style.removeProperty('--inset-bottom');
    const leave = () => {
      $('overlay').hidden = true;
      $('stats').hidden = true;
      $('toolbar').replaceChildren();
      $('viewer').hidden = true;
      document.title = 'Headroom';
      this.onExit?.();
    };
    if (this.leaveWith && !$('viewer').hidden) this.leaveWith(leave); else leave();
  }
}
