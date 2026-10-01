// System audio: Opus packets -> WebCodecs AudioDecoder -> AudioWorklet ring buffer.
// The AudioContext must be created/resumed inside a user gesture (iOS), so unlock() is called from the
// "connect" tap. navigator.audioSession 'playback' makes iOS ignore the silent switch.
import { hasAudioDecoder } from '../platform.js';

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.decoder = null;
    this.enabled = false;
    this.supported = hasAudioDecoder;
    this.ready = null;
    this.lastSeq = 0;
    this.gain = null;
  }

  /** Call synchronously from a user gesture. */
  unlock() {
    if (!this.supported) return;
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { }
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.supported = false; return; }
      this.ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' });
      this.ready = this._init();
    }
    // Don't await: resume() can hang during an iOS audio interruption.
    this.ctx.resume?.().catch(() => { });
  }

  async _init() {
    await this.ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'headroom-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.gain = this.ctx.createGain();
    this.node.connect(this.gain).connect(this.ctx.destination);
    const ok = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }).catch(() => ({ supported: false }));
    if (!ok.supported) { this.supported = false; throw new Error('opus AudioDecoder unsupported'); }
    this._createDecoder();
  }

  _createDecoder() {
    this.decoder = new AudioDecoder({
      output: data => this._output(data),
      error: e => { console.warn('[audio] decoder error', e); setTimeout(() => this._createDecoder(), 100); },
    });
    // No description: each chunk is a raw Opus packet (Chrome rejects an empty description).
    this.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.gain) this.gain.gain.value = on ? 1 : 0;
    if (!on) this.node?.port.postMessage({ type: 'flush' });
  }

  packet(p) {
    if (!this.enabled || !this.decoder || this.decoder.state !== 'configured') return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => { });
    if (p.seq !== this.lastSeq + 1 && this.lastSeq !== 0) {
      // Gap (silence on the host produces no packets): let the worklet re-buffer from scratch.
      this.node?.port.postMessage({ type: 'gap' });
    }
    this.lastSeq = p.seq;
    try {
      this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.timeUs, data: p.data }));
    } catch (e) {
      console.warn('[audio] decode failed', e);
    }
  }

  _output(data) {
    try {
      const frames = data.numberOfFrames;
      const ch = Math.min(2, data.numberOfChannels);
      const left = new Float32Array(frames), right = new Float32Array(frames);
      // Safari outputs interleaved, Chrome planar: f32-planar copyTo is mandatory for every UA.
      data.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
      if (ch > 1) data.copyTo(right, { planeIndex: 1, format: 'f32-planar' }); else right.set(left);
      this.node?.port.postMessage({ type: 'pcm', left, right }, [left.buffer, right.buffer]);
    } finally {
      data.close();
    }
  }

  close() {
    try { this.decoder?.close(); } catch { }
    this.decoder = null;
    this.node?.disconnect();
    this.ctx?.close().catch(() => { });
    this.ctx = null;
    this.node = null;
  }
}
