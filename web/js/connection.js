// One viewer connection to a host over WSS, with automatic reconnect.
import { H2C, VF, VIDEO_HEADER, parseVideoHeader, frameAck } from './protocol.js';
import { deviceLabel, platformId } from './platform.js';

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
    this._assembly = null;        // { frameId, epoch, buf, received, flags, captureUs, encodeMs, firstAt }
    this._timers = [];
    this.bytesIn = 0;
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
    u.pathname = '/ws';
    return u.toString();
  }

  _open() {
    this._clearTimers();
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting', { attempt: this.attempt });
    let ws;
    try {
      ws = new WebSocket(this._wsUrl());
    } catch (e) {
      this._scheduleReconnect(e.message);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const openTimeout = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 8000);

    ws.onopen = () => {
      clearTimeout(openTimeout);
      this.lastMessageAt = performance.now();
      this.sendJson({
        t: 'hello',
        token: this.host.token,
        client: { name: this.host.deviceName || deviceLabel(), platform: platformId(), ua: navigator.userAgent.slice(0, 200) },
      });
    };
    ws.onmessage = ev => this._onMessage(ev.data);
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = ev => {
      clearTimeout(openTimeout);
      if (this.ws !== ws) return;
      this.ws = null;
      this._clearTimers();
      this._assembly = null;
      if (this.closedByUser) { this.setState('closed', { reason: 'user' }); return; }
      if (this._fatal) { this.setState('closed', { reason: this._fatal.code, message: this._fatal.message }); return; }
      this._scheduleReconnect(ev.reason || `code ${ev.code}`);
    };
  }

  _scheduleReconnect(reason) {
    this.attempt++;
    const delay = Math.min(5000, 300 * 2 ** Math.min(this.attempt - 1, 4)) * (0.8 + Math.random() * 0.4);
    this.setState('reconnecting', { attempt: this.attempt, reason, inMs: Math.round(delay) });
    this._timers.push(setTimeout(() => this._open(), delay));
  }

  /** Reconnect immediately (e.g. app came back to the foreground). */
  reconnectNow() {
    if (this.closedByUser) return;
    if (this.ws) { try { this.ws.close(); } catch { } this.ws = null; }
    this.attempt = Math.max(this.attempt, 1);
    this._open();
  }

  close() {
    this.closedByUser = true;
    this._clearTimers();
    if (this.ws) { try { this.ws.close(1000, 'bye'); } catch { } }
    this.ws = null;
    this.setState('closed', { reason: 'user' });
  }

  _clearTimers() {
    for (const t of this._timers) { clearTimeout(t); clearInterval(t); }
    this._timers = [];
  }

  get isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN && this.welcome; }

  sendJson(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendBinary(buf) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.welcome) this.ws.send(buf);
  }

  /** Bytes queued in the browser's socket buffer: used to drop redundant mouse moves on slow links. */
  get buffered() { return this.ws ? this.ws.bufferedAmount : 0; }

  _onMessage(data) {
    this.lastMessageAt = performance.now();
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      this._onJson(msg);
      return;
    }
    this.bytesIn += data.byteLength;
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
        this.emit('audio', { seq: view.getUint32(4, true), timeUs: Number(view.getBigInt64(8, true)), data: new Uint8Array(data, 16) });
        break;
    }
  }

  _onJson(msg) {
    switch (msg.t) {
      case 'welcome':
        this.welcome = msg;
        this.attempt = 0;
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
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
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
    const h = parseVideoHeader(view);
    const payload = new Uint8Array(data, VIDEO_HEADER);
    let a = this._assembly;
    if (h.flags & VF.FIRST) {
      a = this._assembly = {
        frameId: h.frameId, epoch: h.epoch, buf: new Uint8Array(h.total), received: 0, key: (h.flags & VF.KEY) !== 0,
        captureUs: h.captureUs, encodeMs: h.encodeMs, firstAt: performance.now(),
      };
    }
    if (!a || a.frameId !== h.frameId) return; // missed the first fragment (shouldn't happen on TCP)
    a.buf.set(payload, h.offset);
    a.received += payload.length;
    if (h.flags & VF.LAST) {
      this._assembly = null;
      // Ack on arrival: the host uses this for flow control + delivery-rate/RTT estimates.
      this.sendBinary(frameAck(a.frameId));
      this.emit('video-frame', {
        frameId: a.frameId, epoch: a.epoch, key: a.key, data: a.buf, captureUs: a.captureUs,
        encodeMs: a.encodeMs, receiveMs: performance.now() - a.firstAt, arrivedAt: performance.now(),
      });
    }
  }
}
