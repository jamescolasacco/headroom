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
    let caps = { vtg: false, decoder: false };
    let worker = null;
    try {
      worker = new Worker(new URL('./video-worker.js', import.meta.url), { type: 'module' });
      caps = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('worker probe timeout')), 3000);
        worker.onmessage = e => { if (e.data.type === 'caps') { clearTimeout(t); resolve(e.data); } };
        worker.onerror = err => { clearTimeout(t); reject(err); };
        worker.postMessage({ type: 'probe' });
      });
    } catch (e) {
      console.warn('[video] worker unavailable:', e);
      worker?.terminate();
      worker = null;
    }

    const canOffscreen = !!this.canvas.transferControlToOffscreen;
    let mode;
    if (worker && caps.decoder) {
      if (this.preference === 'canvas') mode = canOffscreen ? 'worker-canvas' : 'main-canvas';
      else if (this.preference === 'video') mode = caps.vtg ? 'vtg' : (canOffscreen ? 'worker-canvas' : 'main-canvas');
      else mode = caps.vtg && isWebKit ? 'vtg' : (canOffscreen ? 'worker-canvas' : (caps.vtg ? 'vtg' : 'main-canvas'));
    } else {
      mode = 'main-canvas';
    }
    if (mode === 'main-canvas' && worker) { worker.terminate(); worker = null; }
    this.mode = mode;

    if (mode === 'vtg') {
      this.canvas.hidden = true;
      this.video.hidden = false;
      const track = await new Promise(resolve => {
        worker.onmessage = e => { if (e.data.type === 'track') resolve(e.data.track); else this._onWorker(e.data); };
        worker.postMessage({ type: 'init', mode: 'vtg' });
      });
      worker.onmessage = e => this._onWorker(e.data);
      this.video.srcObject = new MediaStream([track]);
      this.video.play().catch(err => console.warn('[video] play() rejected', err));
      if (this.video.requestVideoFrameCallback) {
        const tick = (now, meta) => { this._presented(meta); this.video.requestVideoFrameCallback(tick); };
        this.video.requestVideoFrameCallback(tick);
      }
    } else if (mode === 'worker-canvas') {
      this.video.hidden = true;
      this.canvas.hidden = false;
      const off = this.canvas.transferControlToOffscreen();
      worker.onmessage = e => this._onWorker(e.data);
      worker.postMessage({ type: 'init', mode: 'canvas', canvas: off }, [off]);
    } else {
      this.video.hidden = true;
      this.canvas.hidden = false;
      this.core = new DecoderCore({ kind: 'canvas', canvas: this.canvas }, msg => this._onWorker(msg));
    }
    this.worker = worker;
    console.info(`[video] render path: ${mode}`);
    this.emit('mode', { mode });
  }

  _onWorker(m) {
    switch (m.type) {
      case 'decoded':
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

  _presented(meta) {
    this.presentedFrames = meta?.presentedFrames;
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
  get fps() {
    const now = performance.now();
    while (this.frameTimes.length && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    return this.frameTimes.length;
  }

  close() {
    this.worker?.postMessage({ type: 'close' });
    this.worker = null;
    this.core?.close();
    this.core = null;
    if (this.video.srcObject) {
      this.video.srcObject.getTracks().forEach(t => t.stop());
      this.video.srcObject = null;
    }
  }
}
