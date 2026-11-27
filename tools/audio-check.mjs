#!/usr/bin/env node
// What a viewer of a Headroom host would hear, measured at the receiving end. Joins the host as a guest through its
// relay (like tools/stream-check.mjs, so run it on the host), with the viewer <-> relay hop going through
// tools/netem.mjs (a network profile: delay, jitter, a rate, a bottleneck buffer that pushes back, stalls). Asks for
// sound as a viewer would (mode/priority as given), acks every video frame on its last fragment like the web client,
// and records every audio packet (codec, seq, host time, size, arrival), every `audio-mode` and `stats` message and
// the video. Then plays the sound back in simulation: the packets go, at the times they arrived, into a playout
// (web/js/audio/playout.js when it exists, else a replica of today's worklet) whose output clock runs off by ±ppm
// against the host's (+80 = the device plays 80 ppm fast), and what comes out is scored.
//
//   node tools/audio-check.mjs [--url=http://127.0.0.1:17100] [--profile=lan|wifi|remote|cellular|tight|too-tight]
//        [--rate-kbps= --delay= --jitter= --jitter-period= --buf= --stall= --stall-every= --seed=] [--proxy-port=18801]
//        [--seconds=150] [--mode=pcm24|opus] [--priority=on|off] [--audio-in-start] [--max-fps=15]
//        [--signal=music|tone] [--playout=auto|today|module] [--ppm=80,-80] [--out=audio-check.json] [--label=...]
//        [--save=<prefix>] [--expect=pass] [--max-delay-p95=ms] [--playout-mode=priority|standard] [--opus-delay=frames]
//        [--opus-encoder=libopus|audiotoolbox]
//   node tools/audio-check.mjs --replay=<prefix> [--profile= --playout= --ppm= --out= --expect=]   (a saved capture again)
//   node tools/audio-check.mjs --drift [--minutes=60] [--ppm=80,-80] [--signals=continuous,music-priority] [--playout=module]
//        [--expect=pass]                                                           (clock drift alone, no host)
//
// --mode/--priority: absent = not sent at all (exactly what today's client sends). --signal: what the host plays:
// music = HEADROOM_TEST_AUDIO=music (the generator below: scored sample by sample), tone = HEADROOM_TEST_AUDIO=1 (the old
// 440 Hz tone: timing and continuity only). --save writes <prefix>.json + <prefix>.bin (every packet), for --replay.
//
// What is measured (the definitions every report uses):
// - The output is followed sample by sample. Each packet is played twice in lockstep: once with an "index signal"
//   (each sound frame carries its own frame number, silent frames stay digital zero) to see which source frame every
//   output sample is, and once with the real samples (the PCM as it arrived, or the Opus as ffmpeg's libopus decodes
//   it, like the browser's decoder: one decoder fed only the Opus packets, in order) to score what was played.
// - underrun: output that isn't the source where the next source frame is sound (silence or a concealment fade
//   while sound should play); count and total ms. dropped/inserted: source frames skipped (or played twice) and
//   extra samples, split by whether the source is sound or digital silence there (the generator knows). resampled:
//   output samples between source frames (not whole frame numbers).
// - buffer delay: when a sample plays minus when its packet arrived (one sample per 128-frame render quantum).
// - transport delay: arrival minus the packet's host time stamp, minus the smallest such difference in the run.
//   ideal playout: the least fixed delay (on the source's clock: seq x 10 ms) that catches every packet after the
//   first second, and the buffer delays it costs: no playout can do better on that path (so no criterion can ask it).
// - lossless: every non-silent sample bit-exact, on the wire (each PCM packet against the generator, aligned by the
//   first packet's seq and verified by exact match) and at the output. Opus: fidelity is scored, not just timing:
//   SNR of the decoded sound against the generator per second of sound, lined up by the encoder's own delay (libopus
//   restricted low delay, both hosts: 120 frames; --opus-delay / --opus-encoder=audiotoolbox: 312; correlation only
//   checks it), plus the bitrate per second from the packet sizes. The reference is the encoder actually in use,
//   measured the same way on the same music at the top announced rate (libopus through ffmpeg; AudioToolbox through
//   afconvert on request, with libopus beside it). Reported apart: the coding SNR (what no linear filter explains: an
//   encoder's high-pass or phase shift isn't in it) and the bass level at 20/40/60/100/220 Hz.
// - "After the first second" = from 1 s after the first sample played.
// --expect=pass (COMMON, revised after the baseline): priority + lossless/compressed — after the first second no
// underruns, nothing dropped or inserted inside sound, lossless bit-exact, buffer delay p95 <= 150 ms (lan, wifi,
// remote), 250 (tight, too-tight), 600 (cellular, which may learn its stalls: at most 2 concealed underruns, all in
// the first 45 s), video flowing, no packet lost; compressed: every second within 3 dB of its rate's median and of the
// encoder's own level; lossless on too-tight: the switch to Opus announced, nothing lost after it. --drift: continuous
// sound with no underruns and the resampler under 10% of the time; music with nothing touched inside sound.
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync, fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PROFILES, linkOptions, uplinkOptions } from './netem.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
export const RATE = 48000;
export const FRAMES = 480; // one packet: 10 ms

// ================================================================================================ the test signal
// HEADROOM_TEST_AUDIO=music (docs: COMMON-audio.md): integer math only, so the hosts and this agree bit for bit.
export const MUSIC = { cycle: 192000, sound: 144000, inc: [19685267, 157482134, 629928537], sL: 0x12345678, sR: 0x9E3779B9 };
const tri = p => { const v = p >>> 8; return (v < 0x800000 ? v : 0xFFFFFF - v) - 0x400000; };
const noise = s => (((s >>> 8) - 0x800000) | 0) >> 5;

export class MusicGen {
  constructor() { this.n = 0; this.p1 = 0; this.p2 = 0; this.p3 = 0; this.sL = MUSIC.sL; this.sR = MUSIC.sR; }

  /** The next `frames` frames as 24-bit integers, interleaved L R (written into `out` from frame `at`). */
  next(frames, out = new Int32Array(frames * 2), at = 0) {
    let { n, p1, p2, p3, sL, sR } = this;
    for (let i = 0, o = at * 2; i < frames; i++, n++, o += 2) {
      if (n % 192000 < 144000) {
        out[o] = (tri(p1) >> 2) + (tri(p2) >> 3) + (tri(p3) >> 4) + noise(sL);
        out[o + 1] = (tri((p1 + 0x40000000) >>> 0) >> 2) + (tri(p2) >> 4) + (tri((p3 + 0x80000000) >>> 0) >> 3) + noise(sR);
      } else {
        out[o] = 0;
        out[o + 1] = 0;
      }
      p1 = (p1 + 19685267) >>> 0;
      p2 = (p2 + 157482134) >>> 0;
      p3 = (p3 + 629928537) >>> 0;
      sL = (Math.imul(sL, 1664525) + 1013904223) >>> 0;
      sR = (Math.imul(sR, 1664525) + 1013904223) >>> 0;
    }
    Object.assign(this, { n, p1, p2, p3, sL, sR });
    return out;
  }
}

/** Frames [0, frames) of the music, interleaved 24-bit integers. */
export function musicFrames(frames) { return new MusicGen().next(frames); }
export const musicIsSound = n => n % 192000 < 144000;
/** How many frames in [a, b) are digital silence. */
export function musicSilentCount(a, b) {
  const f = m => Math.floor(m / 192000) * 48000 + Math.max(0, (m % 192000) - 144000);
  return b > a ? f(b) - f(a) : 0;
}

/** PCM signed 24-bit little-endian -> integers. */
export function decodePcm24(bytes, out = new Int32Array(Math.floor(bytes.length / 3))) {
  for (let i = 0, j = 0; j < out.length; i += 3, j++) out[j] = ((bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16)) << 8) >> 8;
  return out;
}

/** The `0x03` audio packet: [0x03][u8 codec][u16 rsv][u32 seq][i64 host µs][payload] (old hosts: codec byte 0). */
export function parseAudioPacket(buf) {
  const v = new DataView(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  return { codec: v.getUint8(1), seq: v.getUint32(4, true), hostUs: Number(v.getBigInt64(8, true)), payload: new Uint8Array(v.buffer, v.byteOffset + 16, v.byteLength - 16) };
}

// ================================================================================================ today's playout
/**
 * An exact replica of today's client (7522d38): web/js/audio/player.js (a seq gap posts 'gap' before the packet's
 * samples) + web/js/audio/worklet.js (ring buffer: plays once 40 ms are buffered; a render quantum it can't fill
 * outputs silence and re-buffers; past 150 ms it drops all but the newest 40 ms; 'gap' flushes everything).
 */
export class TodayPlayout {
  constructor() {
    this.TARGET = 48000 * 0.04;
    this.MAX = 48000 * 0.15;
    this.CAP = 48000 * 2;
    this.l = new Float32Array(this.CAP);
    this.r = new Float32Array(this.CAP);
    this.read = 0;
    this.write = 0;
    this.buffering = true;
    this.lastSeq = 0;
    this.c = { underruns: 0, flushes: 0, flushedFrames: 0, skips: 0, skippedFrames: 0, silentQuanta: 0 };
  }

  get size() { return this.write - this.read; }

  /** A packet's decoded samples (player.js packet() + the worklet's 'gap' and 'pcm' messages, in that order). */
  packet({ seq, left, right }) {
    if (seq !== this.lastSeq + 1 && this.lastSeq !== 0) this.gap();
    this.lastSeq = seq;
    this.push(left, right);
  }

  gap() { this.c.flushes++; this.c.flushedFrames += this.size; this.read = this.write; this.buffering = true; }

  push(left, right) {
    for (let i = 0; i < left.length; i++) {
      const idx = (this.write + i) % this.CAP;
      this.l[idx] = left[i];
      this.r[idx] = right[i];
    }
    this.write += left.length;
    if (this.size > this.MAX) { this.c.skips++; this.c.skippedFrames += this.size - this.TARGET; this.read = this.write - this.TARGET; }
    if (this.buffering && this.size >= this.TARGET) this.buffering = false;
  }

  /** One render quantum (process()). */
  render(outL, outR) {
    const n = outL.length;
    if (this.buffering || this.size < n) {
      if (!this.buffering) this.c.underruns++;
      this.buffering = true;
      this.c.silentQuanta++;
      outL.fill(0);
      outR.fill(0);
      return;
    }
    for (let i = 0; i < n; i++) {
      const idx = (this.read + i) % this.CAP;
      outL[i] = this.l[idx];
      outR[i] = this.r[idx];
    }
    this.read += n;
  }

  stats() { return { ...this.c, bufferedMs: +(this.size / 48).toFixed(1) }; }
}

// ================================================================================================ the playout under test
const PLAYOUT_JS = join(HERE, '..', 'web', 'js', 'audio', 'playout.js');

/**
 * A factory of playouts with one interface for the simulation: packet({seq, codec, timeUs, left, right, bytes}),
 * render(outL, outR), stats(). 'today' = the replica above; 'module' = web/js/audio/playout.js (the client's own).
 */
export async function playoutFactory(kind, { priority = false } = {}) {
  if (kind === 'auto') kind = existsSync(PLAYOUT_JS) ? 'module' : 'today';
  if (kind === 'today') return { kind: 'today (replica of 7522d38 worklet.js + player.js)', make: () => new TodayPlayout() };
  const mod = await import(pathToFileURL(PLAYOUT_JS).href);
  if (typeof mod.Playout !== 'function') throw new Error('web/js/audio/playout.js exports no Playout class');
  const mode = priority ? 'priority' : 'standard';
  return { kind: `web/js/audio/playout.js (${mode})`, make: () => new ModulePlayout(mod, mode) };
}

/**
 * web/js/audio/playout.js as web/js/audio/worklet.js drives it: a packet is pushed between render quanta (its arrival
 * = the output frames rendered so far, the module's default), PCM decoded by the module's own decodePcm24, Opus as
 * decoded floats, silence packets as {codec: 2, frames}. Its trace events are counted by type.
 */
class ModulePlayout {
  constructor(mod, mode) {
    this.mod = mod;
    this.events = {};
    this.rsFrom = null; // output frame the resampler (re)started at, while it runs
    this.p = new mod.Playout({
      mode, sampleRate: RATE, trace: e => {
        this.events[e.type] = (this.events[e.type] || 0) + 1;
        if (e.type === 'resample-start') this.rsFrom = e.out;
        else if (e.type === 'resample-stop') this.rsTo = e.out;
      },
    });
  }

  /** Whether output frame `out` came from the resampler (from its start event to its stop event). */
  resampledAt(out) {
    if (this.rsFrom === null) return false;
    if (this.rsTo !== undefined && this.rsTo !== null && this.rsTo >= this.rsFrom) {
      if (out >= this.rsTo) { this.rsFrom = null; this.rsTo = null; return false; }
    }
    return out >= this.rsFrom;
  }

  packet({ seq, codec, timeUs, left, right, bytes, index }) {
    if (codec === 2) this.p.push({ seq, timeUs, codec: 2, frames: FRAMES });
    else if (codec === 1 && bytes && !index) {
      // As web/js/audio/worklet.js does with a 'pcm24' message: the module's decodePcm24, then floats.
      const d = this.mod.decodePcm24(bytes);
      this.p.push({ seq, timeUs, codec: 1, left: d.left.subarray(0, d.frames), right: d.right.subarray(0, d.frames) });
    }
    else this.p.push({ seq, timeUs, codec, left, right, frames: left.length });
  }

  render(outL, outR) { this.p.render(outL, outR); }
  stats() { return { ...this.p.stats(), trace: this.events }; }
}

// ================================================================================================ the index signal
// Sound frame n, in block b = n div 2^21 at x = n mod 2^21: L = 1/4 + x'/2^23 with x' = x in even blocks and
// 2^21-1-x in odd ones (a triangle: no jump anywhere, so a resampler's kernel never straddles one), R = 1/4 + b/2^13
// (steps of 1024 float32 ulps: interpolation noise can't turn one into another). Both exact in float32, in
// [1/4, 1/2): never near zero, so nothing mistakes them for silence; silent frames stay 0. A resampler's values
// decode to fractional frame numbers; a fade or a mix with silence to nothing (NaN). Up to 2^32 frames (24 h).
const IDX_W = 2097152, IDX_LO = 1 / 8388608, IDX_HI = 1 / 8192;

export function indexFrames(firstFrame, count, isSound, left = new Float32Array(count), right = new Float32Array(count)) {
  for (let i = 0; i < count; i++) {
    const n = firstFrame + i;
    if (isSound(n)) {
      const b = Math.floor(n / IDX_W), x = n - b * IDX_W;
      left[i] = 0.25 + (b & 1 ? IDX_W - 1 - x : x) * IDX_LO;
      right[i] = 0.25 + b * IDX_HI;
    } else { left[i] = 0; right[i] = 0; }
  }
  return { left, right };
}

/** The source frame an index-signal sample is (fractional if resampled), or NaN (altered: faded, mixed). */
export function decodeIndex(l, r) {
  if (!(l >= 0.25 && l < 0.5 && r >= 0.25 - IDX_HI / 4 && r < 0.5)) return NaN;
  const bf = (r - 0.25) * 8192, b = Math.round(bf), x = (l - 0.25) * 8388608;
  const at = k => k * IDX_W + (k & 1 ? IDX_W - 1 - x : x);
  if (Math.abs(bf - b) <= 0.01) return at(b);
  // Between two steps: a resampler right at a block edge (both readings agree there), or a mix with something else.
  const lo = Math.floor(bf), a = at(lo), c = at(lo + 1);
  return Math.abs(a - c) < 4 ? (a + c) / 2 : NaN;
}

// ================================================================================================ statistics
/** Percentiles from a histogram of 0.1 ms bins. */
class Hist {
  constructor(maxMs = 10000) { this.h = new Uint32Array(maxMs * 10 + 1); this.n = 0; this.max = -Infinity; this.min = Infinity; }
  add(ms) { const b = Math.max(0, Math.min(this.h.length - 1, Math.round(ms * 10))); this.h[b]++; this.n++; if (ms > this.max) this.max = ms; if (ms < this.min) this.min = ms; }
  pct(p) {
    if (!this.n) return null;
    const want = Math.ceil(p / 100 * this.n);
    let acc = 0;
    for (let i = 0; i < this.h.length; i++) { acc += this.h[i]; if (acc >= want) return i / 10; }
    return this.max;
  }
  summary() { return this.n ? { n: this.n, min: +this.min.toFixed(1), p50: this.pct(50), p95: this.pct(95), p99: this.pct(99), max: +this.max.toFixed(1) } : null; }
}

export function percentile(a, p) {
  if (!a.length) return null;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))];
}
const minOf = a => { let m = Infinity; for (const x of a) if (x < m) m = x; return m; };
const maxOf = a => { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; };
const r1 = x => (x == null || !Number.isFinite(x) ? x ?? null : Math.round(x * 10) / 10);
const r2 = x => (x == null || !Number.isFinite(x) ? x ?? null : Math.round(x * 100) / 100);

// ================================================================================================ the simulation
/**
 * Plays `packets` ({at ms, seq, codec, k}: k = which 10 ms of the source, ascending) through playouts from `make`,
 * with an output clock `ppm` off, and follows the output sample by sample (see the header). `real(p)` gives a
 * packet's real samples ({left, right} floats, or null for a silence packet); `expected` (interleaved integers from
 * frame 0) scores them: samples from PCM packets exactly, from Opus packets as SNR against the source `shift` frames
 * earlier (the decoder's delay).
 */
export function simulatePlayout({ packets, ppm = 0, make, isSound = () => true, silentCount = () => 0, real = null, expected = null, shift = 0,
  quantum = 128, tailMs = 600, settleMs = 1000, maxEvents = 200, fromMs = null, learnMs = 45000 }) {
  const ratio = 1 + ppm * 1e-6;
  const qMs = quantum / 48 / ratio;
  const sMs = qMs / quantum;
  const first = packets[0];
  const t0 = first.at - qMs / 2;
  const tEnd = packets.at(-1).at + tailMs;
  const kMin = packets[0].k;
  const arrival = new Float64Array(packets.at(-1).k - kMin + 1).fill(NaN);
  const codecOf = new Uint8Array(arrival.length).fill(255);
  for (const p of packets) { arrival[p.k - kMin] = p.at; codecOf[p.k - kMin] = p.codec; }
  const idx = make(), act = real ? make() : null;
  const oL = new Float32Array(quantum), oR = new Float32Array(quantum), aL = new Float32Array(quantum), aR = new Float32Array(quantum);

  const S = {
    started: false, firstPlayAt: null, lastN: -1, frac: false, zeros: 0, altered: 0, tailAltered: 0, gapAt: 0,
    all: blankCounts(), steady: blankCounts(), after: blankCounts(), late: blankCounts(), events: [],
    delay: new Hist(), delayAll: new Hist(),
    exact: { checked: 0, mismatched: 0, resampled: 0, first: [] },
    snr: new Map(), // second of source -> [signal energy, error energy]
    divergent: 0,
  };
  const event = (t, type, frames, extra = {}) => {
    const steady = t >= S.firstPlayAt + settleMs && t <= lastAt;
    if (S.events.length < maxEvents) S.events.push({ t: r1(t - first.at), type, ms: r2(frames / 48), steady, ...extra });
    return steady;
  };
  // (After the last packet has arrived the stream is over: what the drain does then counts only under "all".)
  const lastAt = packets.at(-1).at;
  const add = (t, key, v) => {
    if (!v) return;
    S.all[key] += v;
    if (t > lastAt) return;
    if (t >= S.firstPlayAt + settleMs) S.steady[key] += v;
    if (fromMs !== null && t >= first.at + fromMs) S.after[key] += v;
    if (t >= first.at + learnMs) S.late[key] += v; // after the time a playout may take to learn the path (cellular's stalls)
  };

  // A run of zeros/altered output between source frames a and b (b the frame playing now).
  const gap = (a, b, t) => {
    let Z = S.zeros + S.altered;
    const at = Z ? S.gapAt : t;
    // Altered samples standing in one for one for the frames between (a resampler's edge into silence, a fade with
    // nothing lost): the sound was modified there, not interrupted.
    if (!S.zeros && S.altered && b > a && Math.abs(b - a - 1 - S.altered) <= 3) { add(at, 'modified', S.altered); return; }
    if (S.altered) add(at, 'concealed', S.altered);
    // Altered samples after the last zero, right before b: the frames just before b faded back in after a dropout
    // (played, though not exactly), not frames skipped.
    if (S.zeros && S.tailAltered && b > a) {
      const fadeIn = Math.min(S.tailAltered, b - a - 1);
      b -= fadeIn;
      S.altered -= fadeIn;
      Z = S.zeros + S.altered;
    }
    if (b <= a) {
      const rep = a - b + 1, sil = silentCount(b, a + 1);
      add(at, 'insertedSound', rep - sil);
      add(at, 'insertedSilence', sil);
      if (rep - sil) event(at, 'repeat', rep - sil);
      if (Z) { add(at, 'underruns', 1); add(at, 'underrunFrames', Z); event(at, 'underrun', Z); }
      return;
    }
    const between = b - a - 1, sil = silentCount(a + 1, b), snd = between - sil;
    if (snd > 0) { add(at, 'droppedSound', snd); event(at, 'drop', snd); }
    if (snd === 0 && sil > 0) {
      if (Z > sil) add(at, 'insertedSilence', Z - sil); else add(at, 'droppedSilence', sil - Z);
    } else {
      const fill = Math.max(0, Z - sil);
      add(at, 'droppedSilence', Math.max(0, sil - Z));
      if (fill > 0) { add(at, 'underruns', 1); add(at, 'underrunFrames', fill); event(at, 'underrun', fill, { concealed: S.altered }); }
    }
  };

  let pi = 0;
  const feed = p => {
    const k = p.k, n0 = k * FRAMES;
    const ix = p.codec === 2 ? { left: new Float32Array(FRAMES), right: new Float32Array(FRAMES) } : indexFrames(n0, FRAMES, isSound);
    idx.packet({ seq: p.seq, codec: p.codec, timeUs: p.hostUs, left: ix.left, right: ix.right, index: true });
    if (act) {
      const x = real(p) || { left: new Float32Array(FRAMES), right: new Float32Array(FRAMES) };
      act.packet({ seq: p.seq, codec: p.codec, timeUs: p.hostUs, left: x.left, right: x.right, bytes: p.payload });
    }
  };

  for (let q = 0; ; q++) {
    const t = t0 + q * qMs;
    if (t > tEnd) break;
    while (pi < packets.length && packets[pi].at <= t) feed(packets[pi++]);
    // The playout's own counters as the last packet goes in (the tail after it only drains the buffer).
    if (pi === packets.length && !S.snap) S.snap = idx.stats();
    idx.render(oL, oR);
    if (act) act.render(aL, aR);
    let delayDone = false;
    for (let i = 0; i < quantum; i++) {
      const l = oL[i], r = oR[i], ts = t + i * sMs;
      if (act && ((l === 0 && r === 0) !== (aL[i] === 0 && aR[i] === 0)) && S.started) S.divergent++;
      if (l === 0 && r === 0) { if (S.started) { if (!S.zeros && !S.altered) S.gapAt = ts; S.zeros++; S.tailAltered = 0; } continue; }
      const nx = decodeIndex(l, r);
      if (Number.isNaN(nx)) { if (S.started) { if (!S.zeros && !S.altered) S.gapAt = ts; S.altered++; S.tailAltered++; } continue; }
      // Resampled: the playout says so (its trace), or the sample sits between source frames.
      const rs = idx.resampledAt ? idx.resampledAt(q * quantum + i) : false;
      const fractional = !Number.isInteger(nx) || rs;
      if (fractional) add(ts, 'resampled', 1);
      if (!S.started) { S.started = true; S.firstPlayAt = ts; }
      else if (fractional || S.frac) {
        const jump = nx - S.lastN - 1, off = nx % IDX_W;
        if (Math.abs(jump) > 1.5 || S.zeros || S.altered) {
          // (Within 64 frames of one of the index signal's 2^21-frame block edges, a resampler's kernel straddles the
          // edge: a few samples read as altered or a frame or two off. That is the index signal's, not the sound's.)
          if (!S.zeros && Math.min(off, IDX_W - off) < 64 && Math.abs(jump) <= 8 + S.altered) add(ts, 'modified', Math.max(1, S.altered));
          else gap(Math.floor(S.lastN), Math.ceil(nx), ts);
        }
      } else if (nx !== S.lastN + 1 || S.zeros || S.altered) gap(S.lastN, nx, ts);
      S.lastN = nx;
      S.frac = fractional;
      S.zeros = 0;
      S.altered = 0;
      S.tailAltered = 0;
      const n = Math.round(nx);
      if (!delayDone) {
        const a = arrival[Math.floor(n / FRAMES) - kMin];
        if (Number.isFinite(a)) { S.delayAll.add(ts - a); if (ts >= S.firstPlayAt + settleMs) S.delay.add(ts - a); }
        delayDone = true;
      }
      if (act && expected) {
        const codec = codecOf[Math.floor(n / FRAMES) - kMin];
        const m = codec === 0 ? n - shift : n;
        if ((codec === 0 || codec === 1) && m >= 0 && 2 * m + 1 < expected.length && isSound(m)) {
          const eL = expected[2 * m], eR = expected[2 * m + 1];
          if (codec === 1 && fractional) {
            S.exact.checked++; // a resampled sample isn't the source's, by definition
            S.exact.mismatched++;
            S.exact.resampled++;
          } else if (codec === 1) {
            S.exact.checked++;
            const gL = Math.round(aL[i] * 8388608), gR = Math.round(aR[i] * 8388608);
            if (gL !== eL || gR !== eR) { S.exact.mismatched++; if (S.exact.first.length < 5) S.exact.first.push({ frame: m, got: [gL, gR], want: [eL, eR] }); }
          } else {
            const sec = Math.floor(m / RATE);
            let e = S.snr.get(sec);
            if (!e) S.snr.set(sec, e = [0, 0, 0]);
            e[2]++;
            const dL = aL[i] * 8388608 - eL, dR = aR[i] * 8388608 - eR;
            e[0] += eL * eL + eR * eR;
            e[1] += dL * dL + dR * dR;
          }
        }
      }
    }
  }
  const counts = c => ({
    underruns: c.underruns, underrunMs: r1(c.underrunFrames / 48), concealedMs: r1(c.concealed / 48),
    droppedSound: c.droppedSound, insertedSound: c.insertedSound, droppedSilence: c.droppedSilence, insertedSilence: c.insertedSilence,
    resampledMs: r1(c.resampled / 48), modifiedMs: r1(c.modified / 48),
  });
  const snrSecs = [...S.snr.entries()].filter(([, e]) => e[2] >= RATE / 2).sort((a, b) => a[0] - b[0]).map(([s, [sig, err]]) => ({ s, db: err > 0 ? r1(10 * Math.log10(sig / err)) : 99 }));
  return {
    ppm,
    firstPlayMs: S.firstPlayAt == null ? null : r1(S.firstPlayAt - first.at),
    all: counts(S.all), steady: counts(S.steady), after: fromMs === null ? undefined : { fromMs: r1(fromMs), ...counts(S.after) }, late: { fromMs: learnMs, ...counts(S.late) },
    bufferDelayMs: S.delay.summary(), bufferDelayAllMs: S.delayAll.summary(),
    events: S.events,
    exact: act && S.exact.checked ? { checked: S.exact.checked, mismatched: S.exact.mismatched, resampled: S.exact.resampled, first: S.exact.first } : undefined,
    snr: act && snrSecs.length ? snrSummary(snrSecs) : undefined,
    divergentSamples: act ? S.divergent : undefined,
    playout: S.snap || idx.stats(),
  };
}

function blankCounts() {
  return { underruns: 0, underrunFrames: 0, concealed: 0, droppedSound: 0, insertedSound: 0, droppedSilence: 0, insertedSilence: 0, resampled: 0, modified: 0 };
}

function snrSummary(secs) {
  if (!secs.length) return null;
  const dbs = secs.map(s => s.db);
  return { seconds: secs.length, medianDb: r1(percentile(dbs, 50)), minDb: r1(minOf(dbs)), perSecond: secs };
}

// ================================================================================================ Opus: Ogg + ffmpeg
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04C11DB7) >>> 0 : (r << 1) >>> 0; t[i] = r >>> 0; }
  return t;
})();
/** Ogg's CRC-32 (polynomial 0x04C11DB7, no reflection, initial 0, no final xor). */
export function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc;
}
function oggPage(type, granule, serial, seq, packets) {
  const segs = [];
  for (const p of packets) { let n = p.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n); }
  const h = Buffer.alloc(27 + segs.length);
  h.write('OggS', 0);
  h[5] = type;
  h.writeBigInt64LE(BigInt(granule), 6);
  h.writeUInt32LE(serial, 14);
  h.writeUInt32LE(seq, 18);
  h[26] = segs.length;
  segs.forEach((s, i) => { h[27 + i] = s; });
  const page = Buffer.concat([h, ...packets.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength))]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/** Samples (48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1). */
export function opusSamples(p) {
  const toc = p[0], config = toc >> 3, code = toc & 3;
  const size = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const frames = code === 0 ? 1 : code < 3 ? 2 : (p[1] & 0x3f);
  return size * frames;
}
export function opusMode(p) {
  const c = p[0] >> 3;
  if (c < 12) return `SILK ${['NB', 'MB', 'WB'][c >> 2]}`;
  if (c < 16) return `hybrid ${['SWB', 'FB'][(c >> 1) & 1]}`;
  return `CELT ${['NB', 'WB', 'SWB', 'FB'][(c >> 2) & 3]}`;
}

/** An Ogg Opus file (stereo, pre-skip 0) of `packets`, in order, as one decoder would get them. */
export function oggOpus(packets) {
  const serial = 0x48524d21;
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0); head[8] = 1; head[9] = 2; head.writeUInt16LE(0, 10); head.writeUInt32LE(48000, 12); head.writeInt16LE(0, 16); head[18] = 0;
  const vendor = Buffer.from('headroom audio-check');
  const tags = Buffer.alloc(16 + vendor.length);
  tags.write('OpusTags', 0); tags.writeUInt32LE(vendor.length, 8); vendor.copy(tags, 12); tags.writeUInt32LE(0, 12 + vendor.length);
  const pages = [oggPage(2, 0, serial, 0, [head]), oggPage(0, 0, serial, 1, [tags])];
  let granule = 0, seq = 2;
  for (let i = 0; i < packets.length;) {
    const group = [];
    let segs = 0;
    while (i < packets.length && group.length < 50) {
      const s = Math.floor(packets[i].length / 255) + 1;
      if (segs + s > 255) break;
      group.push(packets[i]);
      segs += s;
      granule += opusSamples(packets[i]);
      i++;
    }
    pages.push(oggPage(i >= packets.length ? 4 : 0, granule, serial, seq++, group));
  }
  return Buffer.concat(pages);
}

/** Decodes Opus packets with ffmpeg's libopus, as one stream: interleaved stereo floats, or {error}. */
export function decodeOpus(packets, dir) {
  const file = join(dir, `opus-${process.pid}-${Date.now()}.ogg`);
  writeFileSync(file, oggOpus(packets));
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-c:a', 'libopus', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'], { maxBuffer: 2 ** 31 });
  rmSync(file, { force: true });
  if (r.status !== 0 || !r.stdout) return { error: String(r.stderr || r.error || 'ffmpeg failed').slice(0, 300) };
  const b = r.stdout;
  return { pcm: new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)), warnings: String(r.stderr || '').trim().slice(0, 300) };
}

/** The packets of an Ogg stream (the first two of an Ogg Opus file are its OpusHead and OpusTags). */
export function oggPackets(buf) {
  const out = [];
  let cur = [];
  for (let o = 0; o + 27 <= buf.length;) {
    const n = buf[o + 26];
    let d = o + 27 + n;
    for (const seg of buf.subarray(o + 27, o + 27 + n)) {
      cur.push(buf.subarray(d, d + seg));
      d += seg;
      if (seg < 255) { out.push(new Uint8Array(Buffer.concat(cur))); cur = []; }
    }
    o = d;
  }
  return out;
}

/** CAF (what afconvert writes AudioToolbox's Opus into): its format, packet table (priming = the encoder's delay), packets. */
export function cafPackets(buf) {
  if (buf.toString('latin1', 0, 4) !== 'caff') throw new Error('not a CAF file');
  let o = 8, desc = null, pakt = null, sizes = [], data = null;
  while (o + 12 <= buf.length) {
    const type = buf.toString('latin1', o, o + 4), size = Number(buf.readBigInt64BE(o + 4)), body = o + 12;
    const end = size < 0 ? buf.length : body + size;
    if (type === 'desc') desc = { rate: buf.readDoubleBE(body), format: buf.toString('latin1', body + 8, body + 12), framesPerPacket: buf.readUInt32BE(body + 20), channels: buf.readUInt32BE(body + 24) };
    else if (type === 'pakt') {
      const count = Number(buf.readBigInt64BE(body));
      pakt = { packets: count, validFrames: Number(buf.readBigInt64BE(body + 8)), priming: buf.readInt32BE(body + 16), remainder: buf.readInt32BE(body + 20) };
      let q = body + 24;
      for (let i = 0; i < count; i++) { let v = 0, b; do { b = buf[q++]; v = v * 128 + (b & 0x7f); } while (b & 0x80); sizes.push(v); }
    } else if (type === 'data') data = buf.subarray(body + 4, end); // (after the edit count)
    o = end;
  }
  const packets = [];
  let q = 0;
  for (const n of sizes) { packets.push(new Uint8Array(data.subarray(q, q + n))); q += n; }
  return { desc, pakt, packets };
}

/** In-place radix-2 FFT (length a power of two). */
const TWIDDLES = new Map();
function fft(re, im) {
  const n = re.length;
  let tw = TWIDDLES.get(n);
  if (!tw) {
    tw = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) { tw.c[k] = Math.cos(-2 * Math.PI * k / n); tw.s[k] = Math.sin(-2 * Math.PI * k / n); }
    TWIDDLES.set(n, tw);
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const h = len >> 1, stride = n / len;
    for (let k = 0; k < h; k++) {
      const wr = tw.c[k * stride], wi = tw.s[k * stride];
      for (let i = k; i < n; i += len) {
        const br = re[i + h] * wr - im[i + h] * wi, bi = re[i + h] * wi + im[i + h] * wr;
        re[i + h] = re[i] - br; im[i + h] = im[i] - bi; re[i] += br; im[i] += bi;
      }
    }
  }
}

export const BASS_HZ = [20, 40, 60, 100, 220];

/**
 * Between the source x and what came out y (functions of (channel, source frame) -> float), over N-frame segments
 * (Hann windows) at `starts`: the transfer function's level at the bass frequencies (dB, each over ±3 Hz) and the
 * coding SNR, the part of y that no linear filter of x explains against the part one does (so an encoder's high-pass
 * or phase shift isn't counted in it: that's what the bass figures are for). The music's noise is what reaches the
 * bass below its 220 Hz fundamental.
 */
export function spectralFidelity(x, y, starts, N = 16384) {
  const H = N / 2, win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const sxx = new Float64Array(H), syy = new Float64Array(H), sr = new Float64Array(H), si = new Float64Array(H);
  const xr = new Float64Array(N), xi = new Float64Array(N), yr = new Float64Array(N), yi = new Float64Array(N);
  for (const s0 of starts) for (let c = 0; c < 2; c++) {
    for (let i = 0; i < N; i++) { xr[i] = x(c, s0 + i) * win[i]; yr[i] = y(c, s0 + i) * win[i]; }
    xi.fill(0); yi.fill(0);
    fft(xr, xi); fft(yr, yi);
    for (let k = 1; k < H; k++) {
      sxx[k] += xr[k] * xr[k] + xi[k] * xi[k]; syy[k] += yr[k] * yr[k] + yi[k] * yi[k];
      sr[k] += xr[k] * yr[k] + xi[k] * yi[k]; si[k] += xr[k] * yi[k] - xi[k] * yr[k];
    }
  }
  if (!starts.length) return null;
  const bassDb = {};
  for (const f of BASS_HZ) {
    let a = 0, b = 0, d = 0;
    const half = Math.max(3, 0.6 * RATE / N); // ±3 Hz, or a bin either side if the bins are coarser
    for (let k = 1; k < H; k++) if (Math.abs(k * RATE / N - f) <= half) { a += sr[k]; b += si[k]; d += sxx[k]; }
    bassDb[`${f}Hz`] = d ? r1(20 * Math.log10(Math.sqrt(a * a + b * b) / d)) : null;
  }
  let pc = 0, py = 0;
  for (let k = 1; k < H; k++) { if (sxx[k] > 0) pc += (sr[k] * sr[k] + si[k] * si[k]) / sxx[k]; py += syy[k]; }
  return { segments: starts.length, bassDb, codingSnrDb: py > pc ? r1(10 * Math.log10(pc / (py - pc))) : 99 };
}

/** Starts (every `hop` frames in [from, to)) of N-frame stretches inside one 3 s stretch of the music's sound, where ok(first, last). */
function soundSegments(from, to, N, hop, ok = () => true) {
  const out = [];
  for (let a = from; a + N <= to; a += hop) {
    const b = a + N - 1;
    if (!musicIsSound(a) || !musicIsSound(b) || Math.floor(a / 192000) !== Math.floor(b / 192000) || !ok(a, b)) continue;
    out.push(a);
  }
  return out;
}

/** Writes interleaved 24-bit stereo as a WAV file. */
function writeWav24(file, samples) {
  const data = Buffer.alloc(samples.length * 3);
  for (let i = 0; i < samples.length; i++) data.writeIntLE(samples[i], i * 3, 3);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 6, 28); h.writeUInt16LE(6, 32); h.writeUInt16LE(24, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
}

/**
 * What an encoder reaches on this music at `kbps`, measured exactly as a host's stream is: `seconds` of it encoded in
 * 10 ms packets, decoded by libopus as one stream (pre-skip 0), lined up by the encoder's own delay (its priming or
 * pre-skip), scored per sound frame. encoder: 'audiotoolbox' (afconvert: the Mac host's encoder; macOS only) or
 * 'libopus' (ffmpeg, restricted low delay: what the Windows host's Concentus is a port of).
 */
export function encoderReference(encoder, kbps, dir, seconds = 60) {
  const frames = seconds * RATE, gen = musicFrames(frames);
  const base = join(dir, `ref-${process.pid}-${encoder}-${kbps}`);
  let packets, delay;
  try {
    if (encoder === 'audiotoolbox') {
      writeWav24(`${base}.wav`, gen);
      const e = spawnSync('afconvert', ['-f', 'caff', '-d', 'opus@48000#480', '-b', String(kbps * 1000), `${base}.wav`, `${base}.caf`]);
      if (e.status !== 0) return { encoder, kbps, error: `afconvert: ${String(e.stderr || e.error).slice(0, 200)}` };
      const caf = cafPackets(readFileSync(`${base}.caf`));
      packets = caf.packets;
      delay = caf.pakt.priming;
    } else {
      const raw = Buffer.alloc(frames * 8);
      for (let i = 0; i < gen.length; i++) raw.writeInt32LE(gen[i] * 256, i * 4);
      writeFileSync(`${base}.raw`, raw);
      const e = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's32le', '-ar', '48000', '-ac', '2', '-i', `${base}.raw`, '-c:a', 'libopus', '-b:a', `${kbps}k`, '-frame_duration', '10', '-application', 'lowdelay', `${base}.ogg`]);
      if (e.status !== 0) return { encoder, kbps, error: `ffmpeg: ${String(e.stderr || e.error).slice(0, 200)}` };
      const all = oggPackets(readFileSync(`${base}.ogg`));
      packets = all.slice(2);
      delay = Buffer.from(all[0]).readUInt16LE(10);
    }
  } finally {
    for (const ext of ['wav', 'caf', 'raw', 'ogg']) rmSync(`${base}.${ext}`, { force: true });
  }
  const dec = decodeOpus(packets, dir);
  if (dec.error) return { encoder, kbps, error: dec.error };
  const pcm = dec.pcm, n1 = Math.min(frames, pcm.length / 2 - delay);
  let sig = 0, err = 0;
  for (let m = RATE / 10; m < n1; m++) {
    if (!musicIsSound(m)) continue;
    for (let c = 0; c < 2; c++) { const w = gen[2 * m + c], g = pcm[2 * (m + delay) + c] * 8388608; sig += w * w; err += (g - w) ** 2; }
  }
  const N = 16384;
  const sp = spectralFidelity((c, m) => gen[2 * m + c] / 8388608, (c, m) => pcm[2 * (m + delay) + c], soundSegments(RATE / 10, n1, N, N / 2));
  const bytes = packets.reduce((a, q) => a + q.length, 0);
  return { encoder: encoder === 'audiotoolbox' ? 'AudioToolbox (afconvert)' : 'libopus restricted low delay (ffmpeg)', kbps, actualKbps: Math.round(bytes * 8 / (packets.length * 10)),
    delayFrames: delay, snrDb: r1(10 * Math.log10(sig / err)), codingSnrDb: sp?.codingSnrDb ?? null, bassDb: sp?.bassDb ?? null, seconds };
}

/** The lag (frames) in [lo, hi] that best lines got(n) up with want(n - lag), over n in [from, to), by correlation. */
function bestLag(got, want, from, to, lo, hi, step = 1) {
  let best = { lag: 0, corr: -Infinity };
  for (let lag = lo; lag <= hi; lag++) {
    let sxy = 0, sxx = 0, syy = 0;
    for (let n = from; n < to; n += step) {
      const m = n - lag;
      if (m < 0) continue;
      const x = got(n), y = want(m);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      sxy += x * y; sxx += x * x; syy += y * y;
    }
    const c = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    if (c > best.corr) best = { lag, corr: c };
  }
  return best;
}

// ================================================================================================ analysis
const u32diff = (a, b) => (a - b) >>> 0;

/**
 * Everything about a capture: { audio: [{at, seq, codec, hostUs, bytes, payload?}], audioModes, stats, video, pongs,
 * meta }. Returns the report (and keeps the heavy parts out of it).
 */
export async function analyze(cap, opts = {}) {
  const { signal = 'music', ppms = [80, -80], playout = 'auto', profile = null, maxDelayP95 = null, tmp = tmpdir() } = opts;
  const audio = cap.audio;
  const report = { label: opts.label ?? cap.meta?.label ?? null, profile, signal, request: cap.meta?.request, host: cap.meta?.host, network: cap.meta?.network, seconds: cap.meta?.seconds, closedEarlyAtMs: cap.meta?.closedEarlyAtMs };
  if (!audio.length) { report.error = 'no audio arrived'; return report; }

  // ------------------------------------------------------------------ the wire
  const s0 = audio[0].seq;
  let missing = 0, gaps = 0, reordered = 0, maxGapPackets = 0;
  const codecs = {};
  for (let i = 0; i < audio.length; i++) {
    const p = audio[i];
    p.k = u32diff(p.seq, s0);
    codecs[p.codec] = (codecs[p.codec] || 0) + 1;
    if (i) {
      const d = p.k - audio[i - 1].k;
      if (d <= 0) reordered++;
      else if (d > 1) { gaps++; missing += d - 1; maxGapPackets = Math.max(maxGapPackets, d - 1); }
    }
  }
  const span = audio.at(-1).k + 1;
  // Codec runs, as the stream switched.
  const runs = [];
  for (const p of audio) { const last = runs.at(-1); if (last && last.codec === p.codec) { last.to = p.k; last.n++; } else runs.push({ codec: p.codec, from: p.k, to: p.k, n: 1, atMs: r1(p.at) }); }
  // Per-second bitrate of each codec (seconds of the source timeline: k / 100).
  const perSecond = new Map();
  for (const p of audio) {
    const s = Math.floor(p.k / 100);
    let e = perSecond.get(s);
    if (!e) perSecond.set(s, e = { s, opusBytes: 0, opusPackets: 0, pcmPackets: 0, silencePackets: 0 });
    if (p.codec === 0) { e.opusBytes += p.bytes; e.opusPackets++; } else if (p.codec === 1) e.pcmPackets++; else if (p.codec === 2) e.silencePackets++;
  }
  const secs = [...perSecond.values()].sort((a, b) => a.s - b.s);
  for (const e of secs) e.opusKbps = e.opusPackets ? Math.round(e.opusBytes * 8 / (e.opusPackets * 10)) : null; // kbps while sending Opus
  // Host stamps: steady 10 ms per seq (capture time) or the encoder's timing (today: encode time)?
  let stampDevMax = 0, slips = 0;
  const stampDev = [];
  for (let i = 1; i < audio.length; i++) {
    const dk = audio[i].k - audio[i - 1].k;
    const dev = (audio[i].hostUs - audio[i - 1].hostUs) / 1000 - dk * 10;
    stampDev.push(Math.abs(dev));
    stampDevMax = Math.max(stampDevMax, Math.abs(dev));
    if (dev > 5) slips++; // the source itself was late by more than half a packet (today's tone timer under load)
  }
  // The source's rate against the host clock (its stamps) and against this Mac's (arrivals; the same clock in the lab):
  // least squares of time vs k, in ppm off 100 packets a second (+ = more sound per second than 48 kHz).
  const slopeOf = y => {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of audio) { const v = y(p); sx += p.k; sy += v; sxx += p.k * p.k; sxy += p.k * v; }
    return (audio.length * sxy - sx * sy) / (audio.length * sxx - sx * sx);
  };
  const hostRatePpm = audio.length > 100 ? (10 / slopeOf(p => (p.hostUs - audio[0].hostUs) / 1000) - 1) * 1e6 : null;
  const arrivalRatePpm = audio.length > 100 ? (10 / slopeOf(p => p.at) - 1) * 1e6 : null;
  // Transport delay: arrival - host stamp, offset-normalised (minus the smallest), after the first second.
  const raw = audio.map(p => p.at - p.hostUs / 1000);
  const minRaw = minOf(raw);
  const td = new Hist();
  audio.forEach((p, i) => { if (p.at - audio[0].at >= 1000) td.add(raw[i] - minRaw); });
  let absolute = null;
  if (cap.pongs?.length) {
    // Host clock offset from the fastest ping (through the same proxy: within ± half that round trip).
    const best = cap.pongs.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    const offsetMs = best.host / 1000 - (best.sent + best.rtt / 2);
    const abs = audio.map(p => p.at - (p.hostUs / 1000 - offsetMs));
    absolute = { p50: r1(percentile(abs, 50)), p95: r1(percentile(abs, 95)), max: r1(maxOf(abs)), pingRttMs: r1(best.rtt) };
  }
  // The best any playout could do here: a fixed delay on the source's own clock (each packet's lateness against
  // seq x 10 ms, its rate trend taken out) that catches every packet after the first second. Its spread is the least
  // buffer that never runs dry; its delays are what that buffer costs (the bound a pass criterion can't beat).
  let ideal = null;
  {
    const after = audio.filter(p => p.at - audio[0].at >= 1000);
    if (after.length > 100) {
      const slope = slopeOf(p => p.at);
      const late = after.map(p => p.at - p.k * slope);
      const worst = maxOf(late);
      const delays = late.map(l => worst - l + 5); // + half a packet: a packet's samples play over its 10 ms
      ideal = { neverDryBufferMs: r1(worst - minOf(late) + 10), bufferDelayP50: r1(percentile(delays, 50)), bufferDelayP95: r1(percentile(delays, 95)) };
      // The network's share alone (lateness against each packet's own host stamp: the transport delay). The same
      // as above when the stamps are exact capture times; less when the source itself was late (today's tone).
      const td2 = after.map(p => p.at - p.hostUs / 1000), w2 = maxOf(td2), d2 = td2.map(l => w2 - l + 5);
      ideal.networkOnly = { neverDryBufferMs: r1(w2 - minOf(td2) + 10), bufferDelayP50: r1(percentile(d2, 50)), bufferDelayP95: r1(percentile(d2, 95)) };
    }
  }
  report.wire = {
    packets: audio.length, span, missing, gaps, maxGapPackets, reordered, idealPlayout: ideal, codecs: Object.fromEntries(Object.entries(codecs).map(([c, n]) => [['opus', 'pcm24', 'silence'][c] || c, n])),
    runs: runs.slice(0, 50).map(r => ({ codec: ['opus', 'pcm24', 'silence'][r.codec] || r.codec, fromK: r.from, toK: r.to, packets: r.n, atMs: r.atMs })), runCount: runs.length,
    hostStampJitterMs: { p50: r2(percentile(stampDev, 50)), p99: r2(percentile(stampDev, 99)), max: r2(stampDevMax) }, hostLateStamps: slips,
    hostRatePpm: r1(hostRatePpm), arrivalRatePpm: r1(arrivalRatePpm),
    transportDelayMs: td.summary(), transportDelayAbsoluteMs: absolute,
    audioModes: cap.audioModes,
    // (the client sets its playout up from audio-mode: one that comes after packets means a restart at the start)
    audioModeBeforeFirstPacket: cap.audioModes?.length ? cap.audioModes[0].at <= audio[0].at : null,
  };

  // ------------------------------------------------------------------ alignment, expected signal, fidelity
  const music = signal === 'music';
  const isSound = music ? musicIsSound : () => true;
  const silentCount = music ? musicSilentCount : () => 0;
  let k0 = 0, expected = null;
  const align = { method: 'first packet = packet 0 of the generator' };
  if (music) {
    // Where the stream first goes silent tells the alignment modulo 4 s: silence starts at packet 300 of 400.
    const firstSilence = audio.find(p => p.codec === 2);
    const firstHole = audio.find((p, i) => i && p.k - audio[i - 1].k > 1);
    if (firstSilence) align.firstSilenceK = firstSilence.k;
    if (firstHole) align.firstHoleK = audio[audio.indexOf(firstHole) - 1].k + 1;
    const pcm = audio.filter(p => p.codec === 1 && p.payload);
    if (pcm.length) {
      // Lossless: verify by exact match; if packet 0 doesn't match, search (the generator may have started earlier).
      const probe = pcm.find(p => decodePcm24(p.payload).some(v => v !== 0)) || pcm[0];
      const got = decodePcm24(probe.payload);
      const g = new MusicGen();
      const want = new Int32Array(FRAMES * 2);
      let found = -1;
      for (let kk = 0; kk < 360000; kk++) {
        g.next(FRAMES, want);
        if (kk < probe.k) continue;
        let same = true;
        for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) { same = false; break; }
        if (same) { found = kk - probe.k; break; }
      }
      align.method = 'exact match of a PCM packet';
      align.verified = found >= 0;
      if (found > 0) { k0 = found; align.method += ` (the generator was ${found} packets ahead of the first packet)`; }
    } else {
      // Opus only: where the sound starts (the first Opus packet after silence packets or a hole) is packet 0 of the
      // music's 400-packet cycle. Not where silence starts: an encoder with lookahead flushes its tail into one more
      // Opus packet, and today's host sends 200 ms of silence before its hole. The most common phase wins; the exact
      // packet and which 4 s cycle (the music's tones repeat every cycle, its noise doesn't) are settled once the Opus
      // is decoded, by lining it up at the encoder's known delay.
      const votes = new Map();
      for (let i = 1; i < audio.length; i++) {
        const prev = audio[i - 1], p = audio[i];
        if (p.codec !== 0) continue;
        if ((prev.codec === 2 && p.k === prev.k + 1) || p.k > prev.k + 1) votes.set((400 - (p.k % 400)) % 400, (votes.get((400 - (p.k % 400)) % 400) || 0) + 1);
      }
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best) {
        align.method = `where the sound starts (${best[1]} of ${[...votes.values()].reduce((a, b) => a + b, 0)} sound starts agree)`;
        k0 = best[0];
      } else align.method += ' (no silence seen to check it)';
      align.refineByOpus = true;
    }
    if (k0) for (const p of audio) p.k += k0;
    // (one more cycle than the stream, for the Opus alignment's candidates)
    expected = musicFrames((audio.at(-1).k + 1) * FRAMES + RATE + (align.refineByOpus ? MUSIC.cycle + 2 * FRAMES : 0));
  }
  report.alignment = { ...align, k0 };

  // Wire-level lossless check.
  if (music && audio.some(p => p.codec === 1 || p.codec === 2)) {
    let pcmPackets = 0, pcmBad = 0, samplesChecked = 0, samplesBad = 0, silenceBad = 0, badSize = 0;
    const firstBad = [];
    for (const p of audio) {
      if (p.codec === 1) {
        pcmPackets++;
        if (!p.payload || p.payload.length !== FRAMES * 6) { badSize++; continue; }
        const got = decodePcm24(p.payload), base = p.k * FRAMES * 2;
        let bad = 0;
        for (let i = 0; i < got.length; i++) {
          const w = expected[base + i];
          if (w === 0 && !isSound(p.k * FRAMES + (i >> 1))) continue;
          samplesChecked++;
          if (got[i] !== w) { bad++; if (firstBad.length < 5) firstBad.push({ k: p.k, i, got: got[i], want: w }); }
        }
        samplesBad += bad;
        if (bad) pcmBad++;
      } else if (p.codec === 2) {
        const frames = p.payload && p.payload.length >= 2 ? p.payload[0] | (p.payload[1] << 8) : -1;
        const base = p.k * FRAMES * 2;
        let nonzero = false;
        for (let i = 0; i < FRAMES * 2; i++) if (expected[base + i] !== 0) { nonzero = true; break; }
        if (frames !== FRAMES || nonzero) silenceBad++;
      }
    }
    report.silencePackets = { packets: audio.filter(p => p.codec === 2).length, wrong: silenceBad };
    if (pcmPackets) report.lossless = { pcmPackets, pcmPacketsWithErrors: pcmBad, samplesChecked, samplesWrong: samplesBad, badSize, silencePacketsWrong: silenceBad, firstWrong: firstBad };
  }

  // Opus: decode as the browser would (one decoder, only the Opus packets, in order) and score it.
  let opusChunks = null, shift = 0;
  const opusPackets = audio.filter(p => p.codec === 0 && p.payload);
  if (opusPackets.length) {
    const modes = {};
    for (const p of opusPackets) { const m = opusMode(p.payload); modes[m] = (modes[m] || 0) + 1; }
    const dec = decodeOpus(opusPackets.map(p => p.payload), tmp);
    const fid = { packets: opusPackets.length, modes, decoder: 'ffmpeg libopus' };
    if (dec.error) fid.error = dec.error;
    else {
      const want = opusPackets.length * FRAMES * 2;
      fid.decodedFrames = dec.pcm.length / 2;
      if (dec.pcm.length !== want) fid.lengthMismatch = { got: dec.pcm.length / 2, want: want / 2 };
      opusChunks = new Map();
      opusPackets.forEach((p, j) => opusChunks.set(p, j));
      if (music && expected) {
        // The decoder's delay is the encoder's own lookahead: both hosts encode with libopus restricted low delay (the Mac
        // host vendors libopus 1.6.1; the Windows host's Concentus is a port of it): 120 frames. --opus-delay overrides
        // (312 for AudioToolbox, which the Mac host used before). Correlation only checks it: a high-passing encoder
        // shifts the phase of the music's 220 Hz, and a free search can lock on a wrong lag.
        const os = cap.meta?.host?.os;
        const encoderInUse = opts.opusEncoder || 'libopus';
        const known = opts.opusDelay ?? (encoderInUse === 'audiotoolbox' ? 312 : 120);
        // The lookahead fixes the delay within a packet. Which packet (and, for Opus alone, which cycle of the music) is
        // settled by lining the decoded sound up: candidates whole packets and whole cycles apart, far wider than the
        // bass's correlation lobe that misleads a free search.
        const quick = dk => {
          let sig = 0, err = 0;
          for (let j = 5; j < Math.min(opusPackets.length, 400); j++) {
            const p = opusPackets[j];
            for (let i = 0; i < FRAMES; i += 3) {
              const m = (p.k + dk) * FRAMES + i - known;
              if (m < 0 || 2 * m + 1 >= expected.length || !isSound(m)) continue;
              for (let c = 0; c < 2; c++) { const w = expected[2 * m + c] / 8388608, g = dec.pcm[2 * (j * FRAMES + i) + c]; sig += w * w; err += (g - w) ** 2; }
            }
          }
          return err ? 10 * Math.log10(sig / err) : -99;
        };
        let dk = 0, atUsed = quick(0);
        const cands = [];
        // (Only for Opus alone: a PCM part's exact match already fixed the numbering.)
        if (report.alignment.refineByOpus) for (const c of [-1, 0, 1]) for (let d = -2; d <= 2; d++) cands.push(d + c * 400);
        for (const cand of cands) {
          if (!cand || audio[0].k + cand < 0) continue;
          const v = quick(cand);
          if (v > atUsed + 1) { dk = cand; atUsed = v; }
        }
        if (dk) {
          for (const p of audio) p.k += dk;
          report.alignment.k0 += dk;
          report.alignment.refined = { packets: dk, note: `lined up by the decoded Opus: ${dk} packet(s) from where the sound starts said` };
        }
        const posK = opusPackets.slice(0, 400), base = posK[0].k * FRAMES;
        const gotArr = new Float64Array((posK.at(-1).k + 1) * FRAMES - base).fill(NaN);
        posK.forEach((p, j) => { const o = p.k * FRAMES - base; for (let i = 0; i < FRAMES; i++) gotArr[o + i] = dec.pcm[2 * (j * FRAMES + i)]; });
        const from = posK[Math.min(posK.length - 1, 5)].k * FRAMES, to = posK.at(-1).k * FRAMES;
        const corrAt = (lag, step) => {
          let sxy = 0, sxx = 0, syy = 0;
          for (let n = from; n < to; n += step) {
            const x = gotArr[n - base], m = n - lag;
            if (x !== x || m < 0) continue;
            const y = isSound(m) ? expected[2 * m] / 8388608 : 0;
            sxy += x * y; sxx += x * x; syy += y * y;
          }
          return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
        };
        const snrAt = lag => {
          let sig = 0, err = 0;
          for (let n = from; n < to; n++) {
            const x = gotArr[n - base], m = n - lag;
            if (x !== x || m < 0 || !isSound(m)) continue;
            const w = expected[2 * m] / 8388608;
            sig += w * w; err += (x - w) ** 2;
          }
          return err ? 10 * Math.log10(sig / err) : 99;
        };
        let best = { lag: 0, corr: -Infinity };
        for (let l = -480; l <= 4800; l += 2) { const c = corrAt(l, 5); if (c > best.corr) best = { lag: l, corr: c }; }
        const coarse = best.lag;
        best = { lag: coarse, corr: -Infinity };
        for (let l = coarse - 4; l <= coarse + 4; l++) { const c = corrAt(l, 1); if (c > best.corr) best = { lag: l, corr: c }; }
        const used = known;
        shift = used;
        atUsed = snrAt(used);
        const atBest = snrAt(best.lag);
        fid.decoderDelay = {
          lookahead: known, used, source: opts.opusDelay != null ? '--opus-delay' : encoderInUse === 'audiotoolbox' ? 'AudioToolbox lookahead' : 'libopus restricted low-delay lookahead',
          correlation: r2(corrAt(used, 1)), snrDb: r1(atUsed), check: { correlationPeakAt: best.lag, correlation: r2(best.corr), snrDb: r1(atBest) },
        };
        // (A free lag that lines the sound up much better than any of those means the host isn't the encoder assumed.)
        if (atBest > atUsed + 1) fid.decoderDelay.warning = `the sound lines up better at ${best.lag} frames (${r1(atBest)} dB) than at ${used} (${r1(atUsed)} dB): which encoder is this?`;
        // SNR per second of sound, straight from the decoder (the playout's own pass is under playout[].snr).
        const bins = new Map();
        let edgeSig = 0, edgeErr = 0;
        opusPackets.forEach((p, j) => {
          const prev = opusPackets[j - 1];
          const edge = !prev || prev.k !== p.k - 1; // the first packet after silence/a hole
          for (let i = 0; i < FRAMES; i++) {
            const m = p.k * FRAMES + i - shift;
            if (m < 0 || !isSound(m)) continue;
            const s = Math.floor(m / RATE);
            let e = bins.get(s);
            if (!e) bins.set(s, e = [0, 0, 0]);
            e[2]++;
            for (let c = 0; c < 2; c++) {
              const w = expected[2 * m + c], g = dec.pcm[2 * (j * FRAMES + i) + c] * 8388608;
              e[0] += w * w; e[1] += (g - w) ** 2;
              if (edge) { edgeSig += w * w; edgeErr += (g - w) ** 2; }
            }
          }
        });
        // Each second's announced rate (the audio-mode in effect when most of its packets arrived), so seconds are only
        // compared with seconds at the same announced level.
        const opusModes = (cap.audioModes || []).filter(m => m.mode === 'opus');
        const levelVotes = new Map();
        for (const p of opusPackets) {
          const m = opusModes.filter(x => x.at <= p.at + 1).at(-1);
          const s = Math.floor((p.k * FRAMES - shift) / RATE);
          const v = levelVotes.get(s) || new Map();
          v.set(m?.kbps ?? null, (v.get(m?.kbps ?? null) || 0) + 1);
          levelVotes.set(s, v);
        }
        // (Seconds with under half a second of Opus sound in them, e.g. the decoder's first frames after a switch, are
        // left to the edge figure below.)
        const per = [...bins.entries()].filter(([, e]) => e[2] >= RATE / 2).sort((a, b) => a[0] - b[0]).map(([s, [sig, err]]) => {
          const v = levelVotes.get(s);
          const kbps = v ? [...v.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
          return { s, db: err > 0 ? r1(10 * Math.log10(sig / err)) : 99, kbps };
        });
        Object.assign(fid, snrSummary(per));
        fid.firstPacketAfterSilenceSnrDb = edgeErr ? r1(10 * Math.log10(edgeSig / edgeErr)) : null;
        // The stream's coding SNR (linear filtering factored out) and bass level, from its sound-only stretches.
        const jOf = new Int32Array(audio.at(-1).k + 2).fill(-1);
        opusPackets.forEach((p, j) => { jOf[p.k] = j; });
        const yAt = (c, m) => { const q = m + shift, k = Math.floor(q / FRAMES), j = jOf[k]; return j < 0 ? 0 : dec.pcm[2 * (j * FRAMES + q - k * FRAMES) + c]; };
        const okSpan = (a, b) => { for (let k = Math.floor((a + shift) / FRAMES); k <= Math.floor((b + shift) / FRAMES); k++) if (k >= jOf.length || jOf[k] < 0) return false; return true; };
        const N = 16384;
        const sp = spectralFidelity((c, m) => expected[2 * m + c] / 8388608, yAt, soundSegments(Math.max(0, base - shift), (audio.at(-1).k + 1) * FRAMES - shift, N, N, okSpan), N);
        if (sp) { fid.codingSnrDb = sp.codingSnrDb; fid.bassDb = sp.bassDb; fid.spectralSegments = sp.segments; }
        // The reference: the encoder actually in use, at the top announced rate, measured the same way (libopus restricted
        // low delay through ffmpeg; with --opus-encoder=audiotoolbox, Apple's through afconvert, and libopus beside it).
        const top = (cap.audioModes || []).find(m => m.mode === 'opus')?.kbps ?? 256;
        const enc = encoderInUse;
        fid.reference = encoderReference(enc, top, tmp);
        if (fid.reference.error && enc === 'audiotoolbox') fid.reference = { ...encoderReference('libopus', top, tmp), note: `AudioToolbox unavailable (${fid.reference.error}): libopus instead` };
        if (enc === 'audiotoolbox') fid.libopusReference = encoderReference('libopus', top, tmp);
        if (fid.reference.snrDb != null && fid.medianDb != null) fid.vsReferenceDb = r1(fid.medianDb - fid.reference.snrDb);
      }
      report.opusChunksDecoded = true;
    }
    fid.kbpsPerSecond = secs.filter(e => e.opusPackets >= 50).map(e => ({ s: e.s, kbps: e.opusKbps }));
    const kb = fid.kbpsPerSecond.map(e => e.kbps);
    fid.kbps = kb.length ? { min: minOf(kb), p50: percentile(kb, 50), max: maxOf(kb) } : null;
    report.opus = fid;
    if (!dec.error) {
      const pcm = dec.pcm;
      opusChunks.pcm = pcm;
    }
  }

  // ------------------------------------------------------------------ playout
  // The client plays in priority mode once the host confirms it (audio-mode with priority); old hosts never do.
  const priority = opts.playoutMode ? opts.playoutMode === 'priority' : (cap.audioModes || []).some(m => m.priority === true);
  const factory = await playoutFactory(playout, { priority });
  report.playoutKind = factory.kind;
  const real = p => {
    if (p.codec === 1 && p.payload) {
      const v = decodePcm24(p.payload), left = new Float32Array(FRAMES), right = new Float32Array(FRAMES);
      for (let i = 0; i < FRAMES; i++) { left[i] = v[2 * i] / 8388608; right[i] = v[2 * i + 1] / 8388608; }
      return { left, right };
    }
    if (p.codec === 0 && opusChunks?.pcm) {
      const j = opusChunks.get(p);
      const left = new Float32Array(FRAMES), right = new Float32Array(FRAMES);
      if (j !== undefined) for (let i = 0; i < FRAMES; i++) { left[i] = opusChunks.pcm[2 * (j * FRAMES + i)] || 0; right[i] = opusChunks.pcm[2 * (j * FRAMES + i) + 1] || 0; }
      return { left, right };
    }
    return null;
  };
  const haveReal = music && (audio.some(p => p.codec === 1) || opusChunks?.pcm);
  // A switch from lossless to Opus (too little bandwidth): what happens after it is judged on its own.
  const firstMode = (cap.audioModes || [])[0];
  const sw = (cap.audioModes || []).find((m, i) => i > 0 && m.mode === 'opus' && (cap.audioModes[i - 1].mode === 'pcm24' || m.reason === 'bandwidth'))
    || (firstMode?.mode === 'opus' && firstMode.reason === 'bandwidth' && cap.meta?.request?.mode === 'pcm24' ? firstMode : null);
  if (sw) report.switchToOpus = { atMs: r1(sw.at - audio[0].at), kbps: sw.kbps, reason: sw.reason ?? null };
  report.playout = [];
  for (const ppm of ppms) {
    const res = simulatePlayout({ packets: audio, ppm, make: factory.make, isSound, silentCount, real: haveReal ? real : null, expected: haveReal ? expected : null, shift, fromMs: sw ? sw.at - audio[0].at : null });
    report.playout.push(res);
  }
  // The network's share alone: each packet re-timed as if the source had produced it exactly every 10 ms (its host
  // stamp's lateness taken off its arrival, never overtaking the one before), so a late source isn't blamed on the
  // network. Only where the source's own timing wobbles (today's tone timer).
  if (stampDevMax > 1) {
    const h0 = percentile(audio.map(p => p.hostUs / 1000 - p.k * 10), 50);
    let prev = -Infinity;
    const retimed = audio.map(p => { const at = Math.max(prev, p.at - (p.hostUs / 1000 - p.k * 10 - h0)); prev = at; return { ...p, at }; });
    report.playoutNetworkOnly = ppms.map(ppm => {
      const r = simulatePlayout({ packets: retimed, ppm, make: factory.make, isSound, silentCount });
      return { ppm, all: r.all, steady: r.steady, bufferDelayMs: r.bufferDelayMs, playout: r.playout };
    });
  }

  // ------------------------------------------------------------------ video
  const v = cap.video || [];
  if (v.length || cap.stats?.length) {
    const t0 = audio[0].at;
    const fpsBySec = new Map();
    for (const f of v) { const s = Math.floor((f.at - t0) / 1000); const e = fpsBySec.get(s) || [0, 0]; e[0]++; e[1] += f.bytes; fpsBySec.set(s, e); }
    const last = Math.floor((Math.max(audio.at(-1).at, v.at(-1)?.at ?? 0) - t0) / 1000);
    const rows = [];
    for (let s = 2; s < last; s++) { const e = fpsBySec.get(s) || [0, 0]; rows.push({ fps: e[0], kbps: e[1] * 8 / 1000 }); }
    let maxGap = 0;
    for (let i = 1; i < v.length; i++) if (v[i].at - t0 > 2000) maxGap = Math.max(maxGap, v[i].at - v[i - 1].at);
    const steadyStats = (cap.stats || []).filter(x => x.at - t0 > 2000);
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    report.video = {
      frames: v.length, keyframes: v.filter(f => f.key).length,
      fps: r1(mean(rows.map(r => r.fps))), kbps: Math.round(mean(rows.map(r => r.kbps)) ?? 0),
      hostTargetKbps: Math.round(mean(steadyStats.map(x => x.targetKbps)) ?? 0), hostTargetMinKbps: steadyStats.length ? Math.min(...steadyStats.map(x => x.targetKbps)) : null,
      hostFrameRttMs: r1(mean(steadyStats.map(x => x.frameRttMs))), maxGapMs: Math.round(maxGap),
      resolution: cap.configs?.at(-1) ? `${cap.configs.at(-1).width}x${cap.configs.at(-1).height}` : null,
    };
  }
  if (cap.proxy) report.proxy = cap.proxy;
  report.notices = cap.notices;

  // ------------------------------------------------------------------ verdict
  report.verdict = verdict(report, { profile, maxDelayP95, priority, cap });
  return report;
}

/** COMMON's pass criteria (as revised after the baseline) for what was asked; [] = pass. */
export const DELAY_BOUNDS = { lan: 150, wifi: 150, remote: 150, tight: 250, 'too-tight': 250, cellular: 600 };
export function verdict(rep, { profile, maxDelayP95, priority, cap }) {
  const fails = [];
  const req = cap.meta?.request || {};
  const wantPcm = req.mode === 'pcm24';
  // Judged by what was asked for: priority asked but never confirmed by the host is a failure, not "standard".
  if (req.priority !== true && !priority) return { kind: 'standard (priority off)', fails: [], note: 'no pass criteria for priority off (today\'s behaviour)' };
  if (!priority) fails.push('the host never confirmed priority (no audio-mode with priority: true): the client plays it as standard');
  const kind = wantPcm ? 'priority + lossless' : 'priority + compressed';
  // Lossless on too-tight can't fit: there the switch must be announced, and only what follows it is judged.
  const fallback = wantPcm && rep.switchToOpus;
  const bound = maxDelayP95 ?? DELAY_BOUNDS[profile] ?? 250;
  const delayRule = !(wantPcm && profile === 'too-tight');
  // Cellular's 400 ms stalls can't be bridged without ~480 ms buffered: the playout may learn them, with at most two
  // underruns, each concealed, all in the first 45 s, and none after.
  const learns = profile === 'cellular';
  if (rep.wire.missing) fails.push(`${rep.wire.missing} packets never arrived (${rep.wire.gaps} holes): priority must never drop`);
  const modes = cap.audioModes || [];
  if (!modes.length) fails.push('no audio-mode message (the host ignored the request)');
  if (wantPcm && profile === 'too-tight' && !rep.switchToOpus) fails.push('too-tight with lossless: no announced switch to compressed');
  for (const p of rep.playout) {
    const s = fallback ? p.after : p.steady, tag = `at ${p.ppm > 0 ? '+' : ''}${p.ppm} ppm`, when = fallback ? `after the switch to Opus (${(rep.switchToOpus.atMs / 1000).toFixed(1)} s)` : 'after the first second';
    if (learns && !fallback) {
      const late = p.late || {}, ev = (p.events || []).filter(e => e.type === 'underrun' && e.steady);
      if (s.underruns > 2) fails.push(`${tag}: ${s.underruns} underruns (${s.underrunMs} ms): at most 2 while it learns the stalls`);
      if (late.underruns) fails.push(`${tag}: ${late.underruns} underruns (${late.underrunMs} ms) after the first ${late.fromMs / 1000} s`);
      if (late.concealedMs) fails.push(`${tag}: ${late.concealedMs} ms concealed after the first ${late.fromMs / 1000} s`);
      const bare = ev.filter(e => !e.concealed);
      if (bare.length) fails.push(`${tag}: ${bare.length} underrun(s) cut off without a fade (not concealed)`);
    } else {
      if (s.underruns) fails.push(`${tag}: ${s.underruns} underruns (${s.underrunMs} ms) ${when}`);
      if (s.concealedMs) fails.push(`${tag}: ${s.concealedMs} ms concealed ${when}`);
    }
    if (s.droppedSound) fails.push(`${tag}: ${s.droppedSound} samples dropped inside sound ${when}`);
    if (s.insertedSound) fails.push(`${tag}: ${s.insertedSound} samples inserted inside sound ${when}`);
    if (delayRule && (!p.bufferDelayMs || p.bufferDelayMs.p95 > bound)) fails.push(`${tag}: buffer delay p95 ${p.bufferDelayMs?.p95} ms > ${bound} ms`);
    if (p.exact && p.exact.mismatched) fails.push(`${tag}: ${p.exact.mismatched} of ${p.exact.checked} played samples not bit-exact${p.exact.resampled ? ` (${p.exact.resampled} of them resampled)` : ''}`);
  }
  const usedOpus = (rep.wire.codecs.opus || 0) > 0, usedPcm = (rep.wire.codecs.pcm24 || 0) > 0;
  if (wantPcm) {
    if (!usedPcm) fails.push('no lossless (pcm24) packets');
    if (rep.lossless && (rep.lossless.samplesWrong || rep.lossless.badSize || rep.lossless.silencePacketsWrong)) fails.push(`lossless on the wire: ${rep.lossless.samplesWrong} samples wrong, ${rep.lossless.badSize} bad sizes, ${rep.lossless.silencePacketsWrong} silence packets wrong`);
    if (rep.alignment && rep.alignment.verified === false) fails.push('alignment not verified by exact match');
    if (usedOpus) {
      const firstOpus = cap.audio.find(p => p.codec === 0);
      const told = modes.find(m => m.mode === 'opus' && m.at <= firstOpus.at + 1);
      if (!told) fails.push('switched to Opus without announcing it (audio-mode) first');
      else if (told.reason !== 'bandwidth') fails.push(`switch to Opus announced with reason "${told.reason}", not "bandwidth"`);
    }
  }
  if (rep.silencePackets?.wrong) fails.push(`${rep.silencePackets.wrong} silence packets where the source wasn't silent (or a frame count other than 480)`);
  if (usedOpus && rep.opus) {
    const o = rep.opus;
    if (o.error) fails.push(`Opus decode failed: ${o.error}`);
    if (o.lengthMismatch) fails.push(`Opus decoded ${o.lengthMismatch.got} frames, expected ${o.lengthMismatch.want}`);
    if (o.perSecond?.length) {
      // It holds its level: each second within 3 dB of the median of the seconds at the same announced rate...
      const byLevel = new Map();
      for (const x of o.perSecond) { const a = byLevel.get(x.kbps) || []; a.push(x.db); byLevel.set(x.kbps, a); }
      for (const [kbps, dbs] of byLevel) {
        const med = percentile(dbs, 50), low = dbs.filter(d => d < med - 3);
        if (low.length) fails.push(`Opus fidelity at ${kbps ?? '?'} kbps fell more than 3 dB below its median (${r1(med)} dB) in ${low.length} second(s), worst ${minOf(dbs)} dB`);
      }
      // ...and at the top rate, the level of the encoder actually in use (measured the same way): no second 3 dB under it.
      const top = modes.find(m => m.mode === 'opus')?.kbps;
      const ref = o.reference?.snrDb;
      if (ref != null && top != null && o.reference.kbps === top) {
        const under = o.perSecond.filter(x => (x.kbps ?? top) === top && x.db < ref - 3);
        if (under.length) fails.push(`Opus fidelity more than 3 dB under ${o.reference.encoder}'s own level at ${top} kbps (${ref} dB) in ${under.length} second(s), worst ${minOf(under.map(x => x.db))} dB`);
      }
      const steps = new Set(modes.filter(m => m.mode === 'opus').map(m => m.kbps)).size - 1;
      if (steps > 0 && profile !== 'too-tight') fails.push(`the Opus rate stepped down (${modes.filter(m => m.mode === 'opus').map(m => m.kbps).join(' -> ')} kbps) on ${profile}, where the top rate fits`);
    }
    if (o.decoderDelay?.warning) fails.push(`Opus decoder delay: ${o.decoderDelay.warning}`);
    // Every rate the stream really ran at was announced: a second well under the rate announced for it is not.
    const unannounced = (o.kbpsPerSecond || []).filter(x => { const lvl = o.perSecond?.find(y => y.s === x.s)?.kbps; return lvl && x.kbps < 0.6 * lvl; });
    if (unannounced.length) fails.push(`Opus ran under 60% of its announced rate in ${unannounced.length} second(s) (an unannounced step?)`);
  }
  if (rep.closedEarlyAtMs) fails.push(`the session ended early (${(rep.closedEarlyAtMs / 1000).toFixed(1)} s)`);
  if (rep.video && (!rep.video.frames || rep.video.maxGapMs > 6000)) fails.push(`video stopped flowing (${rep.video.frames} frames, longest gap ${rep.video.maxGapMs} ms)`);
  return { kind, delayBoundMs: delayRule ? bound : null, learnsStalls: learns || undefined, fails };
}

/**
 * The drift criteria (60 simulated minutes at each ppm, a perfect network): continuous sound (no digital silence) —
 * no underruns, nothing dropped or inserted inside sound, the slow resampler active under 10% of the time; music with
 * silence packets — no underruns, nothing touched inside sound. [] = pass.
 */
export function driftVerdict(r) {
  const fails = [];
  for (const x of r.results) {
    const s = x.steady, tag = `${r.signal} at ${x.ppm > 0 ? '+' : ''}${x.ppm} ppm`;
    if (s.underruns) fails.push(`${tag}: ${s.underruns} underruns (${s.underrunMs} ms)`);
    if (s.droppedSound || s.insertedSound) fails.push(`${tag}: ${s.droppedSound} samples dropped / ${s.insertedSound} inserted inside sound`);
    if (r.signal === 'continuous') {
      const share = s.resampledMs / (r.minutes * 60000);
      if (share >= 0.1) fails.push(`${tag}: the resampler ran ${(share * 100).toFixed(1)}% of the time (under 10% allowed)`);
    }
  }
  return fails;
}

// ================================================================================================ drift alone
/** A perfect network (a packet every 10 ms, 2 ms ±0.5 ms), `minutes` long, through the playout at each ppm. */
export async function driftOnly({ minutes = 60, ppms = [80, -80], playout = 'today', signal = 'continuous', priority = null } = {}) {
  // (playout.js plays priority sessions in priority mode: the music with silence packets, or any signal when asked)
  const factory = await playoutFactory(playout, { priority: priority ?? (signal === 'music-priority' || playout === 'module') });
  const rand = (() => { let a = 12345; return () => ((a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 4294967296); })();
  const n = minutes * 6000;
  const packets = [];
  for (let k = 0; k < n; k++) {
    // music-opus: today's host sends nothing after 200 ms of silence (packets 320-399 of each 400).
    if (signal === 'music-opus' && k % 400 >= 320) continue;
    const codec = signal === 'music-priority' && k % 400 >= 300 ? 2 : 0;
    packets.push({ k, seq: k + 1, codec, hostUs: k * 10000, at: 2 + k * 10 + rand() - 0.5 });
  }
  const music = signal !== 'continuous';
  const out = [];
  for (const ppm of ppms) {
    const r = simulatePlayout({ packets, ppm, make: factory.make, isSound: music ? musicIsSound : () => true, silentCount: music ? musicSilentCount : () => 0, maxEvents: 40 });
    out.push({ ppm, all: r.all, steady: r.steady, bufferDelayMs: r.bufferDelayAllMs, playout: r.playout, events: r.events.slice(0, 12) });
  }
  return { minutes, signal, playoutKind: factory.kind, results: out };
}

// ================================================================================================ the live capture
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startNetem({ port, target, down }) {
  const child = fork(join(HERE, 'netem.mjs'), [`--listen=${port}`, `--target=${target}`,
    `--rate-kbps=${down.rateKbps}`, `--delay=${down.delayMs}`, `--jitter=${down.jitterMs}`, `--jitter-period=${down.jitterPeriodMs}`,
    `--buf=${down.bufMs}`, `--stall=${down.stallMs}`, `--stall-every=${down.stallEveryMs}`, `--seed=${down.seed}`], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const ready = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('netem did not start')), 5000);
    child.on('message', m => { if (m.t === 'ready') { clearTimeout(t); resolve(m); } });
    child.on('exit', c => reject(new Error(`netem exited (${c})`)));
  });
  return {
    pid: child.pid, port: ready.port, down: ready.down, up: ready.up,
    stats: () => new Promise(resolve => { const t = setTimeout(() => resolve(null), 2000); child.once('message', m => { if (m.t === 'stats') { clearTimeout(t); resolve(m.stats); } }); child.send({ t: 'stats' }); }),
    stop: async () => {
      if (child.exitCode !== null) return;
      const gone = new Promise(r => child.once('exit', r));
      child.send({ t: 'stop' });
      await Promise.race([gone, sleep(3000)]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await gone; }
    },
  };
}

async function capture(o) {
  const base = o.url.replace(/\/$/, '');
  const json = async (url, init = {}) => {
    const r = await fetch(url.startsWith('http') ? url : base + url, { ...init, headers: { 'Content-Type': 'application/json' } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  let st;
  for (let i = 0; i < 30; i++) { st = (await json('/api/admin/status')).body; if (st.relay?.state === 'online') break; await sleep(1000); }
  if (st.relay?.state !== 'online') throw new Error(`host not connected to its relay: ${JSON.stringify(st.relay)}`);
  const info = (await json('/api/info')).body;
  const made = (await json('/api/admin/support/code', { method: 'POST' })).body;
  if (!made.code || !made.link) throw new Error(`no guest code: ${JSON.stringify(made)}`);
  const relay = new URL(made.link);
  const netem = await startNetem({ port: o.proxyPort, target: `${relay.hostname}:${relay.port || 80}`, down: o.down });
  const via = `ws://127.0.0.1:${netem.port}`;
  const cap = { audio: [], audioModes: [], stats: [], video: [], configs: [], pongs: [], notices: [], meta: {} };
  try {
    // The guest code, through the network, accepted by "the person here" (the loopback API).
    const welcome0 = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${via}/c/${made.code.slice(0, 4)}/ws`);
      const t = setTimeout(() => { ws.close(); reject(new Error('not accepted in 30 s')); }, 30000);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', support: { code: made.code, name: 'audio-check' }, client: { name: 'audio-check', platform: 'node' } }));
      ws.onmessage = ev => { if (typeof ev.data === 'string') { const m = JSON.parse(ev.data); if (m.t === 'welcome' || m.t === 'error') { clearTimeout(t); ws.close(); resolve(m); } } };
      ws.onerror = () => { };
      (async () => {
        for (let i = 0; i < 100; i++) {
          await sleep(250);
          const r = (await json('/api/admin/status')).body.support?.requests?.find(q => q.name === 'audio-check');
          if (r) { await json(`/api/admin/support/requests/${r.id}`, { method: 'POST', body: JSON.stringify({ accept: true, viewOnly: true, files: false, clipboard: false }) }); return; }
        }
      })();
    });
    if (welcome0.t !== 'welcome') throw new Error(`not accepted: ${JSON.stringify(welcome0)}`);

    // The session.
    const ws = new WebSocket(`${via}${welcome0.relayPath}/ws`);
    ws.binaryType = 'arraybuffer';
    let t0 = null, assembly = null, pingId = 0, startedAt = null;
    const audioFields = {};
    if (o.mode) audioFields.mode = o.mode;
    if (o.priority !== undefined) audioFields.priority = o.priority;
    cap.meta.request = { mode: o.mode, priority: o.priority, inStart: o.audioInStart, maxFps: o.maxFps };
    const closed = new Promise(r => { ws.onclose = e => r(e); });
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: welcome0.resumeToken, client: { name: 'audio-check', platform: 'node', ua: `node ${process.version}` } }));
    ws.onerror = () => { };
    ws.onmessage = ev => {
      const now = performance.now();
      if (typeof ev.data === 'string') {
        const m = JSON.parse(ev.data);
        switch (m.t) {
          case 'welcome': {
            t0 = now;
            cap.meta.host = m.host;
            const start = { t: 'start', monitor: m.monitors?.[0]?.id, maxFps: o.maxFps, maxWidth: 0, maxHeight: 0, audio: !!o.audioInStart };
            if (o.mode) start.audioMode = o.mode;
            if (o.priority !== undefined) start.audioPriority = o.priority;
            ws.send(JSON.stringify(start));
            if (!o.audioInStart) ws.send(JSON.stringify({ t: 'audio', enabled: true, ...audioFields }));
            startedAt = now;
            break;
          }
          case 'audio-mode': cap.audioModes.push({ at: now, ...m }); break;
          case 'stats': cap.stats.push({ at: now, ...m }); break;
          case 'video-config': cap.configs.push({ at: now, width: m.width, height: m.height, epoch: m.epoch, encoder: m.encoder }); break;
          case 'pong': cap.pongs.push({ sent: m.ts, rtt: now - m.ts, host: m.host }); break;
          case 'notice': case 'error': case 'status': case 'permissions': cap.notices.push({ at: now, ...m }); break;
        }
        return;
      }
      const v = new DataView(ev.data);
      const type = v.getUint8(0);
      if (type === 0x03) {
        const p = parseAudioPacket(ev.data);
        cap.audio.push({ at: now, seq: p.seq, codec: p.codec, hostUs: p.hostUs, bytes: p.payload.length, payload: p.payload });
      } else if (type === 0x01) {
        // As web/js/connection.js: reassemble, and ack as soon as the last fragment is in.
        const flags = v.getUint8(1), frameId = v.getUint32(4, true), total = v.getInt32(8, true), offset = v.getInt32(12, true);
        if (flags & 2) assembly = { frameId, total, got: 0, key: !!(flags & 1), firstAt: now };
        if (!assembly || assembly.frameId !== frameId) return;
        assembly.got += ev.data.byteLength - 28;
        void offset;
        if (flags & 4) {
          const a = assembly;
          assembly = null;
          const ack = new ArrayBuffer(5), av = new DataView(ack);
          av.setUint8(0, 0x15);
          av.setUint32(1, a.frameId, true);
          if (ws.readyState === 1) ws.send(ack);
          cap.video.push({ at: now, bytes: a.total, key: a.key, recvMs: r1(now - a.firstAt) });
        }
      }
    };
    const pinger = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', id: ++pingId, ts: performance.now() })); }, 1000);
    const deadline = performance.now() + 15000;
    while (startedAt === null && performance.now() < deadline) await sleep(50);
    if (startedAt === null) throw new Error('no welcome on the session');
    // (A session the host ends early is reported, not waited out.)
    const until = startedAt + o.seconds * 1000;
    while (performance.now() < until && ws.readyState === 1) await sleep(200);
    if (ws.readyState !== 1) cap.meta.closedEarlyAtMs = Math.round(performance.now() - t0);
    clearInterval(pinger);
    cap.proxy = await netem.stats();
    ws.close(1000, 'bye');
    await Promise.race([closed, sleep(2000)]);
    // Times relative to the welcome.
    for (const list of [cap.audio, cap.audioModes, cap.stats, cap.video, cap.configs, cap.notices]) for (const x of list) x.at = +(x.at - t0).toFixed(3);
    for (const p of cap.pongs) p.sent = +(p.sent - t0).toFixed(3);
    cap.meta.seconds = o.seconds;
    cap.meta.network = { profile: o.profile || 'custom', down: netem.down, up: netem.up };
    cap.meta.info = info.host;
  } finally {
    // End this guest session for good (only ours: other sessions on the host are left alone).
    try {
      const mine = ((await json('/api/admin/status')).body.sessions || []).filter(x => x.device === 'audio-check');
      for (const x of mine) await json(`/api/admin/sessions/${x.id}/disconnect`, { method: 'POST' });
    } catch { }
    await netem.stop();
  }
  return cap;
}

// ================================================================================================ save / replay
export function saveCapture(cap, prefix) {
  const offsets = [];
  let off = 0;
  for (const p of cap.audio) { offsets.push(off); off += p.payload ? p.payload.length : 0; }
  const bin = Buffer.alloc(off);
  cap.audio.forEach((p, i) => { if (p.payload) Buffer.from(p.payload.buffer, p.payload.byteOffset, p.payload.byteLength).copy(bin, offsets[i]); });
  writeFileSync(`${prefix}.bin`, bin);
  const { audio, ...rest } = cap;
  writeFileSync(`${prefix}.json`, JSON.stringify({ ...rest, audio: audio.map(p => ({ at: p.at, seq: p.seq, codec: p.codec, hostUs: p.hostUs, bytes: p.bytes })) }));
}

export function loadCapture(prefix) {
  const cap = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'));
  const bin = readFileSync(`${prefix}.bin`);
  let off = 0;
  for (const p of cap.audio) { p.payload = new Uint8Array(bin.buffer, bin.byteOffset + off, p.bytes); off += p.bytes; }
  return cap;
}

// ================================================================================================ report
function summary(rep) {
  const L = [];
  const req = rep.request || {};
  L.push(`audio-check ${rep.label ? `[${rep.label}] ` : ''}${rep.network?.profile || rep.profile || ''}: host ${rep.host?.os || '?'} ${rep.host?.version || ''}, asked mode=${req.mode ?? '(none)'} priority=${req.priority ?? '(none)'}, playout ${rep.playoutKind}`);
  if (rep.error) { L.push(`  ERROR ${rep.error}`); return L.join('\n'); }
  if (rep.closedEarlyAtMs) L.push(`  NOTE the host closed the session early, at ${(rep.closedEarlyAtMs / 1000).toFixed(1)} s`);
  const w = rep.wire;
  L.push(`  wire: ${w.packets} packets ${JSON.stringify(w.codecs)}, ${w.missing} missing in ${w.gaps} holes, transport delay p50/p95/max ${w.transportDelayMs?.p50}/${w.transportDelayMs?.p95}/${w.transportDelayMs?.max} ms, host stamps ±${w.hostStampJitterMs.p99} ms (p99), ${w.hostLateStamps} late by >5 ms, rate ${w.hostRatePpm} ppm (host clock) / ${w.arrivalRatePpm} ppm (arrivals)${w.idealPlayout ? `; an ideal fixed-delay playout needs ${w.idealPlayout.neverDryBufferMs} ms (buffer delay p50/p95 ${w.idealPlayout.bufferDelayP50}/${w.idealPlayout.bufferDelayP95} ms; network alone ${w.idealPlayout.networkOnly.neverDryBufferMs} ms, p95 ${w.idealPlayout.networkOnly.bufferDelayP95})` : ''}`);
  if (w.audioModes?.length) L.push(`  audio-mode: ${w.audioModes.map(m => `${m.mode}${m.priority ? '+priority' : ''} ${m.kbps ?? ''}kbps${m.reason ? ` (${m.reason})` : ''} at ${(m.at / 1000).toFixed(1)} s`).join(' -> ')}`);
  if (rep.lossless) L.push(`  lossless on the wire: ${rep.lossless.samplesChecked - rep.lossless.samplesWrong}/${rep.lossless.samplesChecked} samples exact, ${rep.lossless.silencePacketsWrong} bad silence packets (alignment ${rep.alignment?.verified ? 'verified' : 'NOT verified'})`);
  if (rep.opus) {
    const o = rep.opus, d = o.decoderDelay, ref = o.reference, lo = o.libopusReference;
    const bass = b => (b ? Object.entries(b).map(([f, v]) => `${f.replace('Hz', '')} ${v}`).join(' / ') : '-');
    L.push(`  opus: ${o.packets} packets ${JSON.stringify(o.modes)}, ${o.kbps ? `${o.kbps.min}-${o.kbps.max} kbps (p50 ${o.kbps.p50})` : ''}${o.error ? ` ERROR ${o.error}` : ''}`);
    if (o.medianDb != null) {
      L.push(`    fidelity: SNR median ${o.medianDb} dB, worst second ${o.minDb} dB, first packet after silence ${o.firstPacketAfterSilenceSnrDb} dB; coding SNR (filtering factored out) ${o.codingSnrDb} dB; bass level dB at 20/40/60/100/220 Hz: ${bass(o.bassDb)}`);
      L.push(`    decoder delay ${d.used} frames (${d.source}; correlation ${d.correlation}, a free search peaks at ${d.check.correlationPeakAt}${d.warning ? `; WARNING ${d.warning}` : ''})${rep.alignment?.refined ? `; alignment ${rep.alignment.refined.note}` : ''}`);
      if (ref) L.push(`    encoder in use, ${ref.encoder} at ${ref.kbps} kbps (${ref.actualKbps} actual): ${ref.error ? `ERROR ${ref.error}` : `SNR ${ref.snrDb} dB, coding SNR ${ref.codingSnrDb} dB, bass ${bass(ref.bassDb)}`}${ref.note ? ` (${ref.note})` : ''}; this stream ${o.vsReferenceDb >= 0 ? '+' : ''}${o.vsReferenceDb} dB against it`);
      if (lo) L.push(`    libopus at ${lo.kbps} kbps for comparison (vendoring it): ${lo.error ? `ERROR ${lo.error}` : `SNR ${lo.snrDb} dB, coding SNR ${lo.codingSnrDb} dB, bass ${bass(lo.bassDb)}`}`);
    }
  }

  for (const p of rep.playout || []) {
    const s = p.steady, a = p.all, d = p.bufferDelayMs;
    L.push(`  playout ${p.ppm > 0 ? '+' : ''}${p.ppm} ppm: underruns ${s.underruns} (${s.underrunMs} ms) [all ${a.underruns}/${a.underrunMs} ms], dropped in sound ${s.droppedSound} [all ${a.droppedSound}], inserted in sound ${s.insertedSound}, silence dropped/inserted ${s.droppedSilence}/${s.insertedSilence}, resampled ${s.resampledMs} ms [all ${a.resampledMs}], modified ${s.modifiedMs} ms, concealed ${s.concealedMs} ms, buffer delay p50/p95/max ${d?.p50}/${d?.p95}/${d?.max} ms${p.exact ? `, bit-exact ${p.exact.checked - p.exact.mismatched}/${p.exact.checked}${p.exact.resampled ? ` (${p.exact.resampled} resampled)` : ''}` : ''}${p.snr ? `, SNR median ${p.snr.medianDb} dB (worst ${p.snr.minDb})` : ''}; playout says ${JSON.stringify(p.playout)}`);
  }
  for (const p of rep.playoutNetworkOnly || []) {
    const s = p.steady, d = p.bufferDelayMs;
    L.push(`  network only (source re-timed to exact 10 ms) ${p.ppm > 0 ? '+' : ''}${p.ppm} ppm: underruns ${s.underruns} (${s.underrunMs} ms), dropped in sound ${s.droppedSound}, buffer delay p50/p95/max ${d?.p50}/${d?.p95}/${d?.max} ms`);
  }
  if (rep.video) L.push(`  video: ${rep.video.frames} frames (${rep.video.keyframes} key) ${rep.video.resolution}, ${rep.video.fps} fps, ${rep.video.kbps} kbps, host target ${rep.video.hostTargetKbps} kbps (min ${rep.video.hostTargetMinKbps}), frame RTT ${rep.video.hostFrameRttMs} ms, longest gap ${rep.video.maxGapMs} ms`);
  if (rep.proxy) L.push(`  network: down ${(rep.proxy.down.bytesOut / 1e6).toFixed(1)} MB, bottleneck max ${(rep.proxy.down.maxQueued / 1024).toFixed(0)} KiB of ${rep.proxy.capacityBytes ? (rep.proxy.capacityBytes / 1024).toFixed(0) : '∞'}, relay paused ${rep.proxy.down.pausedMs} ms (${rep.proxy.down.pauses}x), hold max ${rep.proxy.down.holdMaxMs} ms`);
  const v = rep.verdict;
  if (v) L.push(`  verdict (${v.kind}${v.delayBoundMs ? `, delay bound ${v.delayBoundMs} ms` : ''}): ${v.fails.length ? `FAIL\n    - ${v.fails.join('\n    - ')}` : (v.note || 'PASS')}`);
  return L.join('\n');
}

// ================================================================================================ main
async function main() {
  const arg = (name, def) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
  const has = name => process.argv.includes(`--${name}`);
  if (has('help') || has('h') || process.argv.includes('-h')) {
    // The usage is this file's header comment.
    const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    const end = lines.findIndex(l => !l.startsWith('//'));
    console.log(lines.slice(0, end).map(l => l.slice(3)).join('\n'));
    return 0;
  }
  const num = name => { const v = arg(name); return v === undefined ? undefined : Number(v); };
  const ppms = arg('ppm', '80,-80').split(',').filter(Boolean).map(Number);
  const out = arg('out', 'audio-check.json');
  const playout = arg('playout', 'auto');
  const tmp = mkdtempSync(join(tmpdir(), 'audio-check-'));
  try {
    if (has('drift')) {
      const res = [];
      const pm = arg('playout-mode');
      for (const signal of arg('signals', 'continuous,music-opus').split(',')) res.push(await driftOnly({ minutes: Number(arg('minutes', '60')), ppms, playout, signal, priority: pm ? pm === 'priority' : null }));
      let failed = 0;
      for (const r of res) r.verdict = driftVerdict(r);
      writeFileSync(out, JSON.stringify(res, null, 1));
      for (const r of res) {
        console.log(`drift alone, ${r.minutes} min, ${r.signal}, ${r.playoutKind}:`);
        for (const x of r.results) console.log(`  ${x.ppm > 0 ? '+' : ''}${x.ppm} ppm: underruns ${x.steady.underruns} (${x.steady.underrunMs} ms), dropped/inserted in sound ${x.steady.droppedSound}/${x.steady.insertedSound}, silence dropped/inserted ${x.steady.droppedSilence}/${x.steady.insertedSilence}, resampled ${(x.steady.resampledMs / 1000).toFixed(1)} s (${(x.steady.resampledMs / (r.minutes * 600)).toFixed(1)}%), buffer delay p50/p95/max ${x.bufferDelayMs?.p50}/${x.bufferDelayMs?.p95}/${x.bufferDelayMs?.max} ms; ${JSON.stringify(x.playout)}; first events ${JSON.stringify(x.events.slice(0, 4))}`);
        console.log(`  verdict: ${r.verdict.length ? `FAIL\n    - ${r.verdict.join('\n    - ')}` : 'PASS'}`);
        failed += r.verdict.length;
      }
      return arg('expect') === 'pass' && failed ? 1 : 0;
    }
    const profile = arg('profile');
    let cap;
    if (arg('replay')) cap = loadCapture(arg('replay'));
    else {
      const down = linkOptions(profile, {
        rateKbps: num('rate-kbps'), delayMs: num('delay'), jitterMs: num('jitter'), jitterPeriodMs: num('jitter-period'),
        bufMs: num('buf'), stallMs: num('stall'), stallEveryMs: num('stall-every'), seed: num('seed'),
      });
      const pr = arg('priority');
      cap = await capture({
        url: arg('url', 'http://127.0.0.1:17100'), proxyPort: Number(arg('proxy-port', '18801')), down, profile,
        seconds: Number(arg('seconds', '150')), mode: arg('mode'), priority: pr === undefined ? undefined : pr === 'on' || pr === 'true',
        audioInStart: has('audio-in-start'), maxFps: Number(arg('max-fps', '15')),
      });
      cap.meta.label = arg('label') ?? null;
      const save = arg('save', out.replace(/\.json$/, '') + '.capture');
      if (save !== 'none') saveCapture(cap, save);
    }
    const rep = await analyze(cap, { signal: arg('signal', 'music'), ppms, playout, playoutMode: arg('playout-mode'), profile: profile ?? cap.meta?.network?.profile, maxDelayP95: num('max-delay-p95'), opusDelay: num('opus-delay'), opusEncoder: arg('opus-encoder'), label: arg('label'), tmp });
    writeFileSync(out, JSON.stringify(rep, null, 1));
    console.log(summary(rep));
    console.log(`  (report: ${out})`);
    if (arg('expect') === 'pass' && rep.verdict?.fails?.length) return 1;
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code), e => { console.error(e); process.exit(2); });
}

export { PROFILES, summary };
