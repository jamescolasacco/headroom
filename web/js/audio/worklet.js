// Jitter-buffered PCM playback. Keeps ~40 ms buffered; on underrun outputs silence and re-buffers;
// if latency creeps past ~150 ms (clock drift, network burst) it drops the excess to stay real-time.
const TARGET = 48000 * 0.04;
const MAX = 48000 * 0.15;
const CAP = 48000 * 2;

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = new Float32Array(CAP);
    this.r = new Float32Array(CAP);
    this.read = 0;
    this.write = 0;
    this.buffering = true;
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'pcm') this.push(m.left, m.right);
      else if (m.type === 'flush' || m.type === 'gap') { this.read = this.write; this.buffering = true; }
    };
  }

  get size() { return this.write - this.read; }

  push(left, right) {
    for (let i = 0; i < left.length; i++) {
      const idx = (this.write + i) % CAP;
      this.l[idx] = left[i];
      this.r[idx] = right[i];
    }
    this.write += left.length;
    if (this.size > MAX) this.read = this.write - TARGET; // catch up
    if (this.buffering && this.size >= TARGET) this.buffering = false;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (this.buffering || this.size < n) {
      this.buffering = true;
      out[0].fill(0);
      if (out[1]) out[1].fill(0);
      return true;
    }
    for (let i = 0; i < n; i++) {
      const idx = (this.read + i) % CAP;
      out[0][i] = this.l[idx];
      if (out[1]) out[1][i] = this.r[idx];
    }
    this.read += n;
    return true;
  }
}

registerProcessor('headroom-pcm', PcmPlayer);
