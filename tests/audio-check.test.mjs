// The pure parts of tools/audio-check.mjs (the test signal, today's playout, the playout simulation and its scoring,
// the Ogg muxer) and tools/netem.mjs (the network model), without a host or sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MusicGen, musicFrames, musicIsSound, musicSilentCount, decodePcm24, parseAudioPacket, TodayPlayout, simulatePlayout,
  indexFrames, decodeIndex, oggCrc, oggOpus, opusSamples, percentile, analyze, cafPackets, spectralFidelity, verdict, driftVerdict,
  DELAY_BOUNDS, oggPackets,
} from '../tools/audio-check.mjs';
import { Link, Pipe, linkOptions, uplinkOptions, PROFILES } from '../tools/netem.mjs';

// ------------------------------------------------------------------------------------------------ the test signal
test('music: the first frames, as 24-bit integers (the hosts must produce exactly these)', () => {
  const g = musicFrames(481);
  const frames = [];
  for (let n = 0; n < 8; n++) frames.push([g[2 * n], g[2 * n + 1]]);
  assert.deepEqual(frames, [
    [-2059870, 324026], [-1607090, -113075], [-1177106, -22335], [-1269887, -619485],
    [-1124924, -438152], [-1064824, 166567], [-930396, 139469], [-916998, 655392],
  ]);
  // The last frame of packet 0 and the first of packet 1.
  assert.deepEqual([g[958], g[959]], [-59564, 879179]);
  assert.deepEqual([g[960], g[961]], [108425, 494410]);
});

test('music: a full cycle is 3 s of sound then 1 s of digital silence, and is pinned by its hash', () => {
  const g = musicFrames(192000 + 480);
  let silentInSound = 0, nonzeroInSilence = 0, peak = 0;
  for (let n = 0; n < 192000; n++) {
    const L = g[2 * n], R = g[2 * n + 1];
    peak = Math.max(peak, Math.abs(L), Math.abs(R));
    if (n < 144000) { if (L === 0 && R === 0) silentInSound++; } else if (L || R) nonzeroInSilence++;
  }
  assert.equal(silentInSound, 0);
  assert.equal(nonzeroInSilence, 0);
  assert.deepEqual([g[2 * 143999], g[2 * 143999 + 1]], [-1620527, -216559]);
  assert.deepEqual([g[2 * 192000], g[2 * 192000 + 1]], [-1578219, 489268]);
  assert.ok(peak < 2 ** 21, `peak ${peak} fits 24 bits with room`);
  // (cross-checked against an independent Python implementation of the spec)
  const h = createHash('sha256').update(Buffer.from(g.buffer, 0, 192000 * 8)).digest('hex');
  assert.equal(h, '7188d1ab0b3726124bb6e163eed043ff24e2f438241007ab93856b63cc6383ce');
  // Silence starts on a packet boundary: packets 300-399 of every 400 are all zero.
  assert.equal(144000 % 480, 0);
  assert.equal(musicIsSound(143999), true);
  assert.equal(musicIsSound(144000), false);
  assert.equal(musicIsSound(192000), true);
});

test('music: generating 10 ms at a time gives the same samples, and each one is exact as float32', () => {
  const all = musicFrames(4800);
  const g = new MusicGen(), parts = new Int32Array(4800 * 2);
  for (let i = 0; i < 10; i++) g.next(480, parts, i * 480);
  assert.deepEqual(parts, all);
  const f = new Float32Array(all.length);
  for (let i = 0; i < all.length; i++) f[i] = all[i] / 8388608;
  for (let i = 0; i < all.length; i++) assert.equal(f[i] * 8388608, all[i]);
});

test('music: counting silent frames in a range', () => {
  for (const [a, b] of [[0, 192000], [100000, 500000], [143999, 144001], [150000, 150000], [191999, 384001]]) {
    let c = 0;
    for (let n = a; n < b; n++) if (!musicIsSound(n)) c++;
    assert.equal(musicSilentCount(a, b), c, `[${a}, ${b})`);
  }
});

// ------------------------------------------------------------------------------------------------ the wire
test('PCM 24-bit little-endian decodes to signed integers', () => {
  const vals = [-8388608, -1, 0, 1, 8388607, -2059870, 324026];
  const b = new Uint8Array(vals.length * 3);
  vals.forEach((v, i) => { b[3 * i] = v & 255; b[3 * i + 1] = (v >> 8) & 255; b[3 * i + 2] = (v >> 16) & 255; });
  assert.deepEqual(Array.from(decodePcm24(b)), vals);
});

test('the audio packet header: codec, seq, host time', () => {
  const b = new ArrayBuffer(16 + 2), v = new DataView(b);
  v.setUint8(0, 3); v.setUint8(1, 2); v.setUint32(4, 0xFFFFFFFE, true); v.setBigInt64(8, 123456789012n, true); v.setUint16(16, 480, true);
  const p = parseAudioPacket(b);
  assert.deepEqual({ codec: p.codec, seq: p.seq, hostUs: p.hostUs, len: p.payload.length, frames: p.payload[0] | (p.payload[1] << 8) }, { codec: 2, seq: 0xFFFFFFFE, hostUs: 123456789012, len: 2, frames: 480 });
});

// ------------------------------------------------------------------------------------------------ today's playout
const pk = (seq, value = 0.5, frames = 480) => ({ seq, left: new Float32Array(frames).fill(value), right: new Float32Array(frames).fill(value) });
const q = () => [new Float32Array(128), new Float32Array(128)];

test("today's playout: plays once 40 ms are buffered, re-buffers on an underrun", () => {
  const p = new TodayPlayout(), [l, r] = q();
  for (let s = 1; s <= 3; s++) p.packet(pk(s));
  p.render(l, r);
  assert.equal(l[0], 0, '30 ms buffered: still silent');
  p.packet(pk(4));
  p.render(l, r);
  assert.equal(l[0], 0.5, '40 ms: playing');
  for (let i = 0; i < 14; i++) p.render(l, r); // 15 quanta = 1920 frames: all of it
  p.render(l, r);
  assert.equal(l[0], 0);
  assert.equal(p.stats().underruns, 1);
  p.packet(pk(5));
  p.render(l, r);
  assert.equal(l[0], 0, 'after an underrun it waits for 40 ms again');
});

test("today's playout: past 150 ms it keeps only the newest 40 ms; a seq gap flushes everything", () => {
  const p = new TodayPlayout(), [l, r] = q();
  for (let s = 1; s <= 15; s++) p.packet(pk(s, s / 100)); // 7200 frames: not past 150 ms yet
  assert.equal(p.stats().skips, 0);
  p.packet(pk(16, 0.16));
  assert.deepEqual([p.stats().skips, p.stats().skippedFrames, p.size], [1, 7680 - 1920, 1920]);
  p.render(l, r);
  assert.equal(l[0], Math.fround(0.13), 'the newest 40 ms are packets 13-16');
  p.packet(pk(20, 0.2));
  assert.deepEqual([p.stats().flushes, p.size, p.buffering], [1, 480, true]);
});

// ------------------------------------------------------------------------------------------------ simulation + scoring
const packetsEvery10ms = (count, { at = k => 5 + k * 10, codec = () => 0, skip = () => false } = {}) => {
  const a = [];
  for (let k = 0; k < count; k++) if (!skip(k)) a.push({ k, seq: k + 1, codec: codec(k), hostUs: k * 10000, at: at(k) });
  return a;
};
const today = () => new TodayPlayout();

test('simulation: a perfect network at 0 ppm plays every frame once, about 40 ms buffered', () => {
  const r = simulatePlayout({ packets: packetsEvery10ms(1000), ppm: 0, make: today });
  assert.deepEqual([r.all.underruns, r.all.droppedSound, r.all.insertedSound, r.all.concealedMs, r.all.resampledMs], [0, 0, 0, 0, 0]);
  assert.ok(r.bufferDelayMs.p50 > 30 && r.bufferDelayMs.p50 < 45, `p50 ${r.bufferDelayMs.p50}`);
  assert.ok(r.bufferDelayMs.max <= 45, `max ${r.bufferDelayMs.max}`);
});

test('simulation: a 300 ms hole is one underrun inside sound, and the burst after it a skip', () => {
  // Packets 300-329 are held up and arrive together with packet 330.
  const packets = packetsEvery10ms(800, { at: k => (k >= 300 && k < 330 ? 5 + 330 * 10 : 5 + k * 10) });
  const r = simulatePlayout({ packets, ppm: 0, make: today });
  assert.equal(r.steady.underruns, 1);
  // ~40 ms were buffered when the hole began: then silence until the burst (the burst ends the re-buffering at once).
  assert.ok(r.steady.underrunMs > 250 && r.steady.underrunMs < 290, `underrun ${r.steady.underrunMs} ms`);
  // The burst (31 packets, 310 ms) goes past 150 ms twice while it's pushed: each time all but the newest 40 ms go.
  assert.equal(r.playout.skips, 2);
  assert.equal(r.steady.droppedSound, 2 * (16 * 480 - 1920));
  assert.deepEqual(r.events.map(e => e.type).sort(), ['drop', 'underrun']);
});

test('simulation: a fast device clock drains the buffer into underruns, a slow one grows it into skips', () => {
  const fast = simulatePlayout({ packets: packetsEvery10ms(6000), ppm: 2000, make: today });
  assert.ok(fast.steady.underruns >= 3, `+2000 ppm over 60 s: ${fast.steady.underruns} underruns`);
  assert.equal(fast.steady.droppedSound, 0);
  const slow = simulatePlayout({ packets: packetsEvery10ms(12000), ppm: -2000, make: today });
  assert.equal(slow.steady.underruns, 0);
  assert.ok(slow.steady.droppedSound > 4000, `-2000 ppm over 120 s: ${slow.steady.droppedSound} skipped`);
});

test("simulation: today's silence suppression flushes in silence and loses nothing inside sound", () => {
  // The host sends 200 ms of silence after the sound, then nothing until the next sound (packets 320-399 of 400).
  const packets = packetsEvery10ms(4000, { skip: k => k % 400 >= 320 });
  const r = simulatePlayout({ packets, ppm: 0, make: today, isSound: musicIsSound, silentCount: musicSilentCount });
  assert.deepEqual([r.steady.underruns, r.steady.droppedSound, r.steady.insertedSound], [0, 0, 0]);
  assert.equal(r.playout.flushes, 9);
  // Silence packets (priority) keep the timeline: no flush at all.
  const p2 = packetsEvery10ms(4000, { codec: k => (k % 400 >= 300 ? 2 : 0) });
  const r2 = simulatePlayout({ packets: p2, ppm: 0, make: today, isSound: musicIsSound, silentCount: musicSilentCount });
  assert.deepEqual([r2.steady.underruns, r2.steady.droppedSound, r2.playout.flushes], [0, 0, 0]);
});

test('simulation: a dropout concealed with fades counts as an underrun, the faded-in frames as played', () => {
  // A playout that plays straight through, except once: 4 ms faded out (half level), 20 ms of silence, then the
  // next 4 ms of the source faded back in (half level), nothing skipped; and once later, a resampler-like stretch of
  // altered samples that stand in one for one (no silence): a modification, not a dropout.
  class Fading {
    constructor() { this.q = []; this.out = 0; }
    packet({ left, right }) { for (let i = 0; i < left.length; i++) this.q.push([left[i], right[i]]); }
    render(L, R) {
      for (let i = 0; i < L.length; i++, this.out++) {
        const o = this.out;
        let v = [0, 0];
        if (o >= 96000 && o < 96000 + 192) v = this.q[0] ? [this.q[0][0] * 0.5, this.q[0][1] * 0.5] : [0, 0]; // fade-out (a continuation: nothing consumed)
        else if (o >= 96192 && o < 96192 + 960) v = [0, 0];
        else if (this.q.length) { v = this.q.shift(); if (o >= 97152 && o < 97152 + 192) v = [v[0] * 0.5, v[1] * 0.5]; if (o >= 144000 && o < 144100) v = [v[0] * 0.999, v[1] * 0.999]; }
        L[i] = v[0]; R[i] = v[1];
      }
    }
    stats() { return {}; }
  }
  const packets = packetsEvery10ms(400, { at: k => (k < 4 ? 0 : 5 + (k - 4) * 10) });
  const r = simulatePlayout({ packets, ppm: 0, make: () => new Fading() });
  assert.equal(r.steady.underruns, 1);
  assert.equal(r.steady.droppedSound, 0, 'the faded-in frames were played');
  assert.equal(r.steady.underrunMs, (192 + 960) / 48);
  assert.equal(r.steady.concealedMs, (192 + 192) / 48);
  assert.equal(r.steady.modifiedMs, Math.round(100 / 48 * 10) / 10);
});

test('simulation: lossless samples are checked bit for bit at the output', () => {
  const packets = packetsEvery10ms(500, { codec: () => 1 });
  const expected = musicFrames(500 * 480 + 48000);
  const real = p => {
    const left = new Float32Array(480), right = new Float32Array(480);
    for (let i = 0; i < 480; i++) { left[i] = expected[2 * (p.k * 480 + i)] / 8388608; right[i] = expected[2 * (p.k * 480 + i) + 1] / 8388608; }
    if (p.k === 250) left[7] += 1 / 8388608; // one wrong sample
    return { left, right };
  };
  const r = simulatePlayout({ packets, ppm: 0, make: today, isSound: musicIsSound, silentCount: musicSilentCount, real, expected });
  assert.equal(r.exact.mismatched, 1);
  assert.equal(r.exact.first[0].frame, 250 * 480 + 7);
  // 240 000 frames, 48 000 of them digital silence (not checked), less the start (playing begins after 40 ms).
  assert.ok(r.exact.checked > 190000 && r.exact.checked <= 192000, `checked ${r.exact.checked}`);
});

test('analysis of a capture: lossless priority passes; a lost packet or an unannounced switch fails', async () => {
  // 12 s of priority lossless from a host whose generator started 7 packets before the first packet we got.
  const K = 1200, gen = musicFrames((K + 7) * 480);
  const pcm = k => { const b = new Uint8Array(2880); for (let i = 0; i < 960; i++) { const v = gen[(k + 7) * 960 + i]; b[3 * i] = v & 255; b[3 * i + 1] = (v >> 8) & 255; b[3 * i + 2] = (v >> 16) & 255; } return b; };
  const capture = () => {
    const cap = { audio: [], audioModes: [{ at: 40, mode: 'pcm24', priority: true, kbps: 2304 }], stats: [], video: [], pongs: [], notices: [], meta: { request: { mode: 'pcm24', priority: true } } };
    for (let k = 0; k < K; k++) {
      const silent = !musicIsSound((k + 7) * 480);
      cap.audio.push({ at: 50 + k * 10 + (k % 5) * 0.4, seq: 4000000000 + k, codec: silent ? 2 : 1, hostUs: 9e9 + k * 10000, bytes: silent ? 2 : 2880, payload: silent ? new Uint8Array([224, 1]) : pcm(k) });
    }
    return cap;
  };
  const opts = { signal: 'music', ppms: [80, -80], playout: 'today', profile: 'lan' };
  const ok = await analyze(capture(), opts);
  assert.equal(ok.alignment.verified, true);
  assert.equal(ok.alignment.k0, 7);
  assert.equal(ok.lossless.samplesWrong, 0);
  assert.equal(ok.lossless.samplesChecked, 900 * 960); // 300 of the 1200 packets are silence packets
  assert.equal(ok.silencePackets.wrong, 0);
  assert.deepEqual(ok.verdict.fails, []);
  assert.equal(ok.verdict.kind, 'priority + lossless');

  const lost = capture();
  lost.audio.splice(500, 1);
  const bad = await analyze(lost, opts);
  assert.equal(bad.wire.missing, 1);
  assert.ok(bad.verdict.fails.some(f => f.includes('never arrived')));

  const switched = capture();
  for (const p of switched.audio.slice(800)) if (p.codec === 1) { p.codec = 0; p.payload = new Uint8Array([0xF0, 1, 2]); p.bytes = 3; }
  const sw = await analyze(switched, { ...opts, tmp: undefined });
  assert.ok(sw.verdict.fails.some(f => f.includes('without announcing') || f.includes('Opus decode')), sw.verdict.fails.join('; '));
});

test('the index signal: frame numbers survive float32 and interpolation; silence stays zero; fades are "altered"', () => {
  const sound = n => n !== 5;
  const firsts = [0, 2 ** 21 - 3, 2 * 2 ** 21 - 4, 123456789, 2 ** 32 - 9];
  for (const f of firsts) {
    const { left, right } = indexFrames(f, 8, sound);
    for (let i = 0; i < 8; i++) {
      if (f + i === 5) assert.deepEqual([left[i], right[i]], [0, 0]);
      else assert.equal(decodeIndex(left[i], right[i]), f + i, `frame ${f + i}`);
    }
  }
  const { left, right } = indexFrames(1000, 2, () => true);
  assert.ok(Number.isNaN(decodeIndex(left[0] * 0.5, right[0] * 0.5)), 'a fade');
  assert.ok(Number.isNaN(decodeIndex(left[0] * 0.7, right[0] * 0.7)), 'a mix with silence');
  assert.equal(decodeIndex((left[0] + left[1]) / 2, right[0]), 1000.5);
  // A resampler's output: a few ulps off in both channels still reads as (about) the right frame...
  const f32 = Math.fround;
  assert.ok(Math.abs(decodeIndex(f32(left[0] + 2 ** -25), f32(right[0] - 3 * 2 ** -25)) - 1000) <= 0.25);
  // ...also across a block edge, where the high part is between two steps.
  const e = indexFrames(2 ** 21 - 2, 4, () => true);
  const mid = decodeIndex(f32((e.left[1] + e.left[2]) / 2), f32((e.right[1] + e.right[2]) / 2));
  assert.ok(Math.abs(mid - (2 ** 21 - 0.5)) <= 1, `edge: ${mid}`);
});

test('percentile', () => {
  assert.equal(percentile([5, 1, 4, 2, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([], 50), null);
});

// ------------------------------------------------------------------------------------------------ Ogg Opus
test('Ogg: the CRC check value, and a file of pages with granules counting samples', () => {
  assert.equal(oggCrc(Buffer.from('123456789')), 0x89A1897F);
  const toc10ms = 0xF0; // config 30: CELT fullband 10 ms, one frame
  assert.equal(opusSamples([toc10ms]), 480);
  assert.equal(opusSamples([0xF8]), 960); // config 31: CELT fullband 20 ms
  assert.equal(opusSamples([0x08]), 960); // SILK NB 20 ms
  assert.equal(opusSamples([0xF3, 3]), 1440); // three 10 ms CELT frames (code 3)
  const packets = Array.from({ length: 120 }, (_, i) => new Uint8Array(300 + i).fill(toc10ms));
  const f = oggOpus(packets);
  const granules = [];
  let got = 0;
  for (let o = 0; o < f.length;) {
    assert.equal(f.toString('latin1', o, o + 4), 'OggS');
    const nseg = f[o + 26];
    let len = 0;
    for (let i = 0; i < nseg; i++) len += f[o + 27 + i];
    const page = Buffer.from(f.subarray(o, o + 27 + nseg + len));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    assert.equal(oggCrc(page), crc);
    granules.push(Number(page.readBigInt64LE(6)));
    for (let i = 0; i < nseg; i++) if (page[27 + i] < 255) got++;
    o += 27 + nseg + len;
  }
  assert.equal(got, 2 + 120);
  assert.equal(granules.at(-1), 120 * 480);
  assert.equal(f.toString('latin1', 28, 36), 'OpusHead');
});

// ------------------------------------------------------------------------------------------------ the network
test("netem: the profiles are COMMON's", () => {
  assert.deepEqual(PROFILES.remote, { delayMs: 40, jitterMs: 20, rateKbps: 20000, bufMs: 150 });
  assert.deepEqual(PROFILES.cellular, { delayMs: 70, jitterMs: 40, rateKbps: 8000, bufMs: 400, stallMs: 400, stallEveryMs: 20000 });
  assert.deepEqual(PROFILES.tight, { delayMs: 20, jitterMs: 5, rateKbps: 4000, bufMs: 200 });
  assert.equal(PROFILES['too-tight'].rateKbps, 2000);
  assert.equal(linkOptions('remote', { delayMs: 10, bufMs: undefined }).delayMs, 10);
  assert.equal(linkOptions('remote', { bufMs: undefined }).bufMs, 150);
  assert.deepEqual([uplinkOptions(linkOptions('cellular')).delayMs, uplinkOptions(linkOptions('cellular')).rateKbps, uplinkOptions(linkOptions('cellular')).jitterMs], [70, 0, 0]);
});

test('netem: back-to-back packets leave at the link rate and arrive in order, within delay ± jitter', () => {
  const L = new Link(linkOptions('remote', { seed: 7 }), 0);
  let prev = -Infinity, lastTx = 0;
  for (let i = 0; i < 2000; i++) {
    const { txEnd, deliverAt } = L.send(1448, 0);
    assert.ok(deliverAt >= prev, 'never overtakes');
    assert.ok(deliverAt - txEnd >= 20 - 1e-9 && deliverAt - txEnd <= 60 + 1e-9, `delay ${deliverAt - txEnd}`);
    prev = deliverAt;
    lastTx = txEnd;
  }
  assert.ok(Math.abs(lastTx - 2000 * 1448 * 8 / 20000) < 1e-6, `2000 packets at 20 Mb/s: ${lastTx} ms`);
  // Same seed, same path.
  const a = new Link(linkOptions('wifi', { seed: 3 }), 0), b = new Link(linkOptions('wifi', { seed: 3 }), 0);
  for (let t = 0; t < 5000; t += 37) assert.equal(a.delayAt(t), b.delayAt(t));
  // The delay really moves (not a constant).
  const ds = Array.from({ length: 100 }, (_, i) => a.delayAt(i * 50));
  assert.ok(Math.max(...ds) - Math.min(...ds) > 10);
  assert.ok(Math.min(...ds) >= 0);
});

test('netem: the bottleneck buffer holds buf ms; past that the source is paused, and bytes arrive intact and in order', () => {
  const p = new Pipe(new Link(linkOptions('too-tight'), 0)); // 2 Mb/s, 200 ms = 50 000 bytes
  const data = Buffer.alloc(200_000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 9)) & 255;
  assert.equal(p.write(data.subarray(0, 120_000), 0), true, 'more than the buffer: the source must stop');
  const out = [];
  let paused = true, t = 0, maxQueued = 0, resumedAt = null;
  for (; t <= 2000; t++) {
    if (!paused && resumedAt === null) { resumedAt = t; p.write(data.subarray(120_000), t); }
    const r = p.poll(t);
    maxQueued = Math.max(maxQueued, p.link.queued);
    if (r.out) out.push(r.out);
    paused = r.paused;
  }
  assert.ok(maxQueued <= 50_000, `queued at most ${maxQueued}`);
  // 120 000 written, 50 000 fit: the other 70 000 wait until that much has gone out at 250 bytes/ms.
  assert.ok(resumedAt >= 280 && resumedAt <= 290, `the source may read again once the overflow fits (${resumedAt} ms)`);
  assert.ok(Buffer.concat(out).equals(data), 'every byte, in order');
  assert.equal(p.stats.bytesOut, 200_000);
});

test('netem: nothing is transmitted during a stall, and the uplink keeps only the base delay', () => {
  const o = linkOptions('cellular');
  const L = new Link(o, 0);
  assert.equal(L.stallEnd(19_999), null);
  assert.equal(L.stallEnd(20_000), 20_400);
  assert.equal(L.stallEnd(40_399), 40_400);
  // 20 000 bytes at 8 Mb/s starting 10 ms before a stall: 10 ms, the stall, then the other 10 ms.
  assert.equal(L.txDone(19_990, 20_000), 20_410);
  const U = new Link(uplinkOptions(o), 0);
  const { deliverAt } = U.send(100, 1000);
  assert.equal(deliverAt, 1070);
  assert.equal(U.send(100, 20_100).deliverAt, 20_470, 'a stall holds the uplink too');
});

// ------------------------------------------------------------------------------------------------ fidelity + verdicts
test('CAF: the packet table (priming = the encoder delay) and the packets afconvert writes', () => {
  const chunk = (type, body) => { const h = Buffer.alloc(12); h.write(type, 0, 'latin1'); h.writeBigInt64BE(BigInt(body.length), 4); return Buffer.concat([h, body]); };
  const desc = Buffer.alloc(32);
  desc.writeDoubleBE(48000, 0); desc.write('opus', 8, 'latin1'); desc.writeUInt32BE(480, 20); desc.writeUInt32BE(2, 24);
  const sizes = [3, 200, 130];
  const vlq = n => (n < 128 ? [n] : [0x80 | (n >> 7), n & 127]);
  const pakt = Buffer.concat([Buffer.alloc(24), Buffer.from(sizes.flatMap(vlq))]);
  pakt.writeBigInt64BE(3n, 0); pakt.writeBigInt64BE(1128n, 8); pakt.writeInt32BE(312, 16); pakt.writeInt32BE(0, 20);
  const payload = Buffer.concat(sizes.map((n, i) => Buffer.alloc(n, i + 1)));
  const file = Buffer.concat([Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0]), chunk('desc', desc), chunk('pakt', pakt), chunk('data', Buffer.concat([Buffer.alloc(4), payload]))]);
  const c = cafPackets(file);
  assert.deepEqual([c.desc.format, c.desc.framesPerPacket, c.pakt.priming, c.pakt.packets], ['opus', 480, 312, 3]);
  assert.deepEqual(c.packets.map(q => [q.length, q[0]]), [[3, 1], [200, 2], [130, 3]]);
  // ...and the Ogg packets of a file oggOpus wrote come back out.
  const back = oggPackets(oggOpus(c.packets));
  assert.equal(back.length, 2 + 3);
  assert.deepEqual(Array.from(back[3]), Array.from(c.packets[1]));
});

test('spectral fidelity: a gain shows in the bass levels, added noise in the coding SNR, a filter not at all', () => {
  const N = 4096, frames = N * 24, x = new Float64Array(frames * 2);
  let a = 1;
  const rnd = () => ((a = (Math.imul(a, 1103515245) + 12345) >>> 0) / 4294967296 - 0.5);
  for (let i = 0; i < x.length; i++) x[i] = rnd();
  const starts = Array.from({ length: 22 }, (_, i) => i * N);
  const X = (c, m) => x[2 * m + c];
  const half = spectralFidelity(X, (c, m) => 0.5 * x[2 * m + c], starts, N);
  for (const v of Object.values(half.bassDb)) assert.ok(Math.abs(v + 6.0) < 0.1, `0.5x: ${v} dB`);
  assert.ok(half.codingSnrDb > 60, 'a gain is a linear filter: no coding noise');
  // A one-frame delay is a linear filter too (its phase isn't counted as noise).
  const late = spectralFidelity(X, (c, m) => (m > 0 ? x[2 * (m - 1) + c] : 0), starts, N);
  assert.ok(late.codingSnrDb > 25, `delayed: ${late.codingSnrDb} dB`);
  // Noise 20 dB under the signal, independent of it: coding SNR about 20 dB.
  const noisy = spectralFidelity(X, (c, m) => x[2 * m + c] + 0.1 * rnd(), starts, N);
  assert.ok(Math.abs(noisy.codingSnrDb - 20) < 1.5, `noise: ${noisy.codingSnrDb} dB`);
});

test('verdict: the revised delay bounds, and cellular may learn its stalls (2 concealed underruns in the first 45 s)', () => {
  assert.deepEqual(DELAY_BOUNDS, { lan: 150, wifi: 150, remote: 150, tight: 250, 'too-tight': 250, cellular: 600 });
  const counts = (o = {}) => ({ underruns: 0, underrunMs: 0, concealedMs: 0, droppedSound: 0, insertedSound: 0, droppedSilence: 0, insertedSilence: 0, resampledMs: 0, modifiedMs: 0, ...o });
  const rep = (events, steady, late, p95 = 400) => ({
    wire: { missing: 0, gaps: 0, codecs: { opus: 1000 } },
    playout: [{ ppm: 80, steady: counts(steady), late: { fromMs: 45000, ...counts(late) }, events, bufferDelayMs: { p95 } }],
    video: { frames: 100, maxGapMs: 1000 },
  });
  const cap = { audioModes: [{ at: 0, mode: 'opus', priority: true, kbps: 256 }], audio: [], meta: { request: { mode: 'opus', priority: true } } };
  const two = [{ t: 20500, type: 'underrun', steady: true, concealed: 192 }, { t: 40400, type: 'underrun', steady: true, concealed: 192 }];
  assert.deepEqual(verdict(rep(two, { underruns: 2, underrunMs: 500, concealedMs: 16 }, {}), { profile: 'cellular', priority: true, cap }).fails, []);
  const lateOne = verdict(rep([...two, { t: 60400, type: 'underrun', steady: true, concealed: 192 }], { underruns: 3, underrunMs: 600, concealedMs: 24 }, { underruns: 1, underrunMs: 100, concealedMs: 8 }), { profile: 'cellular', priority: true, cap }).fails;
  assert.ok(lateOne.some(f => f.includes('at most 2')) && lateOne.some(f => f.includes('after the first 45 s')), lateOne.join('; '));
  const bare = verdict(rep([{ t: 20500, type: 'underrun', steady: true, concealed: 0 }], { underruns: 1, underrunMs: 400 }, {}), { profile: 'cellular', priority: true, cap }).fails;
  assert.ok(bare.some(f => f.includes('without a fade')), bare.join('; '));
  // Elsewhere any underrun fails, and the bound is the profile's.
  const lan = verdict(rep(two, { underruns: 2, underrunMs: 500 }, {}, 140), { profile: 'lan', priority: true, cap }).fails;
  assert.ok(lan.some(f => f.includes('2 underruns')) && !lan.some(f => f.includes('buffer delay')), lan.join('; '));
  assert.ok(verdict(rep([], {}, {}, 160), { profile: 'remote', priority: true, cap }).fails.some(f => f.includes('> 150 ms')));
});

test('drift verdict: continuous sound may resample under 10% of the time, with no underruns', () => {
  const r = (signal, results) => ({ minutes: 60, signal, results });
  const s = o => ({ steady: { underruns: 0, underrunMs: 0, droppedSound: 0, insertedSound: 0, resampledMs: 0, ...o }, ppm: 80 });
  assert.deepEqual(driftVerdict(r('continuous', [s({ resampledMs: 300000 })])), []);
  assert.equal(driftVerdict(r('continuous', [s({ resampledMs: 2413000 })])).length, 1);
  assert.equal(driftVerdict(r('continuous', [s({ underruns: 1, underrunMs: 30 })])).length, 1);
  assert.deepEqual(driftVerdict(r('music-priority', [s({ resampledMs: 2413000 })])), [], 'the 10% rule is for continuous sound');
});

test('simulation: lossless then Opus from a fresh decoder joins without a gap when its lookahead is trimmed', () => {
  // A playout that plays what it is given, back to back (a trimmed packet is just shorter).
  class Straight {
    constructor() { this.q = []; }
    packet({ left, right }) { for (let i = 0; i < left.length; i++) this.q.push([left[i], right[i]]); }
    render(L, R) { for (let i = 0; i < L.length; i++) { const v = this.q.shift() || [0, 0]; L[i] = v[0]; R[i] = v[1]; } }
    stats() { return {}; }
  }
  // PCM up to packet 200, then Opus (decoder delay 120) from a fresh decoder, all sound (a 3 s stretch of the music).
  const packets = packetsEvery10ms(290, { at: k => (k < 8 ? 0 : 5 + (k - 8) * 10), codec: k => (k < 200 ? 1 : 0) });
  packets.find(p => p.codec === 0).decoderStart = true;
  const trimmed = simulatePlayout({ packets, ppm: 0, make: () => new Straight(), isSound: musicIsSound, silentCount: musicSilentCount, shift: 120, drop: 120 });
  assert.deepEqual([trimmed.steady.droppedSound, trimmed.steady.insertedSound, trimmed.steady.underruns], [0, 0, 0]);
  // Without the trim the decoder's lookahead plays first: the last 120 frames before the switch, again.
  const untrimmed = simulatePlayout({ packets, ppm: 0, make: () => new Straight(), isSound: musicIsSound, silentCount: musicSilentCount, shift: 120, drop: 0 });
  assert.equal(untrimmed.steady.insertedSound, 120);
});
