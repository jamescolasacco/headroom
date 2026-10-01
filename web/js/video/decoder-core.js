// WebCodecs H.264 decode + present. Runs inside the video worker, or on the main thread as a fallback.
//
// Rules learned the hard way by other web streamers (Selkies, moonlight-web-stream, KasmVNC):
//  * after configure()/reset(), the first chunk must be a keyframe; drop deltas until one arrives;
//  * always close() VideoFrames, keep only the newest (hardware pools are ~16 frames and stall silently);
//  * a decoder can accept a config yet never output (old iOS / some GPUs): watchdog -> prefer-software;
//  * Chrome reclaims idle decoders in background tabs (QuotaExceededError): recreate + ask for an IDR;
//  * if decode falls behind, reset and resync on a fresh keyframe instead of building latency.

export class DecoderCore {
  /**
   * @param {object} sink   { kind: 'canvas', canvas } | { kind: 'vtg', writer }
   * @param {function} post  (msg) => void   status/stat messages back to the presenter
   */
  constructor(sink, post) {
    this.sink = sink;
    this.post = post;
    this.decoder = null;
    this.config = null;
    this.epoch = -1;
    this.needKey = true;
    this.hwPref = 'no-preference';
    this.inFlight = new Map();      // timestamp -> {t0, frameId}
    this.lastOutputAt = 0;
    this.lastChunkAt = 0;
    this.chunksSinceOutput = 0;
    this.keyRequestAt = 0;
    this.ctx = null;
    this.stats = { decoded: 0, dropped: 0, decodeMsSum: 0, errors: 0 };
    this.statsTimer = setInterval(() => this.flushStats(), 500);
  }

  configure(cfg) {
    // cfg: { epoch, codec, description(ArrayBuffer), width, height, optimizeForLatency }
    this.config = cfg;
    this.epoch = cfg.epoch;
    this.hwPref = cfg.hardwareAcceleration || this.hwPref;
    if (this.sink.kind === 'canvas') {
      const c = this.sink.canvas;
      if (c.width !== cfg.width || c.height !== cfg.height) { c.width = cfg.width; c.height = cfg.height; }
      if (!this.ctx) this.ctx = c.getContext('2d', { alpha: false, desynchronized: true });
    }
    this._createDecoder();
  }

  _createDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch { }
    }
    this.inFlight.clear();
    this.needKey = true;
    const cfg = this.config;
    const dc = {
      codec: cfg.codec,
      description: cfg.description,
      codedWidth: cfg.width,
      codedHeight: cfg.height,
      hardwareAcceleration: this.hwPref,
      optimizeForLatency: cfg.optimizeForLatency !== false,
    };
    this.decoder = new VideoDecoder({
      output: f => this._output(f),
      error: e => this._error(e),
    });
    try {
      this.decoder.configure(dc);
    } catch (e) {
      this._error(e);
      return;
    }
    this.lastOutputAt = performance.now();
    this.chunksSinceOutput = 0;
    this._requestKey('configure');
  }

  decode(m) {
    // m: { epoch, frameId, key, data(ArrayBuffer), ts }
    if (!this.decoder || this.decoder.state !== 'configured' || m.epoch !== this.epoch) return;
    if (this.needKey && !m.key) {
      this.stats.dropped++;
      this._requestKey('waiting-for-key');
      return;
    }
    // Backlog: the decoder can't keep up — resync rather than lag behind.
    if (this.decoder.decodeQueueSize > 8) {
      this.post({ type: 'log', level: 'warn', msg: `decoder backlog ${this.decoder.decodeQueueSize}; resyncing` });
      this._createDecoder();
      return;
    }
    this.needKey = false;
    const now = performance.now();
    this.lastChunkAt = now;
    this.chunksSinceOutput++;
    this.inFlight.set(m.ts, { t0: now, frameId: m.frameId });
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: m.ts, data: m.data }));
    } catch (e) {
      this._error(e);
      return;
    }
    // Watchdog: config accepted but nothing ever comes out.
    if (this.chunksSinceOutput > 30 && now - this.lastOutputAt > 2000) {
      if (this.hwPref !== 'prefer-software') {
        this.post({ type: 'log', level: 'warn', msg: 'decoder produced no output; retrying with software decoding' });
        this.hwPref = 'prefer-software';
        this._createDecoder();
      }
    }
  }

  _output(frame) {
    const now = performance.now();
    this.lastOutputAt = now;
    this.chunksSinceOutput = 0;
    const meta = this.inFlight.get(frame.timestamp);
    this.inFlight.delete(frame.timestamp);
    if (this.inFlight.size > 32) this.inFlight.clear();
    if (meta) { this.stats.decodeMsSum += now - meta.t0; }
    this.stats.decoded++;
    this.post({ type: 'decoded', frameId: meta?.frameId, decodeMs: meta ? now - meta.t0 : 0, w: frame.displayWidth, h: frame.displayHeight });

    if (this.sink.kind === 'vtg') {
      const w = this.sink.writer;
      if (w.desiredSize !== null && w.desiredSize <= 0) {
        frame.close();
        this.stats.dropped++;
        return;
      }
      w.write(frame).catch(() => { try { frame.close(); } catch { } });
      return;
    }
    // Canvas: draw immediately; the compositor shows it at the next vsync.
    try {
      const c = this.sink.canvas;
      this.ctx.drawImage(frame, 0, 0, c.width, c.height);
    } finally {
      frame.close();
    }
  }

  _error(e) {
    this.stats.errors++;
    const name = e?.name || '';
    this.post({ type: 'log', level: 'error', msg: `decoder error: ${name} ${e?.message || e}` });
    // QuotaExceededError = reclaimed by the browser: just recreate. Repeated real errors: try software.
    if (name !== 'QuotaExceededError' && this.stats.errors > 3 && this.hwPref !== 'prefer-software') this.hwPref = 'prefer-software';
    // Recreate on the next tick so we're not inside the decoder's error callback.
    setTimeout(() => { if (this.config) this._createDecoder(); }, 0);
  }

  _requestKey(reason) {
    const now = performance.now();
    if (now - this.keyRequestAt < 400) return;
    this.keyRequestAt = now;
    this.post({ type: 'need-keyframe', reason });
  }

  flushStats() {
    const s = this.stats;
    this.post({
      type: 'stats', decoded: s.decoded, dropped: s.dropped, errors: s.errors,
      decodeMs: s.decoded ? s.decodeMsSum / s.decoded : 0, queue: this.decoder?.decodeQueueSize || 0, hw: this.hwPref,
    });
    this.stats = { decoded: 0, dropped: 0, decodeMsSum: 0, errors: s.errors };
  }

  close() {
    clearInterval(this.statsTimer);
    try { this.decoder?.close(); } catch { }
    this.decoder = null;
  }
}
