// The audio path around the playout: the worklet (as a module and as the one-file bundle for worklets that can't
// import), the feed that keeps packets in order around the Opus decoder, and the player's codec routing.
//
// worklet-bundle.js is generated from playout.js + worklet.js by this file:
//   UPDATE_AUDIO_BUNDLE=1 node --test tests/audio-player.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const dir = new URL('../web/js/audio/', import.meta.url);
const read = name => readFileSync(new URL(name, dir), 'utf8');

/** playout.js + worklet.js as one classic script: no import, no export (Safari 14 runs worklets as classic scripts). */
export function bundleSource() {
  const playout = read('playout.js'), worklet = read('worklet.js');
  assert.doesNotMatch(playout, /^\s*import\b/m, 'playout.js imports nothing');
  assert.doesNotMatch(playout, /^export (default|\{)/m, 'playout.js exports declarations only');
  const body = playout.replace(/^export (?=(const|let|function|class) )/gm, '');
  assert.doesNotMatch(body, /^\s*export\b/m, 'every export of playout.js is a plain declaration');
  const imports = worklet.match(/^import .*$/gm) || [];
  assert.deepEqual(imports, ["import { Playout, decodePcm24 } from './playout.js';"], 'worklet.js imports only the playout');
  const proc = worklet.replace(/^import .*\n/m, '');
  return '// GENERATED from playout.js + worklet.js (UPDATE_AUDIO_BUNDLE=1 node --test tests/audio-player.test.mjs): edit those.\n' +
    '// For AudioWorklets that can\'t import modules: Safari 14 (runs worklet scripts as classic scripts) and Firefox\n' +
    '// before 113. player.js loads it only when worklet.js fails to load or to register.\n' +
    '(function () {\n\'use strict\';\n' + body + '\n' + proc + '})();\n';
}

test('the one-file worklet is playout.js + worklet.js as they are now', () => {
  const src = bundleSource();
  if (process.env.UPDATE_AUDIO_BUNDLE) writeFileSync(new URL('worklet-bundle.js', dir), src);
  assert.ok(read('worklet-bundle.js') === src, 'worklet-bundle.js is stale: UPDATE_AUDIO_BUNDLE=1 node --test tests/audio-player.test.mjs');
});

// ------------------------------------------------------------------------------------------- a worklet scope

class Port {
  constructor() { this.sent = []; this.onmessage = null; }
  postMessage(m) { this.sent.push(m); }
  deliver(m) { this.onmessage?.({ data: m }); }
}

function scope() {
  const registered = {};
  class AudioWorkletProcessor { constructor() { this.port = new Port(); } }
  return { registered, AudioWorkletProcessor, registerProcessor: (name, cls) => { registered[name] = cls; }, sampleRate: 48000 };
}

function pcm24(frames, at) {
  const b = new Uint8Array(frames * 6), v = new DataView(b.buffer);
  const put = (o, x) => { v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); };
  for (let i = 0; i < frames; i++) { put(i * 6, at(i, 0)); put(i * 6 + 3, at(i, 1)); }
  return b;
}

/** Feeds 3 s of PCM (with silence) through a registered processor and checks what comes out is exactly what went in. */
function playsExactly(Processor, priority) {
  const proc = new Processor({ processorOptions: { priority, test: true } });
  const q = 128, L = new Float32Array(q), R = new Float32Array(q);
  const want = [], got = [];
  let seq = 1;
  for (let t = 0; t < 300; t++) {
    const sound = t % 100 < 70;
    if (sound) {
      const at = (i, ch) => (((t * 480 + i) * 7919 + ch * 104729) % 4000000) - 2000000 || 1;
      const bytes = pcm24(480, at);
      for (let i = 0; i < 480; i++) want.push(at(i, 0) / 8388608, at(i, 1) / 8388608);
      proc.port.deliver({ type: 'pcm24', seq: seq++, timeUs: t * 10000, bytes: bytes.buffer });
    } else {
      proc.port.deliver({ type: 'silence', seq: seq++, timeUs: t * 10000, frames: 480 });
    }
    for (let k = 0; k < (t % 4 === 3 ? 3 : 4); k++) { // 15 quanta per 4 packets: real time
      proc.process([], [[L, R]]);
      for (let i = 0; i < q; i++) if (L[i] !== 0 || R[i] !== 0) got.push(L[i], R[i]);
    }
  }
  for (let k = 0; k < 400; k++) { proc.process([], [[L, R]]); for (let i = 0; i < q; i++) if (L[i] !== 0 || R[i] !== 0) got.push(L[i], R[i]); }
  assert.ok(got.length > want.length * 0.9, `played ${got.length / 2} of ${want.length / 2} sound frames`);
  for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) assert.fail(`sample ${i}: ${got[i]} != ${want[i]}`);
  const stats = proc.port.sent.filter(m => m.type === 'stats').at(-1)?.stats;
  assert.ok(stats, 'stats every 0.5 s');
  assert.equal(stats.mode, priority ? 'priority' : 'standard');
  return stats;
}

test('the one-file worklet runs as a classic script and plays 24-bit PCM bit-exactly', () => {
  const s = scope();
  vm.runInNewContext(read('worklet-bundle.js'), s, { filename: 'worklet-bundle.js' });
  assert.equal(typeof s.registered['headroom-pcm'], 'function', 'registers headroom-pcm');
  const st = playsExactly(s.registered['headroom-pcm'], true);
  assert.equal(st.underruns, 0);
  assert.equal(st.hashes.consumed, st.hashes.played, 'what left the buffer is what played');
});

test('worklet.js (the module, importing playout.js) plays the same; priority off still plays', async () => {
  const s = scope();
  Object.assign(globalThis, { AudioWorkletProcessor: s.AudioWorkletProcessor, registerProcessor: s.registerProcessor, sampleRate: 48000 });
  await import('../web/js/audio/worklet.js');
  const P = s.registered['headroom-pcm'];
  assert.equal(typeof P, 'function');
  playsExactly(P, true);
  playsExactly(P, false);
});

test('the worklet takes a decode worker\'s packets only after the main thread\'s, and switches mode on config', () => {
  const s = scope();
  vm.runInNewContext(read('worklet-bundle.js'), s);
  const proc = new s.registered['headroom-pcm']({ processorOptions: {} });
  const ch = new Port();
  proc.port.deliver({ type: 'port', port: ch });
  ch.deliver({ type: 'hello' });
  assert.deepEqual(proc.port.sent.map(m => m.type), ['hello'], 'the channel says it works');
  const frames = n => ({ left: new Float32Array(480).fill(n / 100), right: new Float32Array(480).fill(n / 100) });
  ch.deliver({ type: 'pcm', seq: 3, timeUs: 0, codec: 0, ...frames(3) }); // the worker's first, early
  proc.port.deliver({ type: 'pcm', seq: 1, timeUs: 0, codec: 0, ...frames(1) });
  proc.port.deliver({ type: 'pcm', seq: 2, timeUs: 0, codec: 0, ...frames(2) });
  proc.port.deliver({ type: 'route' });
  ch.deliver({ type: 'pcm', seq: 4, timeUs: 0, codec: 0, ...frames(4) });
  const L = new Float32Array(128), seen = [];
  for (let k = 0; k < 20; k++) { proc.process([], [[L, new Float32Array(128)]]); for (const v of L) if (v && seen.at(-1) !== v) seen.push(v); }
  assert.deepEqual(seen.map(v => Math.round(v * 100)), [1, 2, 3, 4], 'in seq order');
  proc.port.deliver({ type: 'config', priority: true });
  assert.equal(proc.playout.mode, 'priority');
});

// ------------------------------------------------------------------------------------------- the feed

/** A WebCodecs-like Opus decoder: outputs in decode order, after a delay, with the chunk's timestamp. */
function fakeCodecs({ fail = () => false } = {}) {
  const decoders = [];
  class EncodedAudioChunk { constructor(o) { Object.assign(this, o); } }
  class AudioDecoder {
    constructor(cb) { this.cb = cb; this.state = 'unconfigured'; this.pending = []; decoders.push(this); }
    configure() { this.state = 'configured'; }
    decode(chunk) { if (this.state !== 'configured') throw new Error('not configured'); this.pending.push(chunk); }
    close() { this.state = 'closed'; }
    /** Lets n decodes finish. */
    finish(n = Infinity) {
      while (n-- > 0 && this.pending.length) {
        const c = this.pending.shift();
        if (fail(c)) { this.state = 'closed'; this.pending = []; this.cb.error(new Error('decode failed')); return; }
        const v = c.data[0] / 100;
        this.cb.output({
          timestamp: c.timestamp, numberOfFrames: 480, numberOfChannels: 2,
          copyTo(dst, o = {}) { // frame i of this packet is v + i / 1e6
            const off = o.frameOffset || 0, n = o.frameCount ?? 480 - off;
            for (let j = 0; j < n; j++) dst[j] = v + (off + j) / 1e6;
          },
          close() { },
        });
      }
    }
  }
  return { decoders, EncodedAudioChunk, AudioDecoder };
}

test('the feed keeps Opus, PCM and silence in seq order around the decoder, and drops what fails', async t => {
  t.mock.method(console, 'warn', () => { }); // the failing decode below is on purpose
  const fake = fakeCodecs({ fail: c => c.data[0] === 66 });
  Object.assign(globalThis, { AudioDecoder: fake.AudioDecoder, EncodedAudioChunk: fake.EncodedAudioChunk });
  const { AudioFeed } = await import('../web/js/audio/feed.js');
  const posted = [];
  const feed = new AudioFeed((m, transfer) => posted.push([m, transfer]));
  const opus = (seq, v) => feed.packet({ codec: 0, seq, timeUs: seq * 10000, data: new Uint8Array([v, 1, 2]) });
  opus(1, 10);
  opus(2, 20);
  feed.packet({ codec: 2, seq: 3, timeUs: 30000, data: new Uint8Array([224, 1]) });
  const pcmBytes = new Uint8Array(32).subarray(16); // a view into a bigger message: copied, then handed over
  feed.packet({ codec: 1, seq: 4, timeUs: 40000, data: pcmBytes });
  assert.equal(posted.length, 0, 'nothing overtakes the Opus still decoding');
  assert.equal(feed.idle, false);
  fake.decoders[0].finish(1);
  assert.deepEqual(posted.map(([m]) => [m.type, m.seq]), [['pcm', 1]]);
  fake.decoders[0].finish();
  assert.deepEqual(posted.map(([m]) => [m.type, m.seq]), [['pcm', 1], ['pcm', 2], ['silence', 3], ['pcm24', 4]]);
  assert.equal(posted[0][0].left[0], Math.fround(0.1));
  assert.equal(posted[0][0].left.length, 480, 'no trim unless asked (priority off: as before)');
  assert.equal(posted[3][0].bytes.byteLength, 16);
  assert.deepEqual(posted[3][1], [posted[3][0].bytes], 'PCM bytes are transferred to the worklet');
  assert.ok(feed.idle);
  // A decode that fails: that packet is lost (the worklet sees the gap), the ones behind it still go, in order.
  // (After the lossless packet, Opus is a new stream: a fresh decoder.)
  opus(5, 66);
  feed.packet({ codec: 2, seq: 6, timeUs: 60000, data: new Uint8Array([224, 1]) });
  assert.equal(fake.decoders.length, 2);
  fake.decoders[1].finish();
  assert.deepEqual(posted.slice(4).map(([m]) => [m.type, m.seq]), [['silence', 6]]);
  assert.equal(feed.lost, 1);
  feed.close();
});

test('priority: a fresh Opus decoder loses its 120-frame lookahead, also after lossless; silence never resets it', async () => {
  const fake = fakeCodecs();
  Object.assign(globalThis, { AudioDecoder: fake.AudioDecoder, EncodedAudioChunk: fake.EncodedAudioChunk });
  const { AudioFeed, OPUS_LOOKAHEAD } = await import('../web/js/audio/feed.js');
  assert.equal(OPUS_LOOKAHEAD, 120);
  const posted = [];
  const feed = new AudioFeed(m => posted.push(m), { trim: OPUS_LOOKAHEAD });
  const opus = (seq, v) => feed.packet({ codec: 0, seq, timeUs: seq * 10000, data: new Uint8Array([v]) });
  const silence = seq => feed.packet({ codec: 2, seq, timeUs: seq * 10000, data: new Uint8Array([224, 1]) });
  opus(1, 10); opus(2, 20); silence(3); silence(4); opus(5, 50);
  fake.decoders[0].finish();
  assert.equal(fake.decoders.length, 1, 'one decoder across silence packets');
  const first = posted[0];
  assert.equal(first.left.length, 360);
  assert.equal(first.trim, 120);
  assert.equal(first.left[0], Math.fround(0.1 + 120 / 1e6), 'frames 120.. of the first output');
  assert.equal(posted[1].left.length, 480);
  assert.equal(posted[1].trim, undefined);
  assert.equal(posted.at(-1).left.length, 480, 'after silence: the same decoder, nothing dropped');
  // Lossless, then Opus again (a step down): a fresh decoder, its lookahead dropped too.
  feed.packet({ codec: 1, seq: 6, timeUs: 60000, data: new Uint8Array(2880) });
  opus(7, 70);
  assert.equal(fake.decoders.length, 2, 'a fresh decoder for the new Opus stream');
  assert.equal(fake.decoders[0].state, 'closed', 'the old one is closed');
  fake.decoders[1].finish();
  const after = posted.at(-1);
  assert.deepEqual([after.seq, after.left.length, after.trim], [7, 360, 120]);
  feed.close();
});

// ------------------------------------------------------------------------------------------- the player

test('the player plays lossless without an Opus decoder, falls back to the one-file worklet, and routes each codec', async () => {
  delete globalThis.AudioDecoder;
  delete globalThis.EncodedAudioChunk;
  globalThis.window = globalThis.window || {};
  globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false }));
  const loaded = [], nodes = [];
  let registered = false;
  class AudioWorkletNode {
    constructor(ctx, name, options) {
      if (!registered) throw new DOMException('not registered', 'InvalidStateError');
      this.options = options;
      this.port = new Port();
      nodes.push(this);
    }
    connect(x) { return x; }
    disconnect() { }
  }
  class AudioContext {
    constructor(o) { this.sampleRate = o.sampleRate; this.state = 'running'; this.destination = {}; }
    get audioWorklet() {
      return {
        addModule: async url => {
          loaded.push(String(url).split('/').pop());
          if (String(url).endsWith('worklet-bundle.js')) registered = true; // worklet.js: Safari 14 resolves, registers nothing
        },
      };
    }
    createGain() { return { gain: { value: 0 }, connect: x => x }; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  Object.assign(globalThis, { AudioContext, AudioWorkletNode });
  const { AudioPlayer } = await import(`../web/js/audio/player.js?no-decoder`);
  const p = new AudioPlayer();
  assert.equal(p.supported, true, 'an AudioWorklet is enough');
  assert.equal(p.opusSupported, false, 'no AudioDecoder: only lossless plays, so the session asks for it');
  p.configure({ priority: true, quality: 'lossless', mode: 'pcm24' });
  await p.unlock();
  p.setEnabled(true);
  assert.deepEqual(loaded, ['worklet.js', 'worklet-bundle.js']);
  const node = nodes[0];
  assert.equal(node.options.processorOptions.priority, true);
  assert.deepEqual(node.port.sent.map(m => m.type), ['config']);
  let told = 0;
  p.addEventListener('opus-unsupported', () => told++);
  p.packet({ codec: 1, seq: 1, timeUs: 0, data: new Uint8Array(2880) });
  p.packet({ codec: 2, seq: 2, timeUs: 10000, data: new Uint8Array([224, 1]) });
  p.packet({ codec: 0, seq: 3, timeUs: 20000, data: new Uint8Array([1, 2, 3]) });
  p.packet({ codec: 0, seq: 4, timeUs: 30000, data: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(node.port.sent.slice(1).map(m => [m.type, m.seq]), [['pcm24', 1], ['silence', 2]]);
  assert.equal(node.port.sent[1].bytes.byteLength, 2880);
  assert.equal(told, 1, 'Opus that can\'t be decoded is reported once');
  let stats = null;
  p.addEventListener('stats', e => { stats = e.detail; });
  node.port.deliver({ type: 'stats', stats: { bufferedMs: 120, underruns: 0 } });
  assert.equal(stats.bufferedMs, 120);
  assert.equal(p.stats.bufferedMs, 120);
  p.configure({ priority: false });
  assert.deepEqual(node.port.sent.at(-1), { type: 'config', priority: false });
  p.close();
  assert.equal(p.ctx, null);
  assert.equal(p.stats, null);
});
