// Packets -> the AudioWorklet, in the order they came: 24-bit PCM and silence go straight through (the worklet decodes
// PCM itself), Opus through WebCodecs' AudioDecoder first. A packet still decoding holds the ones behind it, so a
// silence or PCM packet never overtakes the Opus before it. Runs on the main thread, in decode-worker.js, or in the
// connection's socket worker (socket-core.js).
export const OPUS_CONFIG = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 };
/** Both hosts' Opus lookahead (libopus restricted low delay on the Mac, Concentus on Windows), in frames. */
export const OPUS_LOOKAHEAD = 120;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class AudioFeed {
  /**
   * @param {(message: object, transfer: Transferable[]) => void} post delivers to the worklet
   * @param {{opus?: boolean, trim?: number}} [o] opus: false drops Opus packets (no decoder here); trim: frames a fresh
   *   decoder's first output loses (its lookahead: OPUS_LOOKAHEAD), so a stream joins seamlessly what played before
   */
  constructor(post, { opus = true, trim = 0 } = {}) {
    this.post = post;
    this.opus = opus && typeof AudioDecoder !== 'undefined';
    this.trim = trim;
    this.lastSound = null; // codec of the last sound packet (silence packets don't count)
    this.queue = [];      // in arrival (= seq) order: { seq, timeUs, msg, transfer, dec, waiting }
    this.decoder = null;
    this.retryAt = 0;
    this.backoff = 100;
    this.decoded = 0;
    this.lost = 0;
  }

  /** Nothing in flight: switching to another feed now keeps the order. */
  get idle() { return this.queue.length === 0; }

  /** One packet from connection.js: { codec, seq, timeUs, data } (data: the payload). */
  packet(p) {
    const codec = p.codec || 0, seq = p.seq >>> 0, timeUs = p.timeUs, data = p.data;
    if (codec === 1) {
      this.lastSound = 1;
      // The worklet decodes it: hand over the bytes (a copy unless they're the whole of their own buffer).
      const bytes = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer;
      this.queue.push({ msg: { type: 'pcm24', seq, timeUs, bytes }, transfer: [bytes] });
    } else if (codec === 2) { // 480 zeros (its payload says 480); never fed to the Opus decoder
      this.queue.push({ msg: { type: 'silence', seq, timeUs } });
    } else if (codec === 0) {
      // Opus after lossless is a new stream from a fresh encoder: a fresh decoder for it (the old one finishes first).
      if (this.lastSound === 1 && this.decoder) this._retire();
      this.lastSound = 0;
      const dec = this.opus ? this._decoder() : null;
      if (!dec) { this.lost++; return; } // the worklet sees the gap
      const e = { seq, timeUs, dec, waiting: true, msg: null };
      this.queue.push(e);
      try {
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: timeUs, data }));
      } catch (err) {
        e.waiting = false;
        this.lost++;
      }
    } else {
      return; // a codec this client doesn't know
    }
    this._drain();
  }

  _decoder() {
    if (this.decoder && this.decoder.state === 'configured') return this.decoder;
    if (now() < this.retryAt) return null;
    let dec;
    try {
      dec = new AudioDecoder({
        output: data => this._output(dec, data),
        error: e => this._error(dec, e),
      });
      // No description: each chunk is a raw Opus packet (Chrome rejects an empty description).
      dec.configure(OPUS_CONFIG);
      dec.trim = this.trim; // its first frames are the encoder's lookahead: dropped
    } catch (e) {
      this._error(dec, e);
      return null;
    }
    this.decoder = dec;
    return dec;
  }

  _output(dec, data) {
    try {
      // The oldest packet this decoder still owes (the one with this timestamp, if the decoder kept them).
      const q = this.queue;
      let at = -1;
      for (let i = 0; i < q.length; i++) {
        const e = q[i];
        if (!e.waiting || e.dec !== dec) continue;
        if (at < 0) at = i;
        if (e.timeUs === data.timestamp) { at = i; break; }
      }
      if (at < 0) return;
      for (let i = 0; i < at; i++) if (q[i].waiting && q[i].dec === dec) { q[i].waiting = false; this.lost++; } // never came out
      const e = q[at];
      const frames = data.numberOfFrames, ch = Math.min(2, data.numberOfChannels);
      const trim = Math.min(dec.trim || 0, frames), n = frames - trim;
      dec.trim = (dec.trim || 0) - trim;
      const left = new Float32Array(n), right = new Float32Array(n);
      if (n) {
        // Safari outputs interleaved, Chrome planar: f32-planar copyTo is mandatory for every UA.
        data.copyTo(left, { planeIndex: 0, frameOffset: trim, frameCount: n, format: 'f32-planar' });
        if (ch > 1) data.copyTo(right, { planeIndex: 1, frameOffset: trim, frameCount: n, format: 'f32-planar' }); else right.set(left);
      }
      e.msg = { type: 'pcm', seq: e.seq, timeUs: e.timeUs, codec: 0, left, right };
      if (trim) e.msg.trim = trim; // the first frames of its 10 ms are gone (the playout places the rest)
      e.transfer = [left.buffer, right.buffer];
      e.waiting = false;
      this.decoded++;
      this.backoff = 100;
    } catch (err) {
      console.warn('[audio] decoded audio unreadable', err);
    } finally {
      data.close();
    }
    this._drain();
  }

  _error(dec, e) {
    console.warn('[audio] decoder error', e);
    for (const x of this.queue) if (x.waiting && x.dec === dec) { x.waiting = false; this.lost++; }
    if (this.decoder === dec || !this.decoder) this.decoder = null;
    try { if (dec && dec.state !== 'closed') dec.close(); } catch { }
    this.retryAt = now() + this.backoff;
    this.backoff = Math.min(5000, this.backoff * 2);
    this._drain();
  }

  _drain() {
    const q = this.queue;
    let n = 0;
    while (n < q.length && !q[n].waiting) {
      const e = q[n++];
      if (e.msg) this.post(e.msg, e.transfer || []);
    }
    // A decode that never comes back mustn't hold everything behind it for long (64 packets: 0.64 s).
    if (n === 0 && q.length > 64) { q[0].waiting = false; this.lost++; this._drain(); return; }
    if (n) q.splice(0, n);
  }

  /** Lets the current decoder finish what it owes, then closes it; the next Opus packet gets a fresh one. */
  _retire() {
    const old = this.decoder;
    this.decoder = null;
    const close = () => { try { if (old.state !== 'closed') old.close(); } catch { } };
    if (this.queue.some(e => e.waiting && e.dec === old)) old.flush().then(close, close);
    else close();
  }

  close() {
    try { this.decoder?.close(); } catch { }
    this.decoder = null;
    this.queue = [];
  }
}
