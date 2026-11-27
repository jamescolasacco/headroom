// GENERATED from playout.js + worklet.js (UPDATE_AUDIO_BUNDLE=1 node --test tests/audio-player.test.mjs): edit those.
// For AudioWorklets that can't import modules: Safari 14 (runs worklet scripts as classic scripts) and Firefox
// before 113. player.js loads it only when worklet.js fails to load or to register.
(function () {
'use strict';
// What the speaker plays: decoded 10 ms packets in, one render quantum out at a time. A pure module with no
// dependencies: the AudioWorklet runs it, and tools/audio-check.mjs runs the same file in Node, so what the lab
// measures is exactly what plays. (worklet-bundle.js is a generated copy for worklets that can't import modules.)
//
// 'standard' (audio priority off): exactly the old worklet. About 40 ms buffered; when it runs dry, silence until
//   40 ms is back; past 150 ms the excess is dropped; a gap in the sequence numbers flushes everything.
//
// 'priority': a steady buffer that rides out the network and both clocks without touching the sound.
//   - Lateness is measured, not guessed: each packet's arrival on the output clock against its place on the host's
//     timeline (seq x 480 frames). The buffer keeps a reserve ahead of the latest packet seen in the last 3 minutes:
//     20 ms, plus a quarter of the jitter seen (at most 40 ms more), plus 10 ms per recent underrun (falling 1 ms per
//     10 s). Until the network has proven itself the reserve is 110 ms, fading out over 30 s. And never less than
//     120 ms ahead of an on-time packet (the floor): the WebSocket lives on the main thread, which a phone stalls for
//     ~100 ms on sheets, scrolling and GC; jitter already buffered counts toward the floor, so it doesn't stack.
//     Lateness over 750 ms stops counting once it is a couple of seconds old (one dropout beats seconds of delay);
//     lateness in the start-up seconds after a start, reset or codec switch (a keyframe flooding the link: at least
//     3 s, until 2 s after the last packet 50 ms late, within 10 s) stops counting 1 s later, with the underruns'
//     extra reserve; lateness that keeps coming past 10 s is how this network is, and is remembered.
//   - The buffer moves only by dropping or adding samples inside digital silence (silence packets, which are 480
//     zeros, or frames of exact zeros), never inside sound. Silences shorter than 20 ms are left alone; corrections
//     are proportional to the error (1/16 to 16 extra frames per silent frame dropped, up to 4 added).
//   - Clock drift (host vs output) comes from the arrivals (a robust line through each second's earliest arrival,
//     over up to 5 minutes) and is re-centred in silence. Sound that never pauses lets the buffer drift within a wide
//     band: only when the reserve over the latest packet falls under 10 ms, or drift has piled up 60 ms over target,
//     does a slow resampler correct it (a 64-tap Kaiser-windowed sinc, >= 104 dB SNR to 20 kHz; the drift plus
//     1000 ppm, at most 1500 ppm: < 3 cents) to 15 ms over target, then hand back to bit-exact at a whole-sample
//     crossing. It answers drift only: a target the network moved waits for silence. Its time is counted (about 6%
//     of continuous music at ±80 ppm).
//   - An underrun (the reserve was wrong) fades out over 4 ms (a mirrored continuation of what played), waits until
//     the reserve is back and the fade is done, then fades in; the late packet raises the target for 3 minutes.
//   - Missing packets (a seq gap) keep their place on the timeline: faded out, silence, faded in. A big backlog is
//     dropped in silence; only one over 1 s with no silence queued is skipped (crossfaded). A step down from lossless
//     to Opus (the link couldn't carry it) sheds what the overload taught and re-bases as the backlog drains. A fresh
//     Opus decoder's first 120 frames (the hosts' lookahead) are dropped before they get here (feed.js, priority only),
//     so a switch from lossless joins seamlessly; after that the lookahead is a constant offset in what plays.

const RATE = 48000;            // the stream's sample rate
const FRAMES_PER_PACKET = 480; // seq advances by one per 10 ms frame

/** Priority-mode tunables (ms unless named otherwise); any of them can be passed to the constructor. */
const PLAYOUT_DEFAULTS = Object.freeze({
  floorMs: 120,           // never less buffered than this ahead of an on-time packet: bridges ~100 ms main-thread stalls
  startMs: 110,           // reserve before the network has proven anything ...
  proveMs: 30000,         // ... fading to nothing over this long
  guardMs: 20,            // reserve kept ahead of the latest packet within memory
  jitterMargin: 0.25,     // + this share of the jitter span seen ...
  jitterMarginMaxMs: 40,  // ... at most this much
  maxJitterMs: 750,       // lateness beyond this isn't buffered for once it's more than a couple of seconds old
  memoryMs: 180000,       // how long a late packet keeps the buffer up, except in the start-up seconds after a start,
                          // reset or codec switch (a keyframe flooding the link), which last ...
  startupMs: 3000,        // ... at least this long, ...
  startupSteadyMs: 2000,  // ... and until this long after the last packet ...
  startupLateMs: 50,      // ... this late (over the earliest), ...
  startupMaxMs: 10000,    // ... within this long (lateness that keeps coming after that is the network's: remembered);
  startupMemoryMs: 1000,  // their lateness (and their underruns' extra reserve) stops counting this long after them
  penaltyMs: 10,          // extra reserve per underrun ...
  penaltyMaxMs: 60,       // ... at most, ...
  penaltyDecayMs: 10000,  // ... falling 1 ms per this long
  minSilenceMs: 20,       // silences shorter than this are never adjusted
  adjustStartMs: 2,       // start adjusting when the buffer is this far off target ...
  adjustStopMs: 0.5,      // ... until it is this close
  adjustScaleMs: 50,      // correction rate = error / this (extra frames per silent frame)
  minRate: 1 / 16,
  maxDropRate: 16,
  maxInsertRate: 4,
  // Sound that never pauses lets the buffer drift (the clocks differ) within a wide band before anything is touched:
  minSlackMs: 10,         // in sound, resample when the reserve over the latest packet seen falls under this ...
  bandLowMs: 8,           // ... (or the buffer is this far under target, if that's lower), ...
  bandHighMs: 60,         // ... or drift has piled up this much over target;
  restMs: 15,             // then correct at a steady rate to this far over target, ...
  maxCorrectionPpm: 1000, // ... this much on top of the drift (1000 ppm: 1.7 cents), ...
  maxRatioPpm: 1500,      // ... never further off than this, ...
  ratioSlewPpm: 10,       // ... changing at most this much per render quantum, ...
  returnPpm: 200,         // ... and hand back to bit-exact at the next whole-sample crossing, this close to 1
  hardSkipMs: 1000,       // a backlog this far over target with no silence at hand is skipped
  fadeMs: 4,              // fade out/in around an underrun, a lost stretch or a skip
  maxGapMs: 1000,         // a seq gap up to this long keeps its place on the timeline
  resetMs: 60,            // a packet this much earlier than any before resets the timing (the output clock stood still)
  quietLevel: 1e-5,       // running dry after sound quieter than this isn't an audible dropout
  capacityFrames: 1 << 18, // 5.4 s of queue
  driftBinMs: 1000,
  driftBins: 300,
  driftMinBins: 20,
  maxDriftPpm: 1000,
});

const SOUND = 0, SILENCE = 1, MISSING = 2;
const BUFFERING = 0, PLAYING = 1;

// The old worklet's numbers (standard mode).
const STD_TARGET = 48000 * 0.04, STD_MAX = 48000 * 0.15, STD_CAP = 48000 * 2;

// The resampler's kernel covers input frames rd - HALF + 1 ... rd + HALF.
const HALF = 32, TAPS = 2 * HALF, PHASES = 512, BETA = 10;
const HIST = 256; // output frames remembered for the fade-out continuation (more than a fade)

/**
 * Signed 24-bit little-endian interleaved stereo -> left/right floats (value = int24 / 8388608, exact in float32).
 * Pass `left`/`right` to decode into existing arrays (only the first `frames` are written).
 */
function decodePcm24(bytes, left, right) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const frames = Math.floor(src.length / 6);
  if (!left || left.length < frames) left = new Float32Array(frames);
  if (!right || right.length < frames) right = new Float32Array(frames);
  for (let i = 0, o = 0; i < frames; i++, o += 6) {
    left[i] = (((src[o] | (src[o + 1] << 8) | (src[o + 2] << 16)) << 8) >> 8) / 8388608;
    right[i] = (((src[o + 3] | (src[o + 4] << 8) | (src[o + 5] << 16)) << 8) >> 8) / 8388608;
  }
  return { left, right, frames };
}

// FNV-1a over the float32 bit patterns of a frame (the test hashes).
const F32 = new Float32Array(2), U32 = new Uint32Array(F32.buffer);
const HASH_START = 2166136261;
function hashFrame(h, l, r) {
  F32[0] = l; F32[1] = r;
  h = Math.imul(h ^ U32[0], 16777619) >>> 0;
  return Math.imul(h ^ U32[1], 16777619) >>> 0;
}

function besselI0(x) {
  let sum = 1, term = 1;
  const q = x * x / 4;
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

let sharedTable = null;
/** TAPS coefficients for each of PHASES + 1 fractional positions; row 0 is exactly the sample itself. */
function sincTable() {
  if (sharedTable) return sharedTable;
  const t = new Float64Array((PHASES + 1) * TAPS), ib = besselI0(BETA), row = new Float64Array(TAPS); // float64: DC stays exact
  for (let p = 0; p <= PHASES; p++) {
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const x = j - (HALF - 1) - p / PHASES;
      let v = 0;
      if (Math.abs(x) < HALF) {
        if (Number.isInteger(x)) v = x === 0 ? 1 : 0;
        else {
          const r = x / HALF;
          v = Math.sin(Math.PI * x) / (Math.PI * x) * besselI0(BETA * Math.sqrt(1 - r * r)) / ib;
        }
      }
      row[j] = v;
      sum += v;
    }
    for (let j = 0; j < TAPS; j++) t[p * TAPS + j] = row[j] / sum; // unity gain at every phase
  }
  return (sharedTable = t);
}

/** Arrival statistics: lateness per second of host time, its extremes over the memory, and the clock drift. */
class Arrivals {
  constructor(o) {
    this.binFrames = Math.round(o.driftBinMs * RATE / 1000);
    this.memoryBins = Math.max(1, Math.round(o.memoryMs / o.driftBinMs));
    const f = ms => Math.round(ms * RATE / 1000);
    this.startupFrames = f(o.startupMs);
    this.startupSteadyFrames = f(o.startupSteadyMs);
    this.startupLate = f(o.startupLateMs);
    this.startupMaxFrames = f(o.startupMaxMs);
    this.startupMemoryFrames = f(o.startupMemoryMs);
    this.driftBins = o.driftBins;
    this.keepBins = Math.max(this.memoryBins, o.driftBins);
    this.driftMinBins = o.driftMinBins;
    this.maxDrift = o.maxDriftPpm * 1e-6;
    this.scratch = new Float64Array(this.keepBins);
    this.eps = 0; // host frames per output frame - 1 (+: the host's clock is faster)
    this.reset();
  }

  reset() {
    this.bins = [];
    this.cur = null;
    this.startupStart = null; // host positions where the start-up seconds begin (the first packet) ...
    this.startupUntil = null; // ... and end (-Infinity: none, the lateness persisted)
    this.startupDone = false; // their lateness no longer counts (or never will be forgotten)
    this.maxT = -Infinity;
    this.minT = Infinity;
    this.avgT = 0;
    this.count = 0;
  }

  /** One packet: host position x (frames), lateness d = arrival - x (frames). */
  add(x, d) {
    if (this.startupStart === null) { this.startupStart = x; this.startupUntil = x + this.startupFrames; }
    if (!this.startupDone) {
      if (this.count && d + this.eps * x - this.minT > this.startupLate) { // a late packet ...
        if (x < this.startupStart + this.startupMaxFrames) { // ... keeps the start-up going a little longer
          this.startupUntil = Math.min(Math.max(this.startupUntil, x + this.startupSteadyFrames), this.startupStart + this.startupMaxFrames);
        } else { // ... or, coming on and on, is just how this network is: nothing is forgotten
          this.startupUntil = -Infinity;
          this.startupDone = true;
        }
      } else if (x >= this.startupUntil + this.startupMemoryFrames) {
        this.startupDone = true; // steady for a while: the start-up's lateness goes
        this._extremes();
      }
    }
    const k = Math.floor(x / this.binFrames);
    let c = this.cur;
    if (!c || k > c.k) {
      if (c) this._close(c);
      c = this.cur = { k, minD: d, minX: x, maxD: d, maxX: x };
    }
    if (d < c.minD) { c.minD = d; c.minX = x; }
    if (d > c.maxD) { c.maxD = d; c.maxX = x; }
    const t = d + this.eps * x;
    if (t > this.maxT) this.maxT = t;
    if (t < this.minT) this.minT = t;
    this.avgT = this.count ? this.avgT + (t - this.avgT) / Math.min(this.count + 1, 200) : t;
    this.count++;
  }

  /** The bin is in the start-up seconds. */
  _startup(bin) { return this.startupUntil !== null && bin.k * this.binFrames < this.startupUntil; }

  /** Host position x is in the start-up seconds (still counting). */
  inStartup(x) { return !this.startupDone && this.startupUntil !== null && x < this.startupUntil; }

  /** Lateness without the drift: comparable across the whole memory. */
  detrend(x, d) { return d + this.eps * x; }

  /** The latest arrival of the last second or two: what the network is doing now (never capped). */
  recentT() {
    const e = this.eps, c = this.cur, b = this.bins[this.bins.length - 1];
    let t = c ? c.maxD + e * c.maxX : -Infinity;
    if (b && c && b.k === c.k - 1) t = Math.max(t, b.maxD + e * b.maxX);
    return t;
  }

  _close(c) {
    this.bins.push(c);
    if (this.bins.length > this.keepBins) this.bins.shift();
    this._fitDrift();
    this._extremes();
  }

  _extremes() {
    let maxT = -Infinity, minT = Infinity;
    const e = this.eps, b = this.bins;
    // Start-up lateness counts until the stream has been steady for a while after it.
    const forget = this.startupDone && this.startupUntil !== null;
    for (let i = Math.max(0, b.length - this.memoryBins); i < b.length; i++) {
      if (!forget || !this._startup(b[i])) maxT = Math.max(maxT, b[i].maxD + e * b[i].maxX);
      minT = Math.min(minT, b[i].minD + e * b[i].minX);
    }
    const c = this.cur;
    if (c) {
      maxT = Math.max(maxT, c.maxD + e * c.maxX);
      minT = Math.min(minT, c.minD + e * c.minX);
    }
    this.maxT = maxT;
    this.minT = minT;
  }

  /** Drift: a line through each second's earliest arrival (queueing only ever adds delay), outliers dropped. */
  _fitDrift() {
    const b = this.bins, n = Math.min(b.length, this.driftBins);
    if (n < this.driftMinBins) return;
    const from = b.length - n;
    if (b[b.length - 1].minX - b[from].minX < this.driftMinBins * this.binFrames) return;
    const fit = keep => {
      let m = 0, sx = 0, sy = 0;
      for (let i = from; i < b.length; i++) if (keep(i)) { sx += b[i].minX; sy += b[i].minD; m++; }
      if (m < this.driftMinBins) return null;
      const mx = sx / m, my = sy / m;
      let sxx = 0, sxy = 0;
      for (let i = from; i < b.length; i++) {
        if (!keep(i)) continue;
        const dx = b[i].minX - mx;
        sxx += dx * dx;
        sxy += dx * (b[i].minD - my);
      }
      return sxx > 0 ? { slope: sxy / sxx, mx, my } : null;
    };
    const first = fit(i => !this._startup(b[i]));
    if (!first) return;
    const res = i => b[i].minD - first.my - first.slope * (b[i].minX - first.mx);
    const abs = this.scratch.subarray(0, n);
    let m = 0;
    for (let i = from; i < b.length; i++) if (!this._startup(b[i])) abs[m++] = Math.abs(res(i));
    const sorted = abs.subarray(0, m).sort();
    const limit = 3 * sorted[m >> 1] + 24; // + half a millisecond
    const best = fit(i => !this._startup(b[i]) && Math.abs(res(i)) <= limit) || first;
    this.eps = Math.max(-this.maxDrift, Math.min(this.maxDrift, -best.slope));
  }
}

class Playout {
  /**
   * @param {object} [o]
   * @param {number} [o.sampleRate=48000] the output's rate (frames rendered per second)
   * @param {'priority'|'standard'} [o.mode] (or `priority: true`)
   * @param {boolean} [o.hashes] keep the test hashes (stats().hashes)
   * @param {(event: object) => void} [o.trace] told of every underrun ('underrun', then 'conceal' with its length),
   *   'drop'/'insert' of silence, 'resample-start'/'resample-stop', 'skip', 'lost', 'late', 'jump', 'reset' and
   *   'start', with positions `out` (output frame) and `host` (the stream's frame: seq x 480 + offset)
   * plus any of PLAYOUT_DEFAULTS.
   */
  constructor(o = {}) {
    this.priority = o.mode ? o.mode === 'priority' : !!o.priority;
    this.outRate = o.sampleRate || RATE;
    this.trace = typeof o.trace === 'function' ? o.trace : null;
    this.hashes = !!o.hashes;
    const t = {};
    for (const k of Object.keys(PLAYOUT_DEFAULTS)) t[k] = o[k] ?? PLAYOUT_DEFAULTS[k];
    this.opts = t;
    this.packets = 0;
    this.codec = null;
    this.outPos = 0;
    this.t = 0;
    this.h = { rx: HASH_START, rxFrames: 0, consumed: HASH_START, consumedFrames: 0, played: HASH_START, playedFrames: 0, output: HASH_START, outputFrames: 0 };
    if (this.priority) this._initPriority(); else this._initStandard();
  }

  get mode() { return this.priority ? 'priority' : 'standard'; }

  /** Frames rendered so far: the output clock. */
  get outFrames() { return this.outPos; }

  /** Frames queued, not yet played. */
  get bufferedFrames() {
    return this.priority ? Math.max(0, this.wr - this.rd - this.frac) : this.swrite - this.sread;
  }

  /**
   * One packet, already decoded: { seq, timeUs, kind: 'pcm' | 'silence' (or codec: 0 Opus | 1 PCM | 2 silence),
   * left, right (Float32Array; or `bytes` of 24-bit PCM), arrival (the output frame it arrived at; default: now),
   * trim (frames dropped from the start of its 10 ms: a fresh Opus decoder's lookahead) }.
   */
  push(p) {
    this.packets++;
    const silence = p.kind === 'silence' || p.codec === 2 || p.codec === 'silence';
    let left = p.left, right = p.right;
    if (!silence && !left && p.bytes) ({ left, right } = decodePcm24(p.bytes));
    if (!silence && !left) return;
    if (!silence && !right) right = left;
    const frames = silence ? FRAMES_PER_PACKET : Math.min(left.length, right.length); // a silence packet is 480 zeros
    if (!frames && !(p.trim > 0)) return;
    if (!silence) {
      if (p.codec === 1 || p.codec === 'pcm') this.codec = 'pcm';
      else if (p.codec === 0 || p.codec === 'opus') this.codec = 'opus';
    }
    if (this.hashes && !silence) {
      let h = this.h.rx, c = 0;
      for (let i = 0; i < frames; i++) if (left[i] !== 0 || right[i] !== 0) { h = hashFrame(h, left[i], right[i]); c++; }
      this.h.rx = h;
      this.h.rxFrames += c;
    }
    if (this.priority) this._pushPriority(p, silence, frames, left, right);
    else if (frames) this._pushStandard(p, silence, frames, left, right);
  }

  /** Fills one render quantum (outR may be missing: mono). */
  render(outL, outR) {
    const n = outL.length;
    if (!outR) outR = this.monoR && this.monoR.length === n ? this.monoR : (this.monoR = new Float32Array(n));
    if (this.priority) this._renderPriority(outL, outR, n); else this._renderStandard(outL, outR, n);
    this.outPos += n;
    this.t = this.outPos;
    if (this.hashes) {
      const h = this.h;
      for (let i = 0; i < n; i++) {
        const l = outL[i], r = outR[i];
        h.output = hashFrame(h.output, l, r);
        if (l !== 0 || r !== 0) { h.played = hashFrame(h.played, l, r); h.playedFrames++; }
      }
      h.outputFrames += n;
    }
  }

  /** Back to empty (muted), as the old worklet's flush. */
  flush() {
    if (this.priority) this._initPriority();
    else { this.sread = this.swrite; this.sbuffering = true; this.flushes++; }
  }

  stats() {
    const ms = f => Math.round(f * 10000 / RATE) / 10;
    const s = this.priority ? this._statsPriority(ms) : {
      mode: 'standard', playing: !this.sbuffering, codec: this.codec, packets: this.packets,
      bufferedMs: ms(this.swrite - this.sread), targetMs: 40, underruns: this.underruns, concealedMs: 0,
      droppedMs: ms(this.dropped), insertedMs: 0, skippedMs: 0, resampledMs: 0, driftPpm: null, flushes: this.flushes,
    };
    if (this.hashes) s.hashes = { ...this.h };
    return s;
  }

  // ======================================================================================== standard (the old worklet)

  _initStandard() {
    this.sl = new Float32Array(STD_CAP);
    this.sr = new Float32Array(STD_CAP);
    this.sread = 0;
    this.swrite = 0;
    this.sbuffering = true;
    this.slastSeq = 0;
    this.splayed = false;
    this.underruns = 0;
    this.dropped = 0;
    this.flushes = 0;
  }

  _pushStandard(p, silence, frames, left, right) {
    // As the old player did: a seq that isn't the next one (the host sends nothing in silence) re-buffers.
    if (typeof p.seq === 'number') {
      if (p.seq !== this.slastSeq + 1 && this.slastSeq !== 0) { this.sread = this.swrite; this.sbuffering = true; this.flushes++; }
      this.slastSeq = p.seq;
    }
    for (let i = 0; i < frames; i++) {
      const idx = (this.swrite + i) % STD_CAP;
      this.sl[idx] = silence ? 0 : left[i];
      this.sr[idx] = silence ? 0 : right[i];
    }
    this.swrite += frames;
    if (this.swrite - this.sread > STD_MAX) { this.dropped += this.swrite - this.sread - STD_TARGET; this.sread = this.swrite - STD_TARGET; }
    if (this.sbuffering && this.swrite - this.sread >= STD_TARGET) this.sbuffering = false;
  }

  _renderStandard(outL, outR, n) {
    if (this.sbuffering || this.swrite - this.sread < n) {
      if (!this.sbuffering && this.splayed) this.underruns++;
      this.sbuffering = true;
      outL.fill(0);
      outR.fill(0);
      return;
    }
    for (let i = 0; i < n; i++) {
      const idx = (this.sread + i) % STD_CAP;
      outL[i] = this.sl[idx];
      outR[i] = this.sr[idx];
    }
    this.sread += n;
    this.splayed = true;
  }

  // ======================================================================================== priority

  _initPriority() {
    const o = this.opts, f = ms => Math.round(ms * RATE / 1000);
    this.rr = RATE / this.outRate;                 // stream frames per output frame (1 at 48 kHz)
    this.cap = 2 ** Math.ceil(Math.log2(Math.max(o.capacityFrames, 4 * RATE)));
    this.mask = this.cap - 1;
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.wr = 0; this.rd = 0; this.frac = 0;       // absolute frame indices into the ring
    this.segs = []; this.head = 0;                  // {start, end, hp, kind, seq, quiet, jump, entered}
    this.state = BUFFERING;
    this.started = false;
    this.lastKind = SILENCE; this.lastQuiet = true;
    this.interrupted = false;                       // sound was cut: what comes next fades in (if it's sound)
    this.concealing = false; this.episode = 0;      // in an underrun that cut sound, and how long it has lasted
    this.runStart = 0;                              // where the current silent run began (ring index)
    this.contiguous = 0;                            // ring index the audio runs on unbroken from (resampler history)
    this.adjusting = false; this.credit = 0;
    this.rs = false; this.ratioDev = 0; this.rsSince = 0; // the slow resampler: on, its step off 1, its frames
    this.rsGoal = 0; this.rsReturning = false;      // +1 filling the buffer, -1 draining it; done: handing back
    this.F = Math.max(8, f(o.fadeMs));
    this.wOut = new Float32Array(this.F);
    this.wIn = new Float32Array(this.F);
    for (let i = 0; i < this.F; i++) {
      this.wOut[i] = 0.5 + 0.5 * Math.cos(Math.PI * (i + 1) / (this.F + 1));
      this.wIn[i] = 1 - this.wOut[i];
    }
    this.contL = new Float32Array(this.F); this.contR = new Float32Array(this.F); this.contPos = this.F;
    this.fadeInPos = this.F;
    this.histL = new Float32Array(HIST); this.histR = new Float32Array(HIST); this.histPos = 0;
    this.lastIdx = null; this.lastSeq = 0; this.lastArrival = null; this.lastSoundCodec = null; this.rebaseUntil = -Infinity;
    this.newestHp = -Infinity;
    this.arrivals = new Arrivals(o);
    this.anchorT = null;
    this.penalty = 0;
    this.startupPenalty = 0;
    this.lastUnderrun = -Infinity;
    this.c = { // in frames
      floor: f(o.floorMs), start: f(o.startMs), guard: f(o.guardMs), marginMax: f(o.jitterMarginMaxMs), maxJitter: f(o.maxJitterMs), prove: f(o.proveMs),
      penalty: f(o.penaltyMs), penaltyMax: f(o.penaltyMaxMs), penaltyDecay: 1 / o.penaltyDecayMs,
      minSilence: f(o.minSilenceMs), adjustStart: f(o.adjustStartMs), adjustStop: f(o.adjustStopMs), adjustScale: f(o.adjustScaleMs),
      minSlack: f(o.minSlackMs), bandLow: f(o.bandLowMs), bandHigh: f(o.bandHighMs), rest: f(o.restMs),
      maxCorr: o.maxCorrectionPpm * 1e-6, maxDev: o.maxRatioPpm * 1e-6, slew: o.ratioSlewPpm * 1e-6, returnDev: o.returnPpm * 1e-6,
      hardSkip: f(o.hardSkipMs), maxGap: Math.round(o.maxGapMs / 10), reset: f(o.resetMs), rebase: f(5),
    };
    this.geff = Math.max(this.c.start, this.c.floor);
    this.dmax = 0; this.dnow = 0;
    this.excess = -Infinity;
    this.geffRun = 0; this.dmaxRun = 0;              // the target when the buffer was last on it
    // counters (frames unless named)
    this.underruns = 0; this.concealed = 0; this.dropped = 0; this.inserted = 0; this.skipped = 0; this.skips = 0;
    this.resampled = 0; this.resamples = 0; this.lost = 0; this.late = 0; this.jumps = 0; this.resets = 0;
  }

  _event(type, extra) {
    if (!this.trace) return;
    const e = { type, out: this.t, host: this._hostAt(this.rd) };
    if (extra) Object.assign(e, extra);
    this.trace(e);
  }

  /** The stream position (seq x 480 + offset) of ring index i. */
  _hostAt(i) {
    for (let k = this.head; k < this.segs.length; k++) {
      const s = this.segs[k];
      if (i < s.end) return s.hp + Math.max(0, i - s.start);
    }
    const last = this.segs[this.segs.length - 1];
    return last ? last.hp + (last.end - last.start) : 0;
  }

  _pushPriority(p, silence, frames, left, right) {
    const now = (p.arrival ?? this.outPos) * this.rr;
    // The packet's place on the host's timeline.
    const seq = typeof p.seq === 'number' ? p.seq >>> 0 : (this.lastSeq + 1) >>> 0;
    let idx, gap = 0, jump = false;
    if (this.lastIdx === null) idx = seq;
    else {
      const delta = (seq - this.lastSeq) | 0;
      if (delta <= 0 && delta > -3000) { // a duplicate or a straggler: its moment has passed
        this.late++;
        this._event('late', { seq });
        return;
      }
      if (delta <= 0 || delta > 6000) { // the stream started again: the timeline goes on from where it ends
        idx = this._endIdx();
        jump = this.wr > this.rd;
        this.jumps++;
        this.arrivals.reset();
        this.anchorT = now;
        this._event('jump', { seq });
      } else {
        idx = this.lastIdx + delta;
        gap = delta - 1;
      }
    }
    this.lastSeq = seq;
    this.lastIdx = idx;
    const hp = idx * FRAMES_PER_PACKET;
    if (gap > 0) {
      this.lost += gap;
      if (gap <= this.c.maxGap && this.wr > this.rd) {
        // Missing ahead of what plays: keep its place (concealed when it plays).
        this._append(MISSING, hp - gap * FRAMES_PER_PACKET, gap * FRAMES_PER_PACKET, null, null, false, seq - gap, false);
        this._event('lost', { seq: seq - gap, frames: gap * FRAMES_PER_PACKET });
      } else {
        // Nothing queued to keep a place behind, or too long to keep: playback goes straight on (crossfaded).
        jump = this.wr > this.rd;
        this._event('lost', { seq: seq - gap, frames: gap * FRAMES_PER_PACKET, kept: false });
      }
    }
    // A step down from lossless to Opus means the link couldn't carry lossless: the lateness learned meanwhile was
    // overload, not jitter, so it goes (with the underruns' extra reserve), and the drain that follows re-bases it.
    const a0 = this.arrivals;
    if (!silence) {
      const opus = p.codec === 0 || p.codec === 'opus', pcm = p.codec === 1 || p.codec === 'pcm';
      if (opus && this.lastSoundCodec === 'pcm' && a0.count) {
        a0.reset();
        this.anchorT = now;
        this.penalty = 0;
        this.startupPenalty = 0;
        this.resets++;
        this.rebaseUntil = now + 3 * RATE; // re-base on every new earliest arrival while the backlog drains
        this.dmaxRun = Math.max(this.dmaxRun, this.dmax); this.geffRun = Math.max(this.geffRun, this.geff);
        this._event('reset', { seq, codec: 'opus' });
      }
      if (opus) this.lastSoundCodec = 'opus'; else if (pcm) this.lastSoundCodec = 'pcm';
    }
    // Timing. Packets arriving at the same output instant, earlier than any before, say nothing about the network:
    // the output clock is standing still (a suspended context) while they pile up. The first packet after it moves
    // again is far earlier than anything before (as it is when the path got much faster): what was learned no longer
    // applies, so it starts again from there.
    const d = now - hp, a = this.arrivals, t = a.detrend(hp, d);
    const frozen = now === this.lastArrival && t < a.minT;
    this.lastArrival = now;
    const draining = now < this.rebaseUntil;
    if (a.count && !frozen && t < a.minT - (draining ? this.c.rebase : this.c.reset)) {
      a.reset();
      this.anchorT = now;
      this.resets++;
      if (draining) this.rebaseUntil = Math.max(this.rebaseUntil, now + RATE);
      this.dmaxRun = Math.max(this.dmaxRun, this.dmax); this.geffRun = Math.max(this.geffRun, this.geff); // a backlog it reveals waits for silence
      this._event('reset', { seq });
    }
    if (this.anchorT === null) this.anchorT = now;
    if (!frozen) a.add(hp, d);
    if (hp > this.newestHp) this.newestHp = hp;
    if (!frames) return; // all of it was a decoder's lookahead
    let kind = SILENCE, quiet = true;
    if (!silence) {
      let peak = 0;
      for (let i = 0; i < frames; i++) {
        const l = Math.abs(left[i]), r = Math.abs(right[i]);
        if (l > peak) peak = l;
        if (r > peak) peak = r;
      }
      if (peak > 0) { kind = SOUND; quiet = peak < this.opts.quietLevel; }
    }
    // What a fresh Opus decoder dropped (its lookahead) was the start of this 10 ms: the rest sits after it. The
    // sound joins what played before seamlessly; the timeline is that much shorter (re-centred in silence).
    const trim = !silence && p.trim > 0 ? Math.min(p.trim, FRAMES_PER_PACKET) : 0;
    this._append(kind, hp + trim, frames, kind === SOUND ? left : null, kind === SOUND ? right : null, quiet, seq, jump);
  }

  _endIdx() {
    const last = this.segs[this.segs.length - 1];
    return last ? Math.ceil((last.hp + (last.end - last.start)) / FRAMES_PER_PACKET) : 0;
  }

  _append(kind, hp, frames, left, right, quiet, seq, jump) {
    // Room: HIST frames stay behind the read position for the fades and the resampler.
    const over = this.wr + frames - (this.rd - HIST) - this.cap;
    if (over > 0) this._discard(over);
    const start = this.wr, L = this.L, R = this.R, mask = this.mask;
    if (left) {
      for (let i = 0; i < frames; i++) {
        const j = (start + i) & mask, l = left[i], r = right[i];
        L[j] = l - l === 0 ? l : 0; // never NaN or Infinity out
        R[j] = r - r === 0 ? r : 0;
      }
    } else {
      for (let i = 0; i < frames; i++) { const j = (start + i) & mask; L[j] = 0; R[j] = 0; }
    }
    this.wr += frames;
    this.segs.push({ start, end: start + frames, hp, kind, seq, quiet, jump, entered: false });
  }

  /** The queue is full (the output stopped while packets kept coming): the oldest go. */
  _discard(n) {
    n = Math.min(n, this.wr - this.rd);
    if (n <= 0) return;
    this._seek();
    this._consumeHashes(this.rd, n);
    if (this.state === PLAYING && this.lastKind === SOUND && !this.lastQuiet) this._cut();
    this.rd += n;
    this.frac = 0;
    this.skipped += n;
    this.skips++;
    this.contiguous = this.rd;
    this._seek();
    const s = this.segs[this.head];
    if (s) s.entered = true;
    this._event('skip', { frames: n, full: true });
  }

  _consumeHashes(from, n) {
    if (!this.hashes) return;
    const h = this.h;
    let k = this.head;
    for (let i = from; i < from + n; i++) {
      while (k < this.segs.length && this.segs[k].end <= i) k++;
      if (k >= this.segs.length) break;
      if (this.segs[k].kind !== SOUND) continue;
      const j = i & this.mask, l = this.L[j], r = this.R[j];
      if (l !== 0 || r !== 0) { h.consumed = hashFrame(h.consumed, l, r); h.consumedFrames++; }
    }
  }

  /** `head` to the segment holding rd. */
  _seek() {
    const s = this.segs;
    while (this.head < s.length && s[this.head].end <= this.rd) this.head++;
    if (this.head > 512) { s.splice(0, this.head); this.head = 0; }
  }

  /** Host position of the next frame to play. */
  _p() {
    const s = this.segs[this.head];
    if (s && this.rd < s.end) return s.hp + (this.rd - s.start) + this.frac;
    const last = this.segs[this.segs.length - 1];
    return last ? last.hp + (last.end - last.start) : 0;
  }

  /** How far the buffer is over its target (frames; negative: under). */
  _recompute() {
    this.excess = Number.isFinite(this.dnow) && this.arrivals.count ? this.t * this.rr - this._p() - this.dnow - this.geff : -Infinity;
  }

  /** Per quantum: the target (the reserve ahead of the latest packet) and the resampler's step. */
  _control(n) {
    const c = this.c, a = this.arrivals;
    this.penalty = Math.max(0, this.penalty - n * this.rr * c.penaltyDecay);
    if (this.startupPenalty && a.startupDone) { // the start-up is over: forgotten (with its underruns) or kept
      if (a.startupUntil !== -Infinity) this.penalty = Math.max(0, this.penalty - this.startupPenalty);
      this.startupPenalty = 0;
    }
    this._seek();
    if (a.count) {
      const span = Math.min(c.maxJitter, Math.max(0, a.maxT - a.minT));
      const margin = Math.min(c.marginMax, this.opts.jitterMargin * span);
      const tObs = this.outPos * this.rr - this.anchorT;
      const extra = Math.max(0, c.start - c.guard - margin - span) * Math.max(0, 1 - tObs / c.prove);
      this.dmax = Math.max(a.minT + span, a.recentT()); // old lateness is capped, today's isn't
      // The reserve ahead of the latest packet, and the floor ahead of an on-time one (jitter already counts toward it).
      this.geff = Math.max(c.guard + margin + this.penalty + extra, c.floor - (this.dmax - a.minT));
      this.dnow = this.dmax - a.eps * (this.newestHp + FRAMES_PER_PACKET);
    }
    this._recompute();
    if (this.rs) {
      if (this.rr === 1 && !this.rsReturning && this._rsDone()) this.rsReturning = true;
      const want = this._wantDev();
      this.ratioDev += Math.max(-c.slew, Math.min(c.slew, want - this.ratioDev));
    }
  }

  /** Under this excess, sound is resampled to fill the buffer: the reserve over the latest packet is nearly gone. */
  _lowBand() { return Math.max(this.c.bandLow, this.geff - this.c.minSlack); }

  _renderPriority(outL, outR, n) {
    this.t = this.outPos;
    this._control(n);
    let i = 0, spins = 0;
    while (i < n) {
      if (++spins > 4 * n + 64) { outL.fill(0, i); outR.fill(0, i); break; } // never spin in the audio thread
      if (this.state === BUFFERING) {
        // Back once the reserve is there and any fade-out has finished (a fade never mixes two places in the sound).
        if (this.wr > this.rd && this.excess >= 0 && this.contPos >= this.F) { this._resume(); continue; }
        this._idle(outL, outR, i, n - i);
        i = n;
        continue;
      }
      this._seek();
      const seg = this.segs[this.head];
      if (this.rs && this.wr - this.rd <= HALF) this._stopResampling(); // too little ahead for the kernel: play it as it is
      if (!seg || this.rd >= this.wr) { this._dry(); continue; }
      if (!seg.entered && this.rd <= seg.start) { this._enter(seg); continue; }
      let k;
      if (this.rs) k = this._resampled(outL, outR, i, n - i);
      else if (seg.kind === SOUND) k = this._sound(outL, outR, i, n - i, seg);
      else k = this._silent(outL, outR, i, n - i, seg);
      if (k > 0) { this._post(outL, outR, i, k); i += k; }
    }
  }

  /** A segment starts playing: cut what played if this doesn't continue it. */
  _enter(seg) {
    seg.entered = true;
    const afterSound = this.lastKind === SOUND && !this.lastQuiet;
    if (seg.jump || seg.kind === MISSING) {
      if (afterSound) this._cut();
      if (this.rs) this._stopResampling();
      if (seg.jump) { this.contiguous = seg.start; this._recompute(); }
    }
    if (seg.kind !== SOUND && (this.lastKind === SOUND || seg.jump)) this.runStart = seg.start;
  }

  /** Sound was cut short: fade out a mirrored continuation of what just played; what comes next fades in. */
  _cut() {
    const F = this.F, m = HIST - 1;
    for (let i = 0; i < F; i++) {
      const j = (this.histPos - 1 - i) & m;
      this.contL[i] = this.histL[j] * this.wOut[i];
      this.contR[i] = this.histR[j] * this.wOut[i];
    }
    this.contPos = 0;
    this.fadeInPos = F;
    this.interrupted = true;
  }

  _stopResampling(pending = 0) {
    this.rs = false;
    this.rsReturning = false;
    this.frac = 0;
    this._event('resample-stop', { frames: this.resampled + pending - this.rsSince });
  }

  /** Ran dry while playing. */
  _dry() {
    if (this.lastKind === SOUND && !this.lastQuiet) {
      this.underruns++;
      this.lastUnderrun = this.t;
      const add = Math.min(this.c.penaltyMax, this.penalty + this.c.penalty) - this.penalty;
      this.penalty += add;
      if (this.arrivals.inStartup(this.newestHp)) this.startupPenalty += add; // given back if the start-up is forgotten
      this._cut();
      this.concealing = true;
      this.episode = 0;
      this._event('underrun');
    } else {
      this.concealing = this.interrupted;
    }
    if (this.rs) this._stopResampling();
    this.state = BUFFERING;
  }

  _resume() {
    this.state = PLAYING;
    this.geffRun = this.geff; this.dmaxRun = this.dmax; // on target now
    if (!this.started) { this.started = true; this._event('start', { buffered: this.wr - this.rd }); }
    if (this.concealing) { this._event('conceal', { frames: this.episode }); this.concealing = false; }
    this.adjusting = false;
  }

  /** Waiting for the reserve (at the start, or after running dry): zeros, under the fade-out if one runs. */
  _idle(outL, outR, i, k) {
    outL.fill(0, i, i + k);
    outR.fill(0, i, i + k);
    if (this.started) {
      if (this.concealing) { this.concealed += k; this.episode += k; }
      else { this.inserted += k; if (this.trace) this._event('insert', { frames: k, waiting: true }); }
    }
    this._post(outL, outR, i, k);
    this.excess += k * this.rr;
    this.lastKind = SILENCE;
    this.lastQuiet = true;
  }

  /** Sound, bit-exact: straight copies (faded in after a cut). */
  _sound(outL, outR, i, k, seg) {
    const c = this.c, E = this.excess;
    // A backlog over a second with no silence queued to drop it in: skip to the target (crossfaded).
    if (E > c.hardSkip && !this._silenceQueued()) {
      const n = Math.min(Math.floor(E), this.wr - this.rd - 1);
      if (n > 0) {
        this._consumeHashes(this.rd, n);
        if (!this.lastQuiet || this.lastKind !== SOUND) this._cut(); else this.interrupted = true;
        this.rd += n;
        this.skipped += n;
        this.skips++;
        this.contiguous = this.rd;
        this._seek();
        const s = this.segs[this.head];
        if (s) s.entered = true;
        this._recompute();
        this._event('skip', { frames: n });
        return 0;
      }
    }
    // Sound that ran long enough for the buffer to leave its band: the slow resampler corrects it (to `restMs` over
    // target) and hands back. Over target counts only what built up since the buffer was last on target (drift), not
    // a target that came down meanwhile (the start reserve): that waits for silence, where it costs nothing.
    // (Filling also waits 10 s after an underrun: falling that fast is the network, which 1000 ppm can't outrun.)
    const fill = this._excessDown() < -this._lowBand() && this.t - this.lastUnderrun > 10 * this.outRate;
    const goal = fill ? 1 : this._excessUp() > c.bandHigh ? -1 : this.rr !== 1 ? 1 : 0;
    if (goal && this.wr - this.rd > HALF && (this.rd - HALF + 1 >= this.contiguous || this.rr !== 1)) {
      this.rs = true;
      this.rsGoal = goal;
      this.rsReturning = false;
      this.frac = 0;
      this.ratioDev = 0;
      this.rsSince = this.resampled;
      this.resamples++;
      this._event('resample-start', { excessMs: Math.round(E / 4.8) / 10, driftPpm: Math.round(this.arrivals.eps * 1e6), goal });
      return 0;
    }
    const m = Math.min(k, seg.end - this.rd);
    const L = this.L, R = this.R, mask = this.mask;
    let j = this.rd & mask;
    for (let x = 0; x < m; x++) {
      outL[i + x] = L[j];
      outR[i + x] = R[j];
      j = (j + 1) & mask;
    }
    if (this.hashes) this._consumeHashes(this.rd, m);
    if (this.interrupted) { this.interrupted = false; this.fadeInPos = 0; }
    if (this.fadeInPos < this.F) {
      const f = Math.min(m, this.F - this.fadeInPos);
      for (let x = 0; x < f; x++) { const w = this.wIn[this.fadeInPos++]; outL[i + x] *= w; outR[i + x] *= w; }
      this.concealed += f;
    } else if (this.contPos < this.F) {
      this.concealed += Math.min(m, this.F - this.contPos);
    }
    this.rd += m;
    this.lastKind = SOUND;
    this.lastQuiet = seg.quiet;
    return m;
  }

  /** Digital silence (or a lost stretch): zeros, where the buffer may grow or shrink. */
  _silent(outL, outR, i, k, seg) {
    const c = this.c, o = this.opts;
    let runEnd = seg.end; // the silent run queued ahead
    for (let s = this.head + 1; s < this.segs.length; s++) {
      const x = this.segs[s];
      if (x.kind === SOUND || x.jump) break;
      runEnd = x.end;
    }
    const can = runEnd - this.runStart >= c.minSilence && this.contPos >= this.F;
    let dropped = 0, inserted = 0, out = 0, missing = 0, at = -1, kind = seg.kind;
    while (out < k && this.rd < runEnd) {
      const E = this.excess;
      if (!this.adjusting && Math.abs(E) > c.adjustStart) this.adjusting = true;
      else if (this.adjusting && Math.abs(E) < c.adjustStop) this.adjusting = false;
      if (Math.abs(E) <= c.adjustStop) { this.geffRun = this.geff; this.dmaxRun = this.dmax; } // on target
      kind = this.segs[this.head].kind;
      let adv = 1, ins = false;
      if (can && this.adjusting) {
        const r = Math.max(o.minRate, Math.min(Math.abs(E) / c.adjustScale, E > 0 ? o.maxDropRate : o.maxInsertRate));
        if (E > 0) {
          this.credit += r;
          const whole = Math.floor(this.credit);
          this.credit -= whole;
          const extra = Math.min(whole, runEnd - this.rd - 1, Math.max(0, Math.floor(E))); // never past the target
          if (extra > 0) { adv += extra; dropped += extra; if (at < 0 && this.trace) at = this._hostAt(this.rd + 1); }
        } else {
          this.credit += r / (1 + r);
          if (this.credit >= 1) { this.credit -= 1; ins = true; adv = 0; inserted++; if (at < 0 && this.trace) at = this._hostAt(this.rd); }
        }
      }
      if (this.rr !== 1 && !ins) { // output at another rate: silence still advances at the stream's rate
        this.frac += this.rr;
        const whole = Math.floor(this.frac);
        this.frac -= whole;
        adv += whole - 1;
      }
      outL[i + out] = 0;
      outR[i + out] = 0;
      if (kind === MISSING) missing++;
      this.rd += adv;
      this.excess += this.rr - adv;
      out++;
      while (this.rd < runEnd && this.segs[this.head].end <= this.rd) { this.head++; this.segs[this.head].entered = true; }
    }
    if (this.rd > runEnd) { this.excess += this.rd - runEnd; this.rd = runEnd; }
    this.lastKind = kind;
    this.lastQuiet = true;
    if (kind === SILENCE) this.interrupted = false; // silence came next: nothing to fade in
    this.dropped += dropped;
    this.inserted += inserted;
    this.concealed += missing;
    if (this.contPos < this.F && !missing) this.concealed += Math.min(out, this.F - this.contPos);
    if (this.trace) {
      if (dropped) this.trace({ type: 'drop', out: this.t, host: at, frames: dropped });
      if (inserted) this.trace({ type: 'insert', out: this.t, host: at, frames: inserted });
    }
    return out;
  }

  /**
   * What drift alone did: the excess against the target as it was when the buffer was last on it. The resampler
   * answers drift only; a target that moved (the network) waits for silence, where adjusting costs nothing.
   */
  _excessDrift() { return this.excess + (this.geff - this.geffRun) + (this.dmax - this.dmaxRun); }

  /** Over target, by drift (and really). */
  _excessUp() { return Math.min(this.excess, this._excessDrift()); }

  /** Under target, by drift (and really). */
  _excessDown() { return Math.max(this.excess, this._excessDrift()); }

  /** The resampler has brought the buffer to its rest point (or the other side of the band calls). */
  _rsDone() {
    const E = this.excess, c = this.c;
    if (this._excessDown() < -this._lowBand() && this.t - this.lastUnderrun > 10 * this.outRate) this.rsGoal = 1; // drifted under: fill
    return this.rsGoal > 0 ? this._excessDown() >= c.rest : this._excessUp() <= c.rest;
  }

  /** The resampler's step off 1: the drift plus a steady correction; when done, just off 1 until a sample boundary. */
  _wantDev() {
    const c = this.c;
    if (this.rsReturning) return (this.ratioDev >= 0 ? 1 : -1) * c.returnDev;
    // Steps above 1 consume faster (drain the buffer), below 1 slower (fill it); the drift alone is eps.
    return Math.max(-c.maxDev, Math.min(c.maxDev, this.arrivals.eps - this.rsGoal * c.maxCorr));
  }

  /** The slow resampler (sound ran too long to wait for silence), frame by frame. */
  _resampled(outL, outR, i, k) {
    const step = this.rr * (1 + this.ratioDev);
    const T = sincTable(), L = this.L, R = this.R, mask = this.mask;
    let out = 0;
    while (out < k) {
      if (this.wr - this.rd <= HALF) break; // runs dry: next time round
      let seg = this.segs[this.head];
      // Back to bit-exact once the whole kernel sits in silence.
      if (seg.kind !== SOUND && this.rr === 1 && this._silentAround(this.rd)) { this._stopResampling(); break; }
      const ph = this.frac * PHASES, r = Math.floor(ph), w = ph - r;
      const o0 = r * TAPS, o1 = o0 + TAPS;
      let at = (this.rd - HALF + 1) & mask, yl = 0, yr = 0;
      for (let tap = 0; tap < TAPS; tap++) {
        const a = T[o0 + tap], coef = a + w * (T[o1 + tap] - a);
        yl += coef * L[at];
        yr += coef * R[at];
        at = (at + 1) & mask;
      }
      if (this.interrupted && seg.kind === SOUND) { this.interrupted = false; this.fadeInPos = 0; }
      if (this.fadeInPos < this.F) { const g = this.wIn[this.fadeInPos++]; yl *= g; yr *= g; this.concealed++; }
      outL[i + out] = yl;
      outR[i + out] = yr;
      out++;
      // The output is "sound" while any tap still reaches sound.
      if (seg.kind === SOUND || this.rd - HALF + 1 < this.runStart) { this.lastKind = SOUND; if (seg.kind === SOUND) this.lastQuiet = seg.quiet; }
      else { this.lastKind = seg.kind; this.lastQuiet = true; }
      const before = this.frac;
      this.frac += step;
      let adv = Math.floor(this.frac);
      this.frac -= adv;
      let done = false;
      // Handing back: at the step that crosses a whole sample, the position is within returnPpm of it: snap there.
      if (this.rsReturning && Math.abs(this.ratioDev) <= this.c.returnDev * 1.01 && (step > 1 ? this.frac < before : this.frac > before)) {
        if (this.frac > 0.5) adv++;
        this.frac = 0;
        done = true;
      }
      if (adv) {
        if (this.hashes) this._consumeHashes(this.rd, adv);
        this.rd += adv;
        this._seek();
        seg = this.segs[this.head];
        if (seg && !seg.entered && this.rd >= seg.start) {
          if (seg.jump || seg.kind === MISSING) { this.excess += this.rr - step; break; } // a cut ends resampling there
          seg.entered = true;
          if (seg.kind !== SOUND && this.lastKind === SOUND) this.runStart = seg.start;
        }
      }
      this.excess += this.rr - step;
      if (done) { this._stopResampling(out); break; } // bit-exact from the next frame
    }
    this.resampled += out;
    return out;
  }

  /** A silence long enough to adjust in is queued ahead of what plays. */
  _silenceQueued() {
    let run = 0;
    for (let k = this.head + 1; k < this.segs.length; k++) {
      const x = this.segs[k];
      if (x.kind === SOUND || x.jump) { run = 0; continue; }
      run += x.end - x.start;
      if (run >= this.c.minSilence) return true;
    }
    return false;
  }

  /** Every tap of the kernel at ring index i lies in one silent run. */
  _silentAround(i) {
    if (i - HALF + 1 < this.runStart) return false;
    for (let s = this.head; s < this.segs.length; s++) {
      const x = this.segs[s];
      if (x.kind === SOUND || (x.jump && s !== this.head)) return false;
      if (x.end > i + HALF) return true;
    }
    return false;
  }

  /** After each stretch of output: the fade-out on top, and the history it is made from. */
  _post(outL, outR, i, k) {
    if (this.contPos < this.F) {
      const f = Math.min(k, this.F - this.contPos);
      for (let x = 0; x < f; x++) { outL[i + x] += this.contL[this.contPos]; outR[i + x] += this.contR[this.contPos]; this.contPos++; }
    }
    const m = HIST - 1;
    for (let x = Math.max(i, i + k - HIST); x < i + k; x++) {
      this.histL[this.histPos] = outL[x];
      this.histR[this.histPos] = outR[x];
      this.histPos = (this.histPos + 1) & m;
    }
    this.t += k;
  }

  _statsPriority(ms) {
    const a = this.arrivals;
    const target = a.count ? this.geff + Math.max(0, this.dnow + a.eps * (this.newestHp + FRAMES_PER_PACKET) - a.avgT) + FRAMES_PER_PACKET / 2
      : Math.max(this.c.start, this.c.floor) + FRAMES_PER_PACKET / 2;
    return {
      mode: 'priority',
      playing: this.state === PLAYING,
      codec: this.codec,
      packets: this.packets,
      bufferedMs: ms(Math.max(0, this.wr - this.rd - this.frac)),
      targetMs: ms(target),
      excessMs: Number.isFinite(this.excess) ? ms(this.excess) : null,
      guardMs: ms(this.geff),
      jitterMs: a.count ? ms(Math.max(0, a.maxT - a.minT)) : null,
      driftPpm: Math.round(a.eps * 1e7) / 10,
      underruns: this.underruns,
      concealedMs: ms(this.concealed),
      droppedMs: ms(this.dropped),
      insertedMs: ms(this.inserted),
      skippedMs: ms(this.skipped),
      skips: this.skips,
      resampledMs: ms(this.resampled),
      resampling: this.rs,
      ratioPpm: this.rs ? Math.round(this.ratioDev * 1e7) / 10 : 0,
      lost: this.lost,
      late: this.late,
      resets: this.resets,
    };
  }
}

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
})();
