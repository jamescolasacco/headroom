// web/js/audio/playout.js in simulated time: packets arrive when a modelled network delivers them (on an output clock
// that can run off by ±ppm), the playout renders 128-frame quanta, and every output sample is checked.
//
// The test signal is an index: sound frame n plays L = 1/4 + (n mod 2^21) / 2^23, R = 1/4 + floor(n / 2^21) / 2^23
// (exact in float32, never 0), digital silence plays 0. So each output sample says which source frame it is: a jump
// over sound frames is sound dropped, a step back is sound repeated, zeros between consecutive sound frames are an
// underrun, a value between frames is resampling, anything else was altered (a fade).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Playout, decodePcm24, PLAYOUT_DEFAULTS } from '../web/js/audio/playout.js';

const W = 2097152, S = 1 / 8388608;
function dec(l, r) {
  const x = (l - 0.25) * 8388608, y = (r - 0.25) * 8388608;
  if (!(x >= 0 && x < W && y >= 0 && y < W) || !Number.isInteger(y)) return NaN;
  return x + y * W;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** The lab's music shape: 3 s of sound, 1 s of digital silence (packet-aligned). */
const music = k => k % 400 < 300;

/**
 * Arrival times (output frames) of packets 0..n-1: the host finishes packet k at (k + 1) x 10 ms on its clock, which
 * runs `ppm` fast against the output's; the network adds `delay(k, sendMs)` ms and keeps the order (TCP); a stall
 * holds everything sent during it until it ends, then the backlog arrives at the link's rate.
 */
function arrivals(n, { ppm = 0, delay = () => 1, stall = null, linkMs = 0.4 } = {}) {
  const out = new Float64Array(n);
  let last = -Infinity;
  for (let k = 0; k < n; k++) {
    const sent = (k + 1) * 10;
    let at = sent + delay(k, sent);
    if (stall) { const end = stall(at); if (end) at = Math.max(at, end); }
    at = Math.max(at, last + linkMs);
    last = at;
    out[k] = at * 48 / (1 + ppm * 1e-6);
  }
  return out;
}

/**
 * Plays packets arriving at `arr` through a Playout and follows the output. `kind(k)`: 'sound' | 'silence'.
 * `samples(k)` may supply a packet's samples (then index checks are skipped). Returns counts and the buffer's history.
 */
function run({ arr, kind = () => 'sound', codecOf = () => 1, opts = {}, samples = null, warmMs = 60000, onQuantum = null, holdOutput = null, quantum = 128, hashes = true }) {
  const events = [];
  const p = new Playout({ mode: 'priority', hashes, trace: e => { if (events.length < 100000) events.push(e); }, ...opts });
  const L = new Float32Array(quantum), R = new Float32Array(quantum);
  const n = arr.length, end = arr[n - 1]; // the stream just stops after its last packet: no tail to run dry
  const c = { droppedSound: 0, repeatedSound: 0, underrunFrames: 0, altered: 0, resampled: 0, nan: 0, played: 0, maxStep: 0 };
  const buf = [];
  let k = 0, prev = -1, zeros = 0, alt = 0, frames = 0, lastL = 0, lastR = 0;
  while (frames < end) {
    while (k < n && arr[k] <= frames) {
      if (kind(k) === 'silence') p.push({ seq: k + 1, timeUs: k * 10000, codec: 2, frames: 480 });
      else {
        let left, right;
        if (samples) ({ left, right } = samples(k));
        else {
          left = new Float32Array(480); right = new Float32Array(480);
          for (let i = 0, n = k * 480; i < 480; i++, n++) { left[i] = 0.25 + (n % W) * S; right[i] = 0.25 + Math.floor(n / W) * S; }
        }
        p.push({ seq: k + 1, timeUs: k * 10000, codec: codecOf(k), left, right });
      }
      k++;
    }
    if (holdOutput && holdOutput(frames)) { frames += quantum; continue; } // the output clock stands still
    p.render(L, R);
    for (let i = 0; i < quantum; i++) {
      const l = L[i], r = R[i];
      if (l !== l || r !== r) { c.nan++; continue; }
      if ((l !== 0 || r !== 0) && (lastL !== 0 || lastR !== 0)) c.maxStep = Math.max(c.maxStep, Math.abs(l - lastL), Math.abs(r - lastR)); // a click (onsets from silence are the signal's own)
      lastL = l; lastR = r;
      if (samples) continue;
      if (l === 0 && r === 0) { if (prev >= 0) zeros++; continue; }
      const x = dec(l, r);
      if (Number.isNaN(x)) { c.altered++; alt++; continue; }
      c.played++;
      if (!Number.isInteger(x)) c.resampled++;
      if (prev >= 0) {
        const step = x - prev;
        if (step > 1.5 + alt * 1.01) {
          for (let m = Math.floor(prev) + 1; m < Math.ceil(x); m++) if (kind(Math.floor(m / 480)) === 'sound') c.droppedSound++;
        } else if (step < 0.5) c.repeatedSound += Math.round(1 - step);
        else if (zeros) c.underrunFrames += zeros;
      }
      prev = x; zeros = 0; alt = 0;
    }
    if (frames >= warmMs * 48) buf.push(p.bufferedFrames / 48);
    onQuantum?.(p, frames);
    frames += quantum;
  }
  const sorted = Float64Array.from(buf).sort();
  const pct = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : NaN;
  return { p, st: p.stats(), c, events, buf: { p50: pct(0.5), p95: pct(0.95), min: sorted[0], max: sorted[sorted.length - 1] } };
}

const none = r => {
  assert.equal(r.c.nan, 0, 'no NaN');
  assert.equal(r.c.droppedSound, 0, 'no sound dropped');
  assert.equal(r.c.repeatedSound, 0, 'no sound repeated');
};

// ------------------------------------------------------------------------------------------- the basics

test('decodePcm24: signed 24-bit little-endian stereo, value / 2^23, exact', () => {
  const vals = [0, 1, -1, 8388607, -8388608, 123456, -654321, 4194304];
  const b = new Uint8Array(vals.length * 3);
  vals.forEach((v, i) => { const u = v & 0xffffff; b[i * 3] = u & 255; b[i * 3 + 1] = (u >> 8) & 255; b[i * 3 + 2] = u >> 16; });
  const { left, right, frames } = decodePcm24(b);
  assert.equal(frames, 4);
  assert.deepEqual([...left], [0, -1, -8388608, -654321].map(v => v / 8388608));
  assert.deepEqual([...right], [1, 8388607, 123456, 4194304].map(v => v / 8388608));
  assert.equal(left[2], -1);
  assert.deepEqual(Object.keys(PLAYOUT_DEFAULTS).length > 10, true);
});

test('priority: a good network plays every sound sample bit-exactly, holding the 120 ms floor, adjusting only inside silence', () => {
  const r = rng(1);
  const arr = arrivals(12000, { delay: () => 2 + 6 * r() });
  const res = run({ arr, kind: k => (music(k) ? 'sound' : 'silence') });
  none(res);
  assert.equal(res.st.underruns, 0);
  assert.equal(res.c.underrunFrames, 0);
  assert.equal(res.c.altered + res.c.resampled, 0, 'every sound sample exact');
  assert.equal(res.st.hashes.consumed, res.st.hashes.played, 'what left the buffer is what played');
  assert.equal(res.st.hashes.consumedFrames, res.st.hashes.playedFrames);
  assert.ok(res.buf.min >= 105 && res.buf.p95 <= 150, `the floor holds, within the 150 ms bound: ${res.buf.min}-${res.buf.p95} ms (p95)`);
  const adj = res.events.filter(e => e.type === 'drop' || e.type === 'insert');
  assert.ok(adj.every(e => !music(Math.floor((e.host - 480) / 480))), 'adjusted only in silence');
});

// ------------------------------------------------------------------------------------------- clock drift

for (const ppm of [300, -300]) {
  test(`drift ${ppm > 0 ? '+' : ''}${ppm} ppm over 2 hours of music with a 1 s silence every 4 s: no underrun, nothing dropped or added inside sound, delay in band`, () => {
    const r = rng(ppm > 0 ? 7 : 8);
    const arr = arrivals(720000, { ppm, delay: () => 3 + 8 * r() });
    const res = run({ arr, kind: k => (music(k) ? 'sound' : 'silence'), hashes: false });
    none(res);
    assert.equal(res.st.underruns, 0);
    assert.equal(res.c.underrunFrames, 0);
    assert.equal(res.c.altered + res.c.resampled, 0, 'every sound sample exact (silence re-centres it all)');
    assert.equal(res.st.resampledMs, 0);
    assert.ok(Math.abs(res.st.driftPpm - ppm) < 5, `drift measured: ${res.st.driftPpm} ppm`);
    // 300 ppm for 2 h is 2.16 s of clock difference: all of it absorbed in silence.
    const moved = ppm > 0 ? res.st.droppedMs : res.st.insertedMs;
    assert.ok(moved > 2000, `${moved} ms re-centred in silence`);
    assert.ok(res.buf.min > 100 && res.buf.max < 150, `buffer stays in band (the 120 ms floor) after the first minute: ${res.buf.min}-${res.buf.max} ms`);
  });
}

test('30 minutes of sound without silence at +200 ppm: the slow resampler engages (counted), no underrun', () => {
  const r = rng(3);
  const arr = arrivals(180000, { ppm: 200, delay: () => 3 + 5 * r() });
  // A smooth signal (the index jumps every 2^21 frames, which a resampler rings across): 375 Hz and 1200 Hz tones.
  const tl = Float32Array.from({ length: 128 }, (_, i) => 0.4 * Math.sin(2 * Math.PI * i / 128));
  const tr = Float32Array.from({ length: 40 }, (_, i) => 0.3 * Math.sin(2 * Math.PI * i / 40));
  const smooth = k => {
    const left = new Float32Array(480), right = new Float32Array(480);
    for (let i = 0, n = k * 480; i < 480; i++, n++) { left[i] = tl[n % 128]; right[i] = tr[n % 40]; }
    return { left, right };
  };
  const res = run({ arr, samples: smooth });
  assert.equal(res.c.nan, 0);
  assert.equal(res.st.underruns, 0);
  assert.equal(res.st.skippedMs, 0);
  assert.equal(res.st.droppedMs + res.st.insertedMs, 0, 'no silence to adjust in');
  assert.ok(res.st.resampledMs > 60000, `resampled ${res.st.resampledMs} ms`);
  assert.ok(res.events.some(e => e.type === 'resample-start'));
  assert.ok(res.c.maxStep < 0.3 * 2 * Math.PI / 40 * 1.01, `no clicks (max step ${res.c.maxStep}, the 1200 Hz tone's own ${0.3 * 2 * Math.PI / 40})`);
  assert.ok(Math.abs(res.st.driftPpm - 200) < 5, `drift ${res.st.driftPpm}`);
  // The drift runs free within the band (60 ms over target), then a steady 1000 ppm correction to 15 ms over it and
  // a hand-back to bit-exact: at 200 ppm that's about a sixth of the time.
  assert.ok(res.buf.max - res.buf.min < 80, `buffer held within the band: ${res.buf.min}-${res.buf.max} ms`);
  assert.ok(res.st.resampledMs < 0.25 * 1800000, `resampling ${(res.st.resampledMs / 18000).toFixed(1)}% of the time`);
  assert.ok(res.events.filter(e => e.type === 'resample-stop').length >= 3, 'hands back to bit-exact between corrections');
});

test('the resampler is clean: >= 95 dB SNR at 1 kHz and 15 kHz while 731 ppm off', () => {
  for (const f of [1000, 15000]) {
    const amp = 0.5, w = 2 * Math.PI * f / 48000;
    const p = new Playout({ mode: 'priority', bandHighMs: -1e6, ratioSlewPpm: 1e6 });
    p._wantDev = () => 731e-6; // a fixed step, so the ideal output is known ...
    p._rsDone = () => false;   // ... for as long as it runs
    const q = 128, L = new Float32Array(q), R = new Float32Array(q);
    let sig = 0, err = 0, k = 0;
    for (let quantum = 0; quantum < 2000; quantum++) {
      while (k * 480 < (quantum + 60) * q) { // keep well fed
        const left = new Float32Array(480);
        for (let i = 0; i < 480; i++) left[i] = amp * Math.sin(w * (k * 480 + i));
        p.push({ seq: k + 1, codec: 1, left, right: left, arrival: 0 });
        k++;
      }
      const resampling = p.rs && p.ratioDev === 731e-6;
      const pos = p.rd + p.frac, step = 1 + p.ratioDev;
      p.render(L, R);
      if (!resampling || quantum < 400) continue;
      for (let i = 0; i < q; i++) {
        const ideal = amp * Math.sin(w * (pos + i * step));
        sig += ideal * ideal;
        err += (L[i] - ideal) ** 2;
      }
    }
    assert.ok(sig > 0, 'it resampled');
    const snr = 10 * Math.log10(sig / err);
    assert.ok(snr >= 95, `${f} Hz: ${snr.toFixed(1)} dB`);
  }
});

// ------------------------------------------------------------------------------------------- networks

const profiles = {
  // base ± jitter (ms); stalls as in COMMON-audio.md
  wifi: { delay: r => () => 3 + 30 * r(), p95: 150 },
  remote: { delay: r => () => 40 + 40 * r(), p95: 150 },
  tight: { delay: r => () => 20 + 10 * r() + (r() < 0.02 ? 50 * r() : 0), p95: 250 },
};
for (const [name, prof] of Object.entries(profiles)) {
  test(`${name}: zero underruns, nothing dropped or added inside sound, bit-exact, buffer p95 <= ${prof.p95} ms`, () => {
    const r = rng(name.length * 101);
    const arr = arrivals(18000, { delay: prof.delay(r) });
    const res = run({ arr, kind: k => (music(k) ? 'sound' : 'silence') });
    none(res);
    assert.equal(res.st.underruns, 0);
    assert.equal(res.c.underrunFrames, 0);
    assert.equal(res.c.altered + res.c.resampled, 0);
    assert.ok(res.buf.p95 <= prof.p95, `buffer p95 ${res.buf.p95} ms`);
  });
}

test('400 ms stalls after warm-up (cellular: 70 ms ± 40 ms): the first is concealed and raises the target; the rest play through', () => {
  const r = rng(99);
  const stall = at => { const x = at % 20000; return at > 30000 && x < 400 ? at - x + 400 : 0; }; // every 20 s from 40 s
  const arr = arrivals(18000, { delay: () => 70 + 80 * r(), stall, linkMs: 0.4 });
  const after = [];
  const res = run({ arr, kind: k => (music(k) ? 'sound' : 'silence'), onQuantum: (p, f) => { if (f % 48000 === 0) after.push([f / 48000, p.stats()]); } });
  none(res);
  const unders = res.events.filter(e => e.type === 'underrun');
  assert.ok(unders.length <= 1, `${unders.length} underruns`);
  if (unders.length) assert.ok(unders[0].out < 48000 * 42, 'only at the first stall');
  const before = after.find(([s]) => s === 39)[1], later = after.find(([s]) => s === 60)[1];
  assert.ok(later.targetMs > before.targetMs + 250, `target ${before.targetMs} -> ${later.targetMs} ms`);
  assert.ok(res.st.concealedMs < 400, `concealed ${res.st.concealedMs} ms`);
});

test('lossless the link can\'t carry, then the step down to Opus: the overload\'s lateness is shed, nothing touched in sound after it', () => {
  // 2896-byte PCM packets on a 2 Mb/s link: each takes 11.6 ms for 10 ms of sound, so it falls behind; at 4 s the host
  // switches to Opus (~640 B, 2.6 ms each) and the backlog drains.
  const n = 3000, arr = new Float64Array(n);
  let last = 0;
  for (let k = 0; k < n; k++) { last = Math.max((k + 1) * 10 + 5, last + (k < 400 ? 11.6 : 2.6)); arr[k] = last * 48; }
  const res = run({ arr, kind: k => (music(k) ? 'sound' : 'silence'), codecOf: k => (k < 400 ? 1 : 0), warmMs: 15000 });
  none(res);
  assert.equal(res.st.resampledMs, 0, 'never resampled');
  assert.equal(res.st.skips, 0, 'never skipped: the backlog went in silence');
  const after = res.events.filter(e => e.type === 'underrun' && e.out > 48 * 6000);
  assert.deepEqual(after, [], 'no underrun once the backlog has drained');
  assert.ok(res.buf.p95 < 250, `buffer p95 ${res.buf.p95} ms from 15 s (it learned up to ${Math.round((arr[399] / 48) - 4000)} ms of lateness before the switch)`);
});

test('the network getting worse mid-sound waits for silence: no resampling (drift alone moves the resampler)', () => {
  const r = rng(11);
  // Lateness steps up 100 ms at 45.5 s, mid-sound: more than the floor can absorb (smaller steps only use up the
  // floor's headroom and need nothing), less than the reserve (no underrun).
  const arr = arrivals(6000, { delay: (k, sent) => 3 + 2 * r() + (sent > 45500 ? 100 : 0) });
  const res = run({ arr, kind: k => (music(k) ? 'sound' : 'silence'), warmMs: 0 });
  none(res);
  assert.equal(res.st.underruns, 0);
  assert.equal(res.st.resampledMs, 0);
  assert.equal(res.c.altered + res.c.resampled, 0, 'bit-exact throughout');
  assert.ok(res.st.insertedMs >= 20, `the reserve was rebuilt in the next silence (${res.st.insertedMs} ms added)`);
});

// ------------------------------------------------------------------------------------------- backlogs

test('a backlog under 1 s in sound waits for silence and goes there; over 1 s it is skipped with a crossfade', () => {
  // The output clock stands still (a suspended context) while packets keep coming: the stream runs ahead.
  for (const [holdMs, skips] of [[500, 0], [2000, 1]]) {
    const r = rng(holdMs);
    const arr = arrivals(6000, { delay: () => 2 + 4 * r() });
    const t0 = 20500 * 48; // mid-sound (sound is 0-3 s of every 4 s)
    const res = run({ arr, kind: k => (music(k) ? 'sound' : 'silence'), holdOutput: f => f >= t0 && f < t0 + holdMs * 48, warmMs: 0 });
    assert.equal(res.c.nan, 0);
    assert.equal(res.st.skips, skips, `skips after ${holdMs} ms: ${JSON.stringify(res.events.filter(e => e.type === 'skip'))}`);
    if (!skips) {
      none(res);
      assert.equal(res.st.underruns, 0);
      assert.ok(res.st.droppedMs > holdMs * 0.8, `dropped ${res.st.droppedMs} ms of silence`);
    } else {
      assert.ok(res.st.skippedMs > 900 && res.st.skippedMs < holdMs, `skipped ${res.st.skippedMs} ms`);
      const between = res.c.altered + res.c.resampled; // a crossfade of two places decodes as neither of them
      assert.ok(between >= 96 && between < 600, `crossfaded over a few ms (${between} samples between the two places)`);
      assert.equal(res.c.repeatedSound, 0);
    }
    assert.ok(res.buf.p95 < 140, `then back near target: p95 ${res.buf.p95} ms`);
  }
});

// ------------------------------------------------------------------------------------------- underruns

test('an underrun is concealed with a fade (no NaN, no click) and raises the target', () => {
  const amp = 0.5, f = 1000, w = 2 * Math.PI * f / 48000;
  const sine = k => { const left = new Float32Array(480); for (let i = 0; i < 480; i++) left[i] = amp * Math.sin(w * (k * 480 + i)); return { left, right: left }; };
  // Steady, then a 300 ms stall in the middle of sound, after the start reserve has gone.
  const stall = at => (at > 45000 && at < 45300 ? 45300 : 0);
  const arr = arrivals(9000, { delay: () => 2, stall });
  let before = null;
  const res = run({ arr, samples: sine, onQuantum: (p, fr) => { if (fr === 44000 * 48) before = p.stats(); } });
  assert.equal(res.c.nan, 0, 'no NaN');
  assert.equal(res.st.underruns, 1);
  assert.ok(res.st.concealedMs > 100 && res.st.concealedMs < 300, `concealed ${res.st.concealedMs} ms (the 120 ms floor bridged the rest)`);
  const slew = amp * w;
  assert.ok(res.c.maxStep <= slew + amp * Math.PI / (2 * 193) + 1e-6, `no click: max step ${res.c.maxStep} vs the sine's own ${slew}`);
  assert.ok(res.st.targetMs > 300 && res.st.targetMs > before.targetMs + 200, `the target now covers a 300 ms stall: ${before.targetMs} -> ${res.st.targetMs} ms`);
  const e = res.events.find(x => x.type === 'conceal');
  assert.ok(e && e.frames > 0, 'the concealment is reported with its length');
});

test('the 120 ms floor bridges a 100 ms main-thread stall on a quiet path, mid-sound, long after the start reserve', () => {
  const r = rng(21);
  // Nothing reaches the worklet for 100 ms (a sheet opening, GC), then everything at once.
  const stall = at => (at > 61200 && at < 61300 ? 61300 : 0);
  const arr = arrivals(8000, { delay: () => 2 + 2 * r(), stall });
  const res = run({ arr, kind: k => (music(k) ? 'sound' : 'silence') });
  none(res);
  assert.equal(res.st.underruns, 0, 'no dropout');
  assert.equal(res.c.underrunFrames + res.c.altered + res.c.resampled, 0, 'bit-exact through it');
  assert.ok(res.buf.p95 <= 150, `buffer p95 ${res.buf.p95} ms`);
});

test('a stall in silence is no dropout: the silence just lasts longer', () => {
  const stall = at => (at > 43200 && at < 43700 ? 43700 : 0); // inside the 1 s silence at 43-44 s
  const arr = arrivals(8000, { delay: () => 2, stall });
  const res = run({ arr, kind: k => (music(k) ? 'sound' : 'silence') });
  none(res);
  assert.equal(res.st.underruns, 0);
  assert.equal(res.c.underrunFrames, 0);
  assert.equal(res.st.concealedMs, 0);
  assert.equal(res.c.altered, 0);
});

test('lost packets keep their place: faded out, silence, faded in; never a flush', () => {
  const r = rng(5);
  const arr = arrivals(3000, { delay: () => 2 + 4 * r() });
  const lost = new Set([2100, 2101, 2102]); // in sound, at 21 s
  const p = new Playout({ mode: 'priority' });
  const L = new Float32Array(128), Rr = new Float32Array(128);
  let k = 0, frames = 0, maxStep = 0, last = 0, nan = 0;
  while (frames < arr[2999] + 4800) {
    while (k < 3000 && arr[k] <= frames) {
      if (!lost.has(k)) {
        const left = new Float32Array(480);
        for (let i = 0; i < 480; i++) left[i] = 0.5 * Math.sin(2 * Math.PI * 500 * (k * 480 + i) / 48000);
        p.push({ seq: k + 1, codec: 1, left, right: left });
      }
      k++;
    }
    p.render(L, Rr);
    for (const v of L) { if (v !== v) nan++; maxStep = Math.max(maxStep, Math.abs(v - last)); last = v; }
    frames += 128;
  }
  const st = p.stats();
  assert.equal(nan, 0);
  assert.equal(st.lost, 3);
  assert.equal(st.underruns, 0, 'the timeline kept its place: nothing ran dry');
  assert.ok(st.concealedMs >= 8 && st.concealedMs < 45, `concealed ${st.concealedMs} ms (30 ms lost, some of it dropped as silence, + fades)`);
  assert.ok(maxStep < 0.5 * 2 * Math.PI * 500 / 48000 + 0.01, `no click: ${maxStep}`);
});

// ------------------------------------------------------------------------------------------- standard = today

/** Today's worklet.js (7522d38) and player.js's gap rule, ported verbatim as the reference. */
class TodayWorklet {
  constructor() {
    this.TARGET = 48000 * 0.04; this.MAX = 48000 * 0.15; this.CAP = 48000 * 2;
    this.l = new Float32Array(this.CAP); this.r = new Float32Array(this.CAP);
    this.read = 0; this.write = 0; this.buffering = true; this.lastSeq = 0;
  }
  get size() { return this.write - this.read; }
  packet(seq, left, right) { // player.js: a gap re-buffers, then the decoded PCM follows
    if (seq !== this.lastSeq + 1 && this.lastSeq !== 0) { this.read = this.write; this.buffering = true; }
    this.lastSeq = seq;
    this.push(left, right);
  }
  push(left, right) {
    for (let i = 0; i < left.length; i++) {
      const idx = (this.write + i) % this.CAP;
      this.l[idx] = left[i];
      this.r[idx] = right[i];
    }
    this.write += left.length;
    if (this.size > this.MAX) this.read = this.write - this.TARGET; // catch up
    if (this.buffering && this.size >= this.TARGET) this.buffering = false;
  }
  flush() { this.read = this.write; this.buffering = true; }
  process(out0, out1) {
    const n = out0.length;
    if (this.buffering || this.size < n) {
      this.buffering = true;
      out0.fill(0);
      if (out1) out1.fill(0);
      return true;
    }
    for (let i = 0; i < n; i++) {
      const idx = (this.read + i) % this.CAP;
      out0[i] = this.l[idx];
      if (out1) out1[i] = this.r[idx];
    }
    this.read += n;
    return true;
  }
}

test('standard (priority off) plays exactly what today\'s worklet plays, sample for sample', () => {
  for (const seed of [1, 2, 3]) {
    const r = rng(seed);
    const ref = new TodayWorklet(), p = new Playout({ mode: 'standard' });
    const a0 = new Float32Array(128), a1 = new Float32Array(128), b0 = new Float32Array(128), b1 = new Float32Array(128);
    let seq = 1, n = 0, compared = 0;
    for (let step = 0; step < 60000; step++) {
      const x = r();
      if (x < 0.27) { // a packet: usually the next, sometimes after a gap (host silence) or a burst
        if (r() < 0.02) seq += 1 + Math.floor(r() * 30);
        const len = r() < 0.9 ? 480 : 960;
        const left = new Float32Array(len), right = new Float32Array(len);
        for (let i = 0; i < len; i++) { left[i] = Math.sin(n * 0.01) * 0.5; right[i] = Math.cos(n * 0.013) * 0.4; n++; }
        ref.packet(seq, left, right);
        p.push({ seq, codec: 0, left, right });
        seq++;
      } else if (x < 0.2701) {
        ref.flush();
        p.flush();
      } else {
        ref.process(a0, a1);
        p.render(b0, b1);
        for (let i = 0; i < 128; i++) if (a0[i] !== b0[i] || a1[i] !== b1[i]) assert.fail(`seed ${seed}, step ${step}, sample ${i}: ${b0[i]},${b1[i]} != ${a0[i]},${a1[i]}`);
        compared++;
      }
    }
    assert.ok(compared > 40000);
  }
});

test('standard mode keeps the old messages working: PCM without a seq, and the old gap message', () => {
  const p = new Playout({ mode: 'standard' }), ref = new TodayWorklet();
  const a = new Float32Array(128), b = new Float32Array(128);
  for (let k = 0; k < 50; k++) {
    const left = new Float32Array(480).fill((k % 7) / 10);
    p.push({ left, right: left });
    ref.push(left, left);
    if (k === 30) { p.flush(); ref.flush(); }
    p.render(a); ref.process(b);
    assert.deepEqual(a, b);
  }
});
