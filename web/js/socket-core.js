// The connection's WebSocket on a thread of its own (socket-worker.js runs this; the tests run it in Node). Chromium
// delivers a worker's socket messages on that worker's thread, so nothing the page does (sheets, layout, GC) holds
// them up, and what's time-critical never goes to the page at all:
//   - audio packets go to the player's MessagePort (player.js), decoded here (feed.js) and handed to the AudioWorklet;
//   - video fragments are put back together, each frame acked on its last fragment (docs/PROTOCOL.md) and handed to
//     the video worker's port (presenter.js) in the order they came, with the video-config that starts each epoch;
//   - everything else (JSON, the cursor), and sound or pictures with no port to go to, goes to the page as before.
// From the page (connection.js):
//   {type:'open', id, url}, {type:'send', id, data}, {type:'close', id, code, reason}
//   {type:'audio', port, opus, trim} (port null: packets to the page again), {type:'audio-config', trim}
//   {type:'video', port, optimizeForLatency} (port null: frames to the page again), {type:'dispose'}
// To the page: per socket {type:'open'|'error'|'close'|'message'|'audio'|'frame'|'tick', id, ...}, and
//   {type:'opus-unsupported'} (Opus came on a route that can't decode it).
import { H2C, FrameAssembler, frameAck, parseAudio } from './protocol.js';
import { AudioFeed } from './audio/feed.js';
import { configMessage } from './video/decoder-core.js';

const OPEN = 1;

export class SocketCore {
  /**
   * @param {object} o
   * @param {(message: object, transfer?: Transferable[]) => void} o.post to the page
   * @param {typeof WebSocket} [o.WebSocket]
   * @param {() => number} [o.now]
   * @param {number} [o.tickMs] how often the page hears what arrived here (bytes, buffered amount, last message)
   */
  constructor({ post, WebSocket: WS = globalThis.WebSocket, now = () => performance.now(), tickMs = 250 }) {
    this.post = post;
    this.WS = WS;
    this.now = now;
    this.tickMs = tickMs;
    this.sockets = new Map(); // id -> WebSocket
    this.current = 0;         // the newest socket that isn't closing: the only one whose messages count
    this.frames = new FrameAssembler(now);
    this.audio = null;        // { port, feed, toldOpus }
    this.video = null;        // { port, optimizeForLatency }
    this.bytes = 0;           // binary bytes since the last tick
    this.lastAt = 0;
    this.buffered = -1;
    this.timer = 0;
    this.disposed = false;
    this.onexit = null;       // disposed, and every socket closed
  }

  handle(m) {
    switch (m?.type) {
      case 'open': this._open(m.id, m.url); break;
      case 'send': {
        const ws = this.sockets.get(m.id);
        if (ws?.readyState === OPEN) ws.send(m.data);
        break;
      }
      case 'close': this._close(m.id, m.code, m.reason); break;
      case 'audio': this._routeAudio(m); break;
      case 'audio-config':
        if (this.audio) this.audio.feed.trim = m.trim || 0; // (fresh decoders from now on, as on the page)
        break;
      case 'video':
        if (this.video && this.video.port !== m.port) closePort(this.video.port);
        this.video = m.port ? { port: m.port, optimizeForLatency: m.optimizeForLatency !== false } : null;
        break;
      case 'dispose':
        this.disposed = true;
        this._routeAudio({ port: null });
        if (this.video) closePort(this.video.port);
        this.video = null;
        for (const id of [...this.sockets.keys()]) this._close(id);
        this._exitIfDone();
        break;
    }
  }

  _open(id, url) {
    let ws;
    try {
      ws = new this.WS(url);
    } catch (e) {
      this.post({ type: 'close', id, code: 1006, reason: e?.message || 'socket failed', wasClean: false });
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.sockets.set(id, ws);
    this.current = id;
    this.frames.reset();
    this.buffered = -1;
    ws.onopen = () => this.post({ type: 'open', id });
    ws.onerror = () => this.post({ type: 'error', id });
    ws.onclose = ev => {
      this.sockets.delete(id);
      if (this.current === id) { this.current = 0; this.frames.reset(); }
      this.post({ type: 'close', id, code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      if (!this.sockets.size) this._stopTicks();
      this._exitIfDone();
    };
    ws.onmessage = ev => {
      if (id !== this.current) return; // a socket being replaced or closed: the page ignores it too
      try {
        this._message(id, ev.data);
      } catch (e) {
        console.warn('[socket] message', e);
      }
    };
    this._startTicks();
  }

  _close(id, code, reason) {
    const ws = this.sockets.get(id);
    if (!ws) return;
    if (this.current === id) { this.current = 0; this.frames.reset(); } // its messages stop counting, as on the page
    try {
      if (code) ws.close(code, reason); else ws.close();
    } catch {
      try { ws.close(); } catch { }
    }
  }

  _message(id, data) {
    this.lastAt = this.now();
    if (typeof data === 'string') {
      // The video worker gets each epoch's config in order with its frames (they don't wait for the page).
      if (this.video && data.includes('"video-config"')) this._videoConfig(data);
      this.post({ type: 'message', id, data });
      return;
    }
    this.bytes += data.byteLength;
    const view = new DataView(data);
    const kind = data.byteLength ? view.getUint8(0) : -1;
    if (kind === H2C.VIDEO && data.byteLength >= 28) this._videoFragment(id, data, view);
    else if (kind === H2C.AUDIO && data.byteLength >= 16) this._audioPacket(id, data, view);
    else this.post({ type: 'message', id, data }, [data]); // the cursor (or what the page knows better)
  }

  _videoConfig(text) {
    let cfg;
    try { cfg = JSON.parse(text); } catch { return; }
    if (cfg?.t !== 'video-config') return;
    let msg;
    try { msg = configMessage(cfg, this.video.optimizeForLatency); } catch { return; }
    this.video.port.postMessage(msg, [msg.description]);
  }

  _videoFragment(id, data, view) {
    const f = this.frames.push(data, view);
    if (!f) return;
    // Ack on arrival: the host uses this for flow control + delivery-rate/RTT estimates.
    const ws = this.sockets.get(id);
    if (ws?.readyState === OPEN) ws.send(frameAck(f.frameId));
    const meta = { type: 'frame', id, frameId: f.frameId, epoch: f.epoch, key: f.key, captureUs: f.captureUs, encodeMs: f.encodeMs, receiveMs: f.receiveMs };
    if (this.video) {
      // Timestamps only need to be monotonic for the decoder: the host's capture clock (µs).
      this.video.port.postMessage({ type: 'chunk', epoch: f.epoch, frameId: f.frameId, key: f.key, data: f.data.buffer, ts: f.captureUs }, [f.data.buffer]);
      this.post(meta); // (the page's numbers: no picture)
    } else {
      meta.data = f.data;
      this.post(meta, [f.data.buffer]);
    }
  }

  _audioPacket(id, data, view) {
    const p = parseAudio(data, view);
    const a = this.audio;
    if (!a) {
      this.post({ type: 'audio', id, codec: p.codec, seq: p.seq, timeUs: p.timeUs, data: p.data }, [data]);
      return;
    }
    if (!p.codec && !a.feed.opus && !a.toldOpus) {
      a.toldOpus = true; // Opus arrives but can't be decoded here (an older computer that only sends Opus)
      this.post({ type: 'opus-unsupported' });
    }
    a.feed.packet(p);
  }

  /** Sound to the player's port from now on (decoded here), or with no port to the page again. */
  _routeAudio(m) {
    if (this.audio) {
      this.audio.feed.close();
      if (this.audio.port !== m.port) closePort(this.audio.port);
    }
    this.audio = null;
    if (!m.port) return;
    const port = m.port;
    const feed = new AudioFeed((msg, transfer) => port.postMessage(msg, transfer), { opus: !!m.opus, trim: m.trim || 0 });
    this.audio = { port, feed, toldOpus: false };
    port.postMessage({ type: 'hello' }); // the worklet passes it on to the page: the channel works
  }

  _startTicks() {
    if (!this.timer) this.timer = setInterval(() => this._tick(), this.tickMs);
  }

  _stopTicks() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  /** What the page can't see for itself: bytes that came here, the socket's send buffer, when the last message came. */
  _tick() {
    const ws = this.sockets.get(this.current);
    if (!ws || ws.readyState !== OPEN) return;
    const buffered = ws.bufferedAmount || 0;
    if (!this.bytes && buffered === this.buffered) return;
    this.post({ type: 'tick', id: this.current, bytes: this.bytes, buffered, agoMs: Math.max(0, this.now() - this.lastAt) });
    this.bytes = 0;
    this.buffered = buffered;
  }

  _exitIfDone() {
    if (!this.disposed || this.sockets.size) return;
    this._stopTicks();
    this.onexit?.();
  }
}

function closePort(port) {
  try { port?.close(); } catch { }
}
