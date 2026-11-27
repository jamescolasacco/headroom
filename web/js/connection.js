// One viewer connection to a host over WSS, with automatic reconnect.
//
// Where it helps, the socket itself runs in a worker (socket-worker.js, socket-core.js) and this is its proxy: the same
// events, sendJson/sendBinary, buffered and reconnects. Chromium delivers a worker's socket messages on the worker's
// own thread, so sound and pictures go from there straight to the player's worklet and the video worker (routeAudio,
// routeVideo), frames are acked there, and a busy page (sheets, layout, GC) can't hold any of it up. WebKit (Safari,
// every iOS browser, the Mac Viewer) passes a worker's socket messages through the page's main thread all the same
// (measured: a 500 ms main-thread stall silences a worker's socket for as long), so there the socket stays here, as it
// always was. globalThis.__headroomSocketWorker = true / false overrides the choice (tests).
import { H2C, FrameAssembler, frameAck, parseAudio } from './protocol.js';
import { deviceLabel, platformId, isWebKit } from './platform.js';

// An accepted guest can come back after a drop for 2 minutes from when the computer notices it
// (SupportService.resumeGrace), which can be 20 s late (a connection that went silent). After that, trying again only
// says "Can't reach" forever: the session has ended.
export const GUEST_RESUME_MS = 150_000;

const OPEN = 1, CLOSING = 2, CLOSED = 3;

function socketWorkerWanted() {
  const o = globalThis.__headroomSocketWorker;
  if (typeof o === 'boolean') return o;
  return !isWebKit && typeof Worker === 'function' && typeof MessageChannel === 'function';
}

/** The socket worker, one per Connection: its sockets by id and the messages that aren't any socket's. */
class SocketHub {
  constructor({ onFail, onNote }) {
    this.worker = new Worker(new URL('./socket-worker.js', import.meta.url), { type: 'module' });
    this.sockets = new Map();
    this.nextId = 1;
    this.ready = false;
    this.failed = false;
    this.onFail = onFail;
    this.onNote = onNote;
    this.worker.onmessage = e => this._receive(e.data);
    this.worker.onerror = e => {
      // Before it says it's ready, an error means it couldn't start (no module workers, or not served): no worker.
      if (!this.ready) { e?.preventDefault?.(); this._fail(); } else console.warn('[conn] socket worker:', e?.message || e);
    };
    this.readyTimer = setTimeout(() => { if (!this.ready) this._fail(); }, 6000);
  }

  post(m, transfer = []) {
    if (!this.failed) this.worker.postMessage(m, transfer);
  }

  _receive(m) {
    if (this.failed || !m) return;
    if (m.type === 'ready') { this.ready = true; clearTimeout(this.readyTimer); return; }
    if (m.id != null) { this.sockets.get(m.id)?._event(m); return; }
    this.onNote?.(m);
  }

  /** It never started: its sockets close (the connection tries again, with a socket of its own). */
  _fail() {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.readyTimer);
    try { this.worker.terminate(); } catch { }
    for (const s of [...this.sockets.values()]) s._closed({ code: 1006, reason: 'socket worker unavailable', wasClean: false });
    this.onFail?.();
  }

  dispose() {
    clearTimeout(this.readyTimer);
    if (this.failed) return;
    this.post({ type: 'dispose' }); // it lets its sockets finish closing, then goes
    this.failed = true;
    const worker = this.worker;
    setTimeout(() => { try { worker.terminate(); } catch { } }, 5000);
  }
}

/** A socket in the hub's worker, with as much of the WebSocket interface as Connection uses. */
class WorkerSocket {
  constructor(hub, url) {
    this.hub = hub;
    this.id = hub.nextId++;
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.binaryType = 'arraybuffer';
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    this.onframe = this.onaudio = this.ontick = null; // what the worker took care of
    hub.sockets.set(this.id, this);
    hub.post({ type: 'open', id: this.id, url });
  }

  send(data) {
    if (this.readyState === OPEN) this.hub.post({ type: 'send', id: this.id, data });
  }

  close(code, reason) {
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    this.hub.post({ type: 'close', id: this.id, code, reason });
    // The worker says when it's closed; if it can't, closed anyway.
    this._closeTimer = setTimeout(() => this._closed({ code: 1006, reason: '', wasClean: false }), 3000);
  }

  _closed(ev) {
    if (this.readyState === CLOSED) return;
    clearTimeout(this._closeTimer);
    this.readyState = CLOSED;
    this.hub.sockets.delete(this.id);
    this.onclose?.(ev);
  }

  _event(m) {
    switch (m.type) {
      case 'open':
        if (this.readyState !== 0) return; // closed before it opened
        this.readyState = OPEN;
        this.onopen?.({});
        break;
      case 'error': this.onerror?.({}); break;
      case 'close': this._closed({ code: m.code, reason: m.reason || '', wasClean: !!m.wasClean }); break;
      // A socket that's closing delivers nothing more (as a WebSocket).
      case 'message': if (this.readyState === OPEN) this.onmessage?.({ data: m.data, counted: true }); break;
      case 'frame': if (this.readyState === OPEN) this.onframe?.(m); break;
      case 'audio': if (this.readyState === OPEN) this.onaudio?.(m); break;
      case 'tick':
        this.bufferedAmount = m.buffered || 0;
        if (this.readyState === OPEN) this.ontick?.(m);
        break;
    }
  }
}

export class Connection extends EventTarget {
  constructor(host) {
    super();
    this.host = host;
    this.ws = null;
    this.state = 'idle';          // idle | connecting | open | reconnecting | closed
    this.closedByUser = false;
    this.attempt = 0;
    this.welcome = null;
    this.rttMs = 0;
    this.lastMessageAt = 0;
    this.pingSeq = 0;
    this._pings = new Map();
    this._frames = new FrameAssembler(); // video fragments, when the socket is on this thread
    this._timers = [];
    this.helloTimer = null;
    this.bytesIn = 0;
    this.lostAt = 0;              // when the last connection that was let in went away (0: none lost since)
    this._hubState = null;        // the socket worker (SocketHub); false: none for this connection
    this._routes = { audio: null, video: null }; // callbacks of what was routed to the worker
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  setState(s, detail) {
    this.state = s;
    this.emit('state', { state: s, ...detail });
  }

  connect() {
    this.closedByUser = false;
    this._open();
  }

  _wsUrl() {
    const u = new URL(this.host.url);
    u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
    u.pathname = u.pathname.replace(/\/$/, '') + '/ws'; // through the relay: …/r/<device>/ws, or …/c/<code>/ws for a guest
    return u.toString();
  }

  _open() {
    this._clearTimers();
    this.welcome = null;
    this._frames.reset();
    this._pings.clear();
    this._rtts = [];
    this.rttMs = 0;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting', { attempt: this.attempt });
    let ws;
    try {
      const hub = this._hub();
      ws = hub ? new WorkerSocket(hub, this._wsUrl()) : new WebSocket(this._wsUrl());
    } catch (e) {
      this._scheduleReconnect(e.message);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const openTimeout = setTimeout(() => { if (ws.readyState !== OPEN) ws.close(); }, 8000);

    this._timers.push(openTimeout);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      clearTimeout(openTimeout);
      this.lastMessageAt = performance.now();
      const client = { name: this.host.deviceName || deviceLabel(), platform: platformId(), ua: navigator.userAgent.slice(0, 200) };
      // A guest: the first connection uses the code; reconnects use the key from welcome.
      const credentials = this.host.support && !this.host.token ? { support: this.host.support } : { token: this.host.token };
      ws.send(JSON.stringify({ t: 'hello', ...credentials, client }));
      this._waitForWelcome();
    };
    ws.onmessage = ev => { if (this.ws === ws && !this._fatal) this._onMessage(ev.data, ev.counted); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = ev => {
      clearTimeout(openTimeout);
      if (this.ws !== ws) return;
      this.ws = null;
      this._clearTimers();
      this._frames.reset();
      if (this.welcome) this.lostAt ||= Date.now();
      if (this.closedByUser) { this.setState('closed', { reason: 'user' }); return; }
      if (this._fatal) { this.setState('closed', { reason: this._fatal.code, message: this._fatal.message }); return; }
      this._scheduleReconnect(ev.reason || `code ${ev.code}`);
    };
    if (ws instanceof WorkerSocket) {
      // What the worker took care of: a frame (sent on to the video worker, or here with its data), a sound packet
      // with nowhere else to go, and what arrived meanwhile.
      ws.onframe = m => { if (this.ws === ws && !this._fatal) this._onFrame(m); };
      ws.onaudio = m => { if (this.ws === ws && !this._fatal) this.emit('audio', { codec: m.codec, seq: m.seq, timeUs: m.timeUs, data: m.data }); };
      ws.ontick = m => {
        if (this.ws !== ws) return;
        this.bytesIn += m.bytes || 0;
        this.lastMessageAt = Math.max(this.lastMessageAt, performance.now() - (m.agoMs || 0));
      };
    }
  }

  /** The socket worker, started the first time it's wanted; null where the socket stays on this thread. */
  _hub() {
    if (this._hubState) return this._hubState;
    if (this._hubState === false || !socketWorkerWanted()) { this._hubState = false; return null; }
    try {
      this._hubState = new SocketHub({
        // It couldn't start: sockets on this thread from now on, and sound and pictures come here as events again.
        onFail: () => {
          this._hubState = false;
          const { audio, video } = this._routes;
          this._routes = { audio: null, video: null };
          audio?.onLost?.();
          video?.onLost?.();
        },
        onNote: m => { if (m.type === 'opus-unsupported') this._routes.audio?.onOpusUnsupported?.(); },
      });
    } catch (e) {
      console.warn('[conn] no socket worker:', e);
      this._hubState = false;
      return null;
    }
    return this._hubState;
  }

  /** Whether the socket runs in a worker that can take sound and pictures elsewhere (routeAudio, routeVideo). */
  get offMain() { return !!this._hub(); }

  /**
   * Sound packets from now on go from the socket's worker to `port`, decoded there (feed.js), instead of coming here
   * as 'audio' events; null: here again. opus: Opus can be decoded; trim: the frames a fresh Opus decoder drops
   * (OPUS_LOOKAHEAD in priority mode). onLost: the worker is gone, packets come here; onOpusUnsupported: Opus came that
   * can't be decoded. Returns whether they go to the port.
   */
  routeAudio(port, { opus = true, trim = 0, onLost, onOpusUnsupported } = {}) {
    const hub = port ? this._hub() : this._hubState;
    this._routes.audio = hub && port ? { onLost, onOpusUnsupported } : null;
    if (!hub) { try { port?.close(); } catch { } return false; }
    hub.post({ type: 'audio', port, opus, trim }, port ? [port] : []);
    return !!port;
  }

  /** The routed sound's Opus trim changed (audio priority on or off). */
  audioTrim(trim) {
    if (this._routes.audio) this._hubState?.post({ type: 'audio-config', trim });
  }

  /**
   * Video frames (with each epoch's video-config) from now on go from the socket's worker to `port`: the video worker's
   * 'config' and 'chunk' messages. 'video-frame' events still come, without the data. Returns whether they go there.
   */
  routeVideo(port, { optimizeForLatency = true, onLost } = {}) {
    const hub = port ? this._hub() : this._hubState;
    this._routes.video = hub && port ? { onLost } : null;
    if (!hub) { try { port?.close(); } catch { } return false; }
    hub.post({ type: 'video', port, optimizeForLatency }, port ? [port] : []);
    return !!port;
  }

  _waitForWelcome() {
    // A guest waiting for approval receives a pending message every 20 seconds.
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => this.reconnectNow(), 35000);
  }

  resume() {
    if (this.closedByUser || this._fatal || this.state === 'idle') return;
    if (this.isOpen) this.sendJson({ t: 'keyframe' });
    else if (!this.ws || this.ws.readyState >= CLOSING) this.reconnectNow();
  }

  /** An accepted guest away for longer than its resume key lasts: the session has ended (says so, and returns true). */
  _expired() {
    if (!this.host.support || !this.host.token || !this.lostAt || Date.now() - this.lostAt <= GUEST_RESUME_MS) return false;
    this._end(`The connection to ${this.host.name || 'the other computer'} was lost.`);
    return true;
  }

  _scheduleReconnect(reason) {
    if (this._expired()) return;
    this.attempt++;
    const delay = Math.min(5000, 300 * 2 ** Math.min(this.attempt - 1, 4)) * (0.8 + Math.random() * 0.4);
    this.setState('reconnecting', { attempt: this.attempt, reason, inMs: Math.round(delay) });
    this._timers.push(setTimeout(() => this._open(), delay));
  }

  /** Reconnect immediately (e.g. app came back to the foreground). */
  reconnectNow() {
    if (this.closedByUser || this._fatal) return;
    if (this.welcome) this.lostAt ||= Date.now();
    if (this.ws) { try { this.ws.close(); } catch { } this.ws = null; }
    if (this._expired()) return;
    this.attempt = Math.max(this.attempt, 1);
    this._open();
  }

  /** Gives up for good, as when the host ends the session ('ended'): no more reconnecting. */
  _end(message) {
    this._clearTimers();
    this._fatal = { code: 'ended', message };
    this.emit('fatal', { t: 'error', code: 'ended', message });
    this.setState('closed', { reason: 'ended', message });
  }

  close() {
    this.closedByUser = true;
    this._clearTimers();
    if (this.ws) { try { this.ws.close(1000, 'bye'); } catch { } }
    this.ws = null;
    // (The worker sends that close before it goes.)
    if (this._hubState) this._hubState.dispose();
    this._hubState = null;
    this._routes = { audio: null, video: null };
    this.setState('closed', { reason: 'user' });
  }

  _clearTimers() {
    clearTimeout(this.helloTimer);
    for (const t of this._timers) { clearTimeout(t); clearInterval(t); }
    this._timers = [];
  }

  get isOpen() { return this.ws?.readyState === OPEN && !!this.welcome && !this._fatal; }

  sendJson(obj) {
    if (this.isOpen) this.ws.send(JSON.stringify(obj));
  }

  sendBinary(buf) {
    if (this.isOpen) this.ws.send(buf);
  }

  /** Bytes queued in the browser's socket buffer: used to drop redundant mouse moves on slow links. */
  get buffered() { return this.ws ? this.ws.bufferedAmount : 0; }

  /** A message from the socket (`counted`: its bytes are in the worker's ticks). */
  _onMessage(data, counted = false) {
    this.lastMessageAt = performance.now();
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      this._onJson(msg);
      return;
    }
    if (!counted) this.bytesIn += data.byteLength;
    const view = new DataView(data);
    switch (view.getUint8(0)) {
      case H2C.VIDEO: this._onVideoFragment(data, view); break;
      case H2C.CURSOR_POS:
        this.emit('cursor-pos', { visible: (view.getUint8(1) & 1) !== 0, x: view.getInt32(4, true), y: view.getInt32(8, true) });
        break;
      case H2C.CURSOR_SHAPE: {
        const id = view.getUint32(4, true), w = view.getUint16(8, true), h = view.getUint16(10, true);
        this.emit('cursor-shape', {
          id, w, h, hotX: view.getUint16(12, true), hotY: view.getUint16(14, true),
          rgba: w > 0 ? new Uint8ClampedArray(data, 16, w * h * 4) : null,
        });
        break;
      }
      case H2C.AUDIO:
        this.emit('audio', parseAudio(data, view));
        break;
    }
  }

  _onJson(msg) {
    switch (msg.t) {
      case 'pending':
        this._waitForWelcome();
        this.emit('pending', msg);
        break;
      case 'welcome':
        clearTimeout(this.helloTimer);
        if (msg.resumeToken) this.host.token = msg.resumeToken;
        // A guest code is used up once accepted: reconnects and file transfers go to the device's own relay path.
        if (msg.relayPath && this.host.support) this.host.url = new URL(msg.relayPath, this.host.url).toString().replace(/\/$/, '');
        this.welcome = msg;
        this.attempt = 0;
        this.lostAt = 0;
        this._fatal = null;
        this.setState('open');
        this.emit('welcome', msg);
        this._startPings();
        break;
      case 'error':
        this._fatal = { code: msg.code, message: msg.message };
        this.emit('fatal', msg);
        break;
      case 'pong': {
        const sent = this._pings.get(msg.id);
        if (sent != null) {
          this._pings.delete(msg.id);
          const rtt = performance.now() - sent;
          this.lastRtt = rtt;
          // Median of the last 7: robust to the odd slow ping (e.g. during stream start-up).
          (this._rtts ||= []).push(rtt);
          if (this._rtts.length > 7) this._rtts.shift();
          const sorted = [...this._rtts].sort((a, b) => a - b);
          this.rttMs = sorted[sorted.length >> 1];
        }
        break;
      }
      default:
        this.emit(msg.t, msg);
    }
  }

  _startPings() {
    const iv = setInterval(() => {
      if (!this.ws || this.ws.readyState !== OPEN) return;
      const id = ++this.pingSeq;
      this._pings.set(id, performance.now());
      if (this._pings.size > 20) this._pings.delete(this._pings.keys().next().value);
      this.sendJson({ t: 'ping', id, ts: performance.now() });
      // Zombie-socket watchdog (iOS can leave a dead socket that never fires onclose).
      if (performance.now() - this.lastMessageAt > 6000 && document.visibilityState === 'visible') {
        console.warn('[conn] no data for 6s; reconnecting');
        this.reconnectNow();
      }
    }, 1000);
    this._timers.push(iv);
  }

  _onVideoFragment(data, view) {
    const f = this._frames.push(data, view);
    if (!f) return;
    // Ack on arrival: the host uses this for flow control + delivery-rate/RTT estimates.
    this.sendBinary(frameAck(f.frameId));
    this.emit('video-frame', { ...f, arrivedAt: performance.now() });
  }

  /** A frame the socket worker put together and acked: with its data, or (routed to the video worker) without. */
  _onFrame(m) {
    this.emit('video-frame', {
      frameId: m.frameId, epoch: m.epoch, key: m.key, data: m.data || null, captureUs: m.captureUs,
      encodeMs: m.encodeMs, receiveMs: m.receiveMs, arrivedAt: performance.now(),
    });
  }
}
