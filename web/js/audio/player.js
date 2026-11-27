// System audio. Packets (connection.js) carry a codec: 0 Opus (WebCodecs' AudioDecoder), 1 24-bit PCM, 2 silence;
// PCM and silence need no decoder, so lossless plays even where Opus can't be decoded. Everything ends up in the
// AudioWorklet (worklet.js), which plays what playout.js decides: exactly as before with audio priority off, a steady
// drift-proof buffer with it on.
// The AudioContext must be created/resumed inside a user gesture (iOS), so unlock() is called from the toolbar's
// Unmute tap, and close() (Mute) lets go of the device's audio. navigator.audioSession 'playback' makes iOS
// ignore the silent switch.
//
// Where the connection's socket runs in a worker (connection.js: Chromium), its packets never come to this thread:
// that worker decodes them (feed.js) and hands the sound to the worklet through a MessagePort of its own, in every
// mode, so a busy page (sheets, layout, GC) delays nothing. Otherwise, with audio priority on, Opus is decoded in a
// worker (decode-worker.js) that hands the sound straight to the worklet, so a busy main thread can delay a packet but
// not its decoding; where workers can't decode Opus, on the main thread as before. Once a session's packets go to the
// worker they stay there until Mute (switching back and forth could reorder them); priority off from the start
// decodes on the main thread exactly as before.
//
// Test hook, inert unless enabled: set globalThis.__headroomAudioTest = true (or { bundle: true } to load the
// one-file worklet) before unlock(). The worklet then keeps running hashes of what arrived and what played, published
// with its stats every 0.5 s as globalThis.__headroomAudioState (and this.testState).
import { hasAudioDecoder } from '../platform.js';
import { AudioFeed, OPUS_CONFIG, OPUS_LOOKAHEAD } from './feed.js';

const AC = globalThis.AudioContext || globalThis.webkitAudioContext;

export class AudioPlayer extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this.ready = null;
    this.enabled = false;
    /** Sound can play here (an AudioWorklet): PCM always, Opus only if opusSupported. */
    this.supported = !!AC && typeof AudioWorkletNode === 'function';
    /** Opus can be decoded: null until known. Without it, only lossless (PCM) plays: ask the computer for that. */
    this.opusSupported = hasAudioDecoder ? null : false;
    let check = Promise.resolve(false);
    if (hasAudioDecoder) {
      try { check = AudioDecoder.isConfigSupported(OPUS_CONFIG).then(r => !!r?.supported, () => false); } catch { }
    }
    /** Resolves to opusSupported; a 'support' event follows. */
    this.opusCheck = check.then(ok => {
      this.opusSupported = ok;
      this.dispatchEvent(new Event('support'));
      return ok;
    });
    this.priority = false;
    this.quality = 'compressed';
    this.mode = 'opus';
    /** The worklet's latest numbers (see Playout.stats()); a 'stats' event carries each. */
    this.stats = null;
    this.testState = null;
    this.feed = null;    // the main thread's
    this.worker = null;  // decodes Opus in priority mode, when it can
    this.routed = false; // packets go to the worker
    this.source = null;  // the connection (setSource): its socket's worker can take the packets to the worklet itself
    this.socketRouted = false; // they do
  }

  /** The session's connection: where its socket runs in a worker, the packets go from there to the worklet. */
  setSource(conn) { this.source = conn; }

  /**
   * What to play: { priority, quality: 'lossless' | 'compressed', mode: 'pcm24' | 'opus' }. Quality and mode are
   * what the session asks the computer for; each packet's codec decides the decoding.
   */
  configure({ priority, quality, mode } = {}) {
    if (quality) this.quality = quality;
    if (mode) this.mode = mode;
    if (priority === undefined || !!priority === this.priority) return;
    this.priority = !!priority;
    if (this.feed) this.feed.trim = this.priority ? OPUS_LOOKAHEAD : 0; // (fresh decoders from now on)
    if (this.socketRouted) this.source.audioTrim(this.priority ? OPUS_LOOKAHEAD : 0);
    if (!this.node) return;
    this.node.port.postMessage({ type: 'config', priority: this.priority });
    if (this.priority) this._startWorker();
  }

  /** Call synchronously from a user gesture. */
  async unlock() {
    if (!this.supported) return;
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { }
    if (!this.ctx) {
      const t = globalThis.__headroomAudioTest;
      this.test = !!t;
      this.forceBundle = !!t?.bundle;
      this.ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' });
      this.ready = this._init(this.ctx);
    }
    // Don't await: resume() can hang during an iOS audio interruption.
    this.ctx.resume?.().catch(() => { });
    return this.ready;
  }

  /** Sets up `ctx`, unless it was closed meanwhile (muted again before it was ready). */
  async _init(ctx) {
    const node = await this._createNode(ctx);
    const opus = await this.opusCheck;
    if (ctx !== this.ctx) return;
    this.node = node;
    node.port.onmessage = e => this._fromWorklet(e.data);
    node.port.postMessage({ type: 'config', priority: this.priority }); // configure() may have come meanwhile
    this.gain = ctx.createGain();
    this.gain.gain.value = this.enabled ? 1 : 0;
    node.connect(this.gain).connect(ctx.destination);
    // Priority: a fresh Opus decoder's lookahead is dropped, so a switch from lossless joins seamlessly (off: as before).
    this.feed = new AudioFeed((msg, transfer) => this.node?.port.postMessage(msg, transfer), { opus, trim: this.priority ? OPUS_LOOKAHEAD : 0 });
    if (this.source?.offMain) this._routeSocket(ctx, node, opus);
    if (this.priority) this._startWorker();
  }

  /**
   * The socket's worker decodes and hands the sound to the worklet from now on (connection.js routeAudio). Nothing has
   * played yet (packets before the worklet was ready went nowhere), so the worklet takes the channel's at once.
   */
  _routeSocket(ctx, node, opus) {
    const ch = new MessageChannel();
    node.port.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
    node.port.postMessage({ type: 'route' });
    this.socketRouted = this.source.routeAudio(ch.port2, {
      opus, trim: this.priority ? OPUS_LOOKAHEAD : 0,
      onLost: () => this._unrouteSocket(node), // the worker never started: packets come here again
      onOpusUnsupported: () => this._opusUnsupported(),
    });
    if (!this.socketRouted) return;
    this._socketHello = false;
    // The worker says hello through the channel (the worklet passes it on); without one the channel doesn't work.
    // (A second look a moment later: after a long stall here the hello may be waiting behind this timer.)
    this._socketTimer = setTimeout(() => {
      if (!this._socketHello) this._socketTimer = setTimeout(() => { if (!this._socketHello) this._unrouteSocket(node, true); }, 1000);
    }, 3000);
    // This thread sees no packets, so it can't resume a context the browser suspended when the next one comes.
    ctx.addEventListener?.('statechange', () => {
      if (ctx === this.ctx && this.enabled && ctx.state === 'suspended') ctx.resume().catch(() => { });
    });
  }

  /** Packets come to this thread again (decoded here, as without a socket worker). */
  _unrouteSocket(node, tell = false) {
    if (!this.socketRouted || this.node !== node) return;
    this.socketRouted = false;
    clearTimeout(this._socketTimer);
    if (tell) this.source?.routeAudio(null);
    this._noDecodeWorker = true; // (the worklet already takes channels at once: the two could reorder)
  }

  _opusUnsupported() {
    if (this._toldOpus) return;
    this._toldOpus = true; // Opus arrives but can't be decoded here (an older computer that only sends Opus)
    this.dispatchEvent(new Event('opus-unsupported'));
  }

  async _createNode(ctx) {
    const options = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { priority: this.priority, test: this.test } };
    if (!this.forceBundle) {
      try {
        await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
        return new AudioWorkletNode(ctx, 'headroom-pcm', options);
      } catch (e) {
        if (ctx !== this.ctx) throw e;
      }
    }
    // Safari 14 runs worklet scripts as classic scripts and Firefox before 113 can't import in them (the module then
    // registers nothing, or fails to load): the same code as one file.
    await ctx.audioWorklet.addModule(new URL('./worklet-bundle.js', import.meta.url));
    this.bundled = true;
    return new AudioWorkletNode(ctx, 'headroom-pcm', options);
  }

  _fromWorklet(m) {
    if (m.type === 'stats') {
      this.stats = m.stats;
      if (this.test) {
        const decoding = this.socketRouted ? 'socket-worker' : this.routed ? 'worker' : 'main';
        this.testState = { ...m.stats, decoding, worklet: this.bundled ? 'bundle' : 'module', at: Date.now() };
        globalThis.__headroomAudioState = this.testState;
      }
      this.dispatchEvent(new CustomEvent('stats', { detail: m.stats }));
    } else if (m.type === 'hello') {
      if (this.socketRouted) { this._socketHello = true; clearTimeout(this._socketTimer); }
      this._workerHello?.();
    }
  }

  /** Opus decoding in a worker that talks to the worklet directly; used once both ends say it works. */
  _startWorker() {
    if (this.worker || this._workerStarting || this.socketRouted || this._noDecodeWorker || typeof Worker === 'undefined' ||
        typeof MessageChannel === 'undefined' || !hasAudioDecoder || this.opusSupported === false || !this.node) return;
    let worker;
    try {
      worker = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
    } catch {
      return;
    }
    this._workerStarting = true;
    const node = this.node;
    let ready = false, hello = false, done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this._workerStarting = false;
      this._workerHello = null;
      worker.onmessage = null;
      worker.onerror = null;
      if (!ok || this.node !== node) { worker.terminate(); return; }
      this.worker = worker;
      // If it ever dies, the main thread decodes again (the worklet always takes the main thread's packets).
      worker.onerror = () => {
        if (this.worker !== worker) return;
        this.worker = null;
        this.routed = false;
        worker.terminate();
      };
    };
    const timer = setTimeout(() => finish(false), 3000);
    worker.onmessage = e => {
      if (e.data?.type !== 'ready') return;
      if (!e.data.opus) { finish(false); return; }
      ready = true;
      if (hello) finish(true);
    };
    worker.onerror = () => finish(false);
    this._workerHello = () => { hello = true; if (ready) finish(true); };
    const ch = new MessageChannel();
    node.port.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
    worker.postMessage({ type: 'init', port: ch.port2 }, [ch.port2]);
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.gain) this.gain.gain.value = on ? 1 : 0;
    if (!on) this.node?.port.postMessage({ type: 'flush' });
  }

  /** One audio packet from connection.js: { codec, seq, timeUs, data }. */
  packet(p) {
    // (Routed through the socket's worker: one that was already on its way here is older than what the worklet has.)
    if (!this.enabled || !this.node || !this.feed || this.socketRouted) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => { });
    if (!p.codec && this.opusSupported === false) this._opusUnsupported();
    // Priority: over to the worker once the main thread's feed has nothing in flight; 'route' tells the worklet
    // where the main thread's packets end.
    if (!this.routed && this.worker && this.priority && this.feed.idle) {
      this.node.port.postMessage({ type: 'route' });
      this.routed = true;
    }
    if (this.routed) {
      const data = p.data ? p.data.slice() : new Uint8Array(0);
      this.worker.postMessage({ type: 'packet', codec: p.codec || 0, seq: p.seq, timeUs: p.timeUs, data }, [data.buffer]);
    } else {
      this.feed.packet(p);
    }
  }

  close() {
    this.enabled = false;
    this.feed?.close();
    this.feed = null;
    this.worker?.terminate();
    this.worker = null;
    this.routed = false;
    this._workerHello = null;
    this._workerStarting = false;
    this._toldOpus = false;
    if (this.socketRouted) this.source?.routeAudio(null);
    this.socketRouted = false;
    this._noDecodeWorker = false;
    clearTimeout(this._socketTimer);
    this.node?.disconnect();
    this.ctx?.close().catch(() => { });
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this.ready = null;
    this.stats = null;
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'auto';
    } catch { }
  }
}
