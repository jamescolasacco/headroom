// Chooses the fastest decode/present path for this browser and hides the differences.
//   Safari 18+:  worker VideoDecoder -> VideoTrackGenerator -> <video>   (drawImage(VideoFrame) is slow in WebKit)
//   Chromium/FF: worker VideoDecoder -> OffscreenCanvas 2D               (off-main-thread, low latency)
//   fallback:    main-thread VideoDecoder -> <canvas>
import { DecoderCore } from './decoder-core.js';
import { isWebKit } from '../platform.js';

export class VideoPresenter extends EventTarget {
  constructor({ video, canvas, preference = 'auto' }) {
    super();
    this.video = video;
    this.canvas = canvas;
    this.preference = preference;
    this.mode = null;
    this.worker = null;
    this.core = null;
    this.config = null;
    this.width = 0;
    this.height = 0;
    this.lastStats = null;
    this.frameTimes = [];
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async start() {
    // A canvas can only be transferred to a worker once; start every session on a fresh element.
    const fresh = this.canvas.cloneNode(false);
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
    let mode = 'main-canvas';
    try {
      this.worker = new Worker(new URL('./video-worker.js', import.meta.url), { type: 'module' });
      const caps = await this._workerReply({ type: 'probe' }, 'caps');
      if (this.closed) return;
      const canvas = !!this.canvas.transferControlToOffscreen;
      if (caps.decoder && caps.vtg && this.preference !== 'canvas' && (this.preference === 'video' || isWebKit || !canvas)) {
        const { track } = await this._workerReply({ type: 'init', mode: 'vtg' }, 'track');
        if (this.closed) { track?.stop(); return; }
        this.video.srcObject = new MediaStream([track]);
        this.video.play().catch(err => console.warn('[video] play() rejected', err));
        mode = 'vtg';
      } else if (caps.decoder && canvas) {
        const off = this.canvas.transferControlToOffscreen();
        this.worker.postMessage({ type: 'init', mode: 'canvas', canvas: off }, [off]);
        mode = 'worker-canvas';
      }
    } catch (e) {
      if (this.closed) return;
      console.warn('[video] worker unavailable:', e);
      // A canvas that was transferred before a failed init cannot be used on this thread.
      const replacement = this.canvas.cloneNode(false);
      this.canvas.replaceWith(replacement);
      this.canvas = replacement;
    }
    if (mode === 'main-canvas') {
      this.worker?.terminate();
      this.worker = null;
      this.core = new DecoderCore({ kind: 'canvas', canvas: this.canvas }, msg => this._onWorker(msg));
    } else {
      this.worker.onmessage = e => this._onWorker(e.data);
    }
    this.mode = mode;
    this.canvas.hidden = mode === 'vtg';
    this.video.hidden = mode !== 'vtg';
    console.info(`[video] render path: ${mode}`);
    this.emit('mode', { mode });
  }

  async _workerReply(request, replyType) {
    const worker = this.worker;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        this.cancelStartup = () => reject(new Error('session closed'));
        timer = setTimeout(() => reject(new Error(`video worker timed out waiting for ${replyType}`)), 3000);
        worker.onerror = reject;
        worker.onmessage = e => { if (e.data.type === replyType) resolve(e.data); };
        worker.postMessage(request);
      });
    } finally {
      clearTimeout(timer);
      this.cancelStartup = null;
      worker.onerror = null;
    }
  }

  _onWorker(m) {
    switch (m.type) {
      case 'decoded':
        this._trimFrameTimes();
        this.frameTimes.push(performance.now());
        this.emit('decoded', m);
        break;
      case 'stats':
        this.lastStats = m;
        this.emit('stats', m);
        break;
      case 'need-keyframe':
        this.emit('need-keyframe', m);
        break;
      case 'log':
        (m.level === 'error' ? console.error : console.warn)('[video]', m.msg);
        if (m.level === 'error') this.emit('error', m);
        break;
    }
  }

  configure(cfg) {
    // cfg from host: { epoch, codec, description (base64), width, height, ... }
    const desc = Uint8Array.from(atob(cfg.description), c => c.charCodeAt(0));
    this.width = cfg.width;
    this.height = cfg.height;
    this.config = cfg;
    const msg = {
      type: 'config', epoch: cfg.epoch, codec: cfg.codec, description: desc.buffer,
      width: cfg.width, height: cfg.height,
      // optimizeForLatency is honoured by Chromium; on WebKit it caused smearing on iOS 27 (reported),
      // and the host's SPS already declares zero reordering, which is what really removes buffering.
      optimizeForLatency: !isWebKit,
    };
    if (this.worker) this.worker.postMessage(msg, [msg.description]);
    else this.core?.configure(msg);
  }

  frame(f) {
    // Timestamps only need to be monotonic for the decoder: use the host capture clock (µs).
    const msg = { type: 'chunk', epoch: f.epoch, frameId: f.frameId, key: f.key, data: f.data.buffer, ts: f.captureUs };
    if (this.worker) this.worker.postMessage(msg, [msg.data]);
    else this.core?.decode(msg);
  }

  /** Displayed frames per second over the last second. */
  _trimFrameTimes() {
    const now = performance.now();
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
  }

  get fps() {
    this._trimFrameTimes();
    return this.frameTimes.length;
  }

  close() {
    this.closed = true;
    this.cancelStartup?.();
    this.worker?.terminate();
    this.worker = null;
    this.core?.close();
    this.core = null;
    if (this.video.srcObject) {
      this.video.srcObject.getTracks().forEach(t => t.stop());
      this.video.srcObject = null;
    }
  }
}
