// The AudioWorklet: plays what playout.js decides. Packets arrive as messages, from the main thread (node.port) or
// straight from the decode worker (a MessagePort handed over with 'port'):
//   {type: 'pcm', seq, timeUs, codec, left, right, trim}   decoded floats (Opus; trim: frames a fresh decoder dropped)
//   {type: 'pcm24', seq, timeUs, bytes}               24-bit PCM, decoded here
//   {type: 'silence', seq, timeUs}                    480 zeros
//   {type: 'config', priority}, {type: 'flush'} (and the old 'gap')
// The decode worker's packets wait until {type: 'route'} comes from the main thread: everything the main thread sent
// before it plays first, so switching a live stream over keeps the order.
// About every 0.5 s it posts {type: 'stats', stats} to the main thread.
// worklet-bundle.js is this file and playout.js in one, for worklets that can't import modules (Safari 14,
// Firefox before 113): after editing either, regenerate it (UPDATE_AUDIO_BUNDLE=1 node --test tests/audio-player.test.mjs).
import { Playout, decodePcm24 } from './playout.js';

class HeadroomPcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.test = !!o.test;
    this.make(!!o.priority);
    this.scratchL = new Float32Array(2048);
    this.scratchR = new Float32Array(2048);
    this.statsEvery = Math.round(sampleRate / 2);
    this.since = 0;
    this.routed = false;
    this.early = [];
    this.port.onmessage = e => this.onMessage(e.data);
  }

  fromWorker(m) {
    if (m && m.type === 'hello') { this.port.postMessage({ type: 'hello' }); return; } // the channel works
    if (this.routed) this.onMessage(m);
    else if (this.early.length < 256) this.early.push(m);
  }

  make(priority) {
    this.playout = new Playout({ mode: priority ? 'priority' : 'standard', sampleRate, hashes: this.test });
  }

  onMessage(m) {
    if (!m) return;
    switch (m.type) {
      case 'pcm':
        this.playout.push({ seq: m.seq, timeUs: m.timeUs, codec: m.codec === undefined ? 0 : m.codec, left: m.left, right: m.right, trim: m.trim });
        break;
      case 'pcm24': {
        const bytes = new Uint8Array(m.bytes);
        const frames = Math.floor(bytes.length / 6);
        if (frames > this.scratchL.length) { this.scratchL = new Float32Array(frames); this.scratchR = new Float32Array(frames); }
        decodePcm24(bytes, this.scratchL, this.scratchR); // the playout copies them: scratch is reused
        this.playout.push({ seq: m.seq, timeUs: m.timeUs, codec: 1, left: this.scratchL.subarray(0, frames), right: this.scratchR.subarray(0, frames) });
        break;
      }
      case 'silence':
        this.playout.push({ seq: m.seq, timeUs: m.timeUs, codec: 2 });
        break;
      case 'config':
        if (!!m.priority !== this.playout.priority) this.make(!!m.priority);
        break;
      case 'flush':
      case 'gap':
        this.playout.flush();
        break;
      case 'port': // a decode worker's channel: its packets come straight here ...
        m.port.onmessage = e => this.fromWorker(e.data);
        break;
      case 'route': // ... from now on
        this.routed = true;
        for (const x of this.early.splice(0)) this.onMessage(x);
        break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    this.playout.render(out[0], out[1]);
    this.since += out[0].length;
    if (this.since >= this.statsEvery) {
      this.since = 0;
      this.port.postMessage({ type: 'stats', stats: this.playout.stats() });
    }
    return true;
  }
}

registerProcessor('headroom-pcm', HeadroomPcm);
