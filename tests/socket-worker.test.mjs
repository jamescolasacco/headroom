// The connection's socket in a worker (web/js/socket-core.js, run here in Node): what goes to the page, to the
// player's port and to the video worker's port, frame acks on the last fragment, and the page's proxy
// (web/js/connection.js) over a fake Worker that runs the same core, with structured clones and transfers.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false }));
const { SocketCore } = await import('../web/js/socket-core.js');
const { Connection } = await import('../web/js/connection.js');
const { VideoPresenter } = await import('../web/js/video/presenter.js');

class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; FakeSocket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data) { this.onmessage?.({ data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data) }); }
  send(data) { this.sent.push(data); }
  close(code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.closedWith = [code, reason];
    queueMicrotask(() => { this.readyState = 3; this.onclose?.({ code: code ?? 1005, reason: reason ?? '', wasClean: true }); });
  }
}

class FakePort {
  constructor() { this.sent = []; this.closed = false; }
  postMessage(m) { this.sent.push(m); }
  close() { this.closed = true; }
}

function fragment({ flags, frameId, total, offset, payload, epoch = 1, captureUs = 5000, encodeMs = 2.5 }) {
  const b = new ArrayBuffer(28 + payload.length), v = new DataView(b);
  v.setUint8(0, 0x01); v.setUint8(1, flags); v.setUint16(2, epoch, true); v.setUint32(4, frameId, true);
  v.setInt32(8, total, true); v.setInt32(12, offset, true); v.setBigInt64(16, BigInt(captureUs), true); v.setUint16(24, encodeMs * 10, true);
  new Uint8Array(b, 28).set(payload);
  return b;
}

function audio(codec, seq, timeUs, payload) {
  const b = new ArrayBuffer(16 + payload.length), v = new DataView(b);
  v.setUint8(0, 0x03); v.setUint8(1, codec); v.setUint32(4, seq, true); v.setBigInt64(8, BigInt(timeUs), true);
  new Uint8Array(b, 16).set(payload);
  return b;
}

const KEY = 1, FIRST = 2, LAST = 4;

function core() {
  FakeSocket.all = [];
  const page = [];
  const c = new SocketCore({ WebSocket: FakeSocket, post: m => page.push(m), tickMs: 1e9 });
  c.handle({ type: 'open', id: 1, url: 'wss://relay.test/r/abc/ws' });
  const ws = FakeSocket.all[0];
  ws.open();
  return { c, ws, page, stop: () => c._stopTicks() };
}

test('the socket worker passes JSON and the cursor to the page, and counts what came in its ticks', () => {
  const { c, ws, page, stop } = core();
  assert.equal(ws.binaryType, 'arraybuffer');
  assert.deepEqual(page.map(m => m.type), ['open']);
  ws.message({ t: 'welcome' });
  const cursor = new ArrayBuffer(12);
  new DataView(cursor).setUint8(0, 0x02);
  ws.message(cursor);
  assert.deepEqual(page.slice(1).map(m => [m.type, m.id]), [['message', 1], ['message', 1]]);
  assert.equal(JSON.parse(page[1].data).t, 'welcome');
  assert.equal(page[2].data, cursor);
  ws.bufferedAmount = 300;
  c._tick();
  assert.deepEqual({ ...page.at(-1), agoMs: 0 }, { type: 'tick', id: 1, bytes: 12, buffered: 300, agoMs: 0 });
  const n = page.length;
  c._tick(); // nothing new: nothing said
  assert.equal(page.length, n);
  c.handle({ type: 'send', id: 1, data: '{"t":"ping"}' });
  assert.deepEqual(ws.sent, ['{"t":"ping"}']);
  stop();
});

test('a frame is acked on its last fragment, then goes with its epoch\'s config to the video worker\'s port, in order', () => {
  const { c, ws, page, stop } = core();
  const port = new FakePort();
  c.handle({ type: 'video', port, optimizeForLatency: true });
  ws.message({ t: 'video-config', epoch: 1, codec: 'avc1.640028', description: btoa('\x01\x02\x03'), width: 1280, height: 720 });
  ws.message(fragment({ flags: KEY | FIRST, frameId: 7, total: 6, offset: 0, payload: [1, 2, 3] }));
  assert.deepEqual(ws.sent, [], 'no ack before the last fragment');
  ws.message(fragment({ flags: KEY | LAST, frameId: 7, total: 6, offset: 3, payload: [4, 5, 6] }));
  assert.equal(ws.sent.length, 1);
  const ack = new DataView(ws.sent[0]);
  assert.deepEqual([ack.getUint8(0), ack.getUint32(1, true)], [0x15, 7], 'the frame ack');
  assert.deepEqual(port.sent.map(m => m.type), ['config', 'chunk']);
  const [cfg, chunk] = port.sent;
  assert.deepEqual([cfg.epoch, cfg.codec, cfg.width, cfg.height, cfg.optimizeForLatency, [...new Uint8Array(cfg.description)]],
    [1, 'avc1.640028', 1280, 720, true, [1, 2, 3]]);
  assert.deepEqual([chunk.epoch, chunk.frameId, chunk.key, chunk.ts, [...new Uint8Array(chunk.data)]], [1, 7, true, 5000, [1, 2, 3, 4, 5, 6]]);
  const frame = page.find(m => m.type === 'frame');
  assert.equal(frame.data, undefined, 'the page gets the numbers, not the picture');
  assert.deepEqual([frame.frameId, frame.key, frame.encodeMs], [7, true, 2.5]);
  assert.ok(page.some(m => m.type === 'message' && m.data.includes('video-config')), 'the page still hears of the config');
  // No port (or it's taken away): the page gets the whole frame, as before.
  c.handle({ type: 'video', port: null });
  assert.equal(port.closed, true);
  ws.message(fragment({ flags: FIRST | LAST, frameId: 8, total: 2, offset: 0, payload: [9, 9] }));
  assert.deepEqual([...page.at(-1).data], [9, 9]);
  assert.equal(ws.sent.length, 2);
  stop();
});

test('sound goes to the page until the player gives a port, then is decoded in the worker and handed on in order', async t => {
  const decoded = [];
  globalThis.EncodedAudioChunk = class { constructor(o) { Object.assign(this, o); } };
  globalThis.AudioDecoder = class {
    constructor(cb) { this.cb = cb; this.state = 'unconfigured'; }
    configure() { this.state = 'configured'; }
    decode(chunk) {
      decoded.push(chunk.timestamp);
      queueMicrotask(() => this.cb.output({
        timestamp: chunk.timestamp, numberOfFrames: 480, numberOfChannels: 2,
        copyTo(dst) { dst.fill(0.25); }, close() { },
      }));
    }
    close() { this.state = 'closed'; }
  };
  t.after(() => { delete globalThis.AudioDecoder; delete globalThis.EncodedAudioChunk; });
  const { c, ws, page, stop } = core();
  ws.message(audio(1, 10, 0, new Uint8Array(2880).fill(7)));
  const early = page.at(-1);
  assert.deepEqual([early.type, early.codec, early.seq, early.timeUs, early.data.length, early.data[0]], ['audio', 1, 10, 0, 2880, 7]);
  const port = new FakePort();
  c.handle({ type: 'audio', port, opus: true, trim: 120 });
  ws.message(audio(1, 11, 10000, new Uint8Array(2880).fill(8)));
  ws.message(audio(2, 12, 20000, new Uint8Array([224, 1])));
  ws.message(audio(0, 13, 30000, new Uint8Array([1, 2, 3])));
  ws.message(audio(2, 14, 40000, new Uint8Array([224, 1]))); // held behind the Opus still decoding
  assert.deepEqual(port.sent.map(m => [m.type, m.seq]), [['hello', undefined], ['pcm24', 11], ['silence', 12]]);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(port.sent.slice(3).map(m => [m.type, m.seq]), [['pcm', 13], ['silence', 14]]);
  assert.equal(port.sent[3].trim, 120, 'a fresh decoder\'s lookahead is dropped (priority)');
  assert.equal(port.sent[3].left.length, 360);
  assert.equal(new Uint8Array(port.sent[1].bytes)[0], 8);
  assert.deepEqual(decoded, [30000]);
  assert.equal(page.filter(m => m.type === 'audio').length, 1, 'nothing more for the page');
  // A route that can't decode Opus says so once; muting takes the port away.
  const plain = new FakePort();
  c.handle({ type: 'audio', port: plain, opus: false, trim: 0 });
  assert.equal(port.closed, true);
  ws.message(audio(0, 15, 50000, new Uint8Array([1])));
  ws.message(audio(0, 16, 60000, new Uint8Array([1])));
  assert.equal(page.filter(m => m.type === 'opus-unsupported').length, 1);
  c.handle({ type: 'audio', port: null });
  ws.message(audio(2, 17, 70000, new Uint8Array([224, 1])));
  assert.equal(page.at(-1).seq, 17);
  stop();
});

test('only the newest socket\'s messages count, a closing one\'s stop, and dispose lets them close first', async () => {
  const { c, ws, page } = core();
  c.handle({ type: 'open', id: 2, url: 'wss://relay.test/r/abc/ws' });
  const next = FakeSocket.all[1];
  ws.message({ t: 'stale' });
  next.open();
  next.message({ t: 'fresh' });
  c.handle({ type: 'close', id: 1 });
  await Promise.resolve();
  assert.deepEqual(page.filter(m => m.type === 'message').map(m => [m.id, JSON.parse(m.data).t]), [[2, 'fresh']]);
  assert.deepEqual(page.filter(m => m.type === 'close').map(m => m.id), [1]);
  c.handle({ type: 'close', id: 2, code: 1000, reason: 'bye' });
  next.message({ t: 'after close' });
  assert.equal(page.filter(m => m.type === 'message').length, 1);
  let exited = false;
  c.onexit = () => { exited = true; };
  c.handle({ type: 'dispose' });
  assert.equal(exited, false, 'its close is still going out');
  await Promise.resolve();
  assert.deepEqual(next.closedWith, [1000, 'bye']);
  assert.equal(exited, true);
});

// ------------------------------------------------------------------------------------------- the page's proxy

/** A Worker running socket-core.js in this process: every message is a structured clone (with its transfers). */
class FakeWorker {
  static all = [];
  static failing = false;
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.terminated = false;
    FakeWorker.all.push(this);
    if (FakeWorker.failing) { setImmediate(() => this.onerror?.({ message: 'no module workers', preventDefault() { } })); return; }
    this.core = new SocketCore({ WebSocket: FakeSocket, post: (m, transfer) => this._toPage(m, transfer), tickMs: 250 });
    this.core.onexit = () => { this.exited = true; };
    this._toPage({ type: 'ready' });
  }
  postMessage(m, transfer = []) {
    const copy = structuredClone(m, { transfer });
    setImmediate(() => { if (!this.terminated) this.core?.handle(copy); });
  }
  _toPage(m, transfer = []) {
    const copy = structuredClone(m, { transfer });
    setImmediate(() => { if (!this.terminated) this.onmessage?.({ data: copy }); });
  }
  terminate() { this.terminated = true; this.core?._stopTicks(); }
}

async function settle(rounds = 12) { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); }

function withWorker(t) {
  FakeSocket.all = [];
  FakeWorker.all = [];
  FakeWorker.failing = false;
  globalThis.Worker = FakeWorker;
  globalThis.__headroomSocketWorker = true;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => { delete globalThis.Worker; delete globalThis.__headroomSocketWorker; });
}

test('the connection in a worker: hello, welcome, sends, ticks and reconnects as before', async t => {
  withWorker(t);
  const c = new Connection({ url: 'https://relay.test/r/abc', token: 'key' });
  const states = [];
  c.addEventListener('state', e => states.push(e.detail.state));
  c.connect();
  await settle();
  assert.equal(FakeWorker.all.length, 1);
  assert.match(FakeWorker.all[0].url, /socket-worker\.js$/);
  assert.deepEqual(FakeWorker.all[0].opts, { type: 'module' });
  const ws = FakeSocket.all[0];
  assert.equal(ws.url, 'wss://relay.test/r/abc/ws');
  ws.open();
  await settle();
  assert.deepEqual(ws.sent.map(JSON.parse).map(m => [m.t, m.token]), [['hello', 'key']]);
  ws.message({ t: 'welcome', resumeToken: 'next' });
  await settle();
  assert.equal(c.isOpen, true);
  assert.equal(c.host.token, 'next');
  assert.deepEqual(states, ['connecting', 'open']);
  c.sendJson({ t: 'keyframe' });
  c.sendBinary(new Uint8Array([0x12, 0, 1]).buffer);
  await settle();
  assert.equal(JSON.parse(ws.sent[1]).t, 'keyframe');
  assert.deepEqual([...new Uint8Array(ws.sent[2])], [0x12, 0, 1]);
  // Bytes, the send buffer and the last message, from the worker's ticks.
  const frames = [];
  c.addEventListener('video-frame', e => frames.push(e.detail));
  ws.message(fragment({ flags: KEY | FIRST | LAST, frameId: 3, total: 4, offset: 0, payload: [1, 2, 3, 4] }));
  ws.bufferedAmount = 512 * 1024;
  t.mock.timers.tick(250);
  await settle();
  assert.equal(c.bytesIn, 32);
  assert.equal(c.buffered, 512 * 1024);
  assert.deepEqual([frames.length, frames[0].frameId, [...frames[0].data]], [1, 3, [1, 2, 3, 4]]);
  assert.equal(new DataView(ws.sent.at(-1)).getUint8(0), 0x15, 'acked by the worker');
  // A new socket replaces it; the old one's late messages count for nothing.
  c.reconnectNow();
  await settle();
  assert.equal(ws.readyState, 3);
  const next = FakeSocket.all[1];
  next.open();
  await settle();
  next.message({ t: 'welcome' });
  await settle();
  assert.equal(c.isOpen, true);
  c.close();
  await settle();
  assert.deepEqual(next.closedWith, [1000, 'bye']);
  assert.equal(FakeWorker.all[0].exited, true, 'the worker goes once its socket has closed');
  assert.equal(c.state, 'closed');
});

test('routed sound and pictures go from the worker to their ports; a worker that can\'t start falls back', async t => {
  withWorker(t);
  const c = new Connection({ url: 'https://relay.test/r/abc', token: 'key' });
  assert.equal(c.offMain, true);
  const sound = new MessageChannel(), video = new MessageChannel();
  const heard = [], shown = [];
  sound.port1.onmessage = e => heard.push(e.data);
  video.port1.onmessage = e => shown.push(e.data);
  t.after(() => { sound.port1.close(); video.port1.close(); });
  assert.equal(c.routeAudio(sound.port2, { opus: false, trim: 0 }), true);
  assert.equal(c.routeVideo(video.port2, { optimizeForLatency: false }), true);
  const events = [];
  c.addEventListener('audio', e => events.push(['audio', e.detail.seq]));
  c.addEventListener('video-frame', e => events.push(['frame', e.detail.frameId, e.detail.data]));
  c.connect();
  await settle();
  const ws = FakeSocket.all[0];
  ws.open();
  ws.message({ t: 'welcome' });
  ws.message({ t: 'video-config', epoch: 2, codec: 'avc1.640028', description: btoa('\x05'), width: 640, height: 360 });
  ws.message(fragment({ flags: KEY | FIRST | LAST, epoch: 2, frameId: 1, total: 2, offset: 0, payload: [7, 7] }));
  ws.message(audio(1, 1, 0, new Uint8Array(2880)));
  await settle(30);
  assert.deepEqual(heard.map(m => m.type), ['hello', 'pcm24']);
  assert.deepEqual(shown.map(m => [m.type, m.epoch]), [['config', 2], ['chunk', 2]]);
  assert.equal(shown[0].optimizeForLatency, false);
  assert.deepEqual(events, [['frame', 1, null]], 'the page hears of the frame (no data) and no sound');
  c.close();
  await settle();

  // No module workers here: the first socket closes and the next try uses a socket of its own; routes are lost.
  FakeWorker.failing = true;
  FakeSocket.all = [];
  const nodeSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  t.after(() => { globalThis.WebSocket = nodeSocket; });
  const d = new Connection({ url: 'https://relay.test/r/abc', token: 'key' });
  let lost = 0;
  const spare = new MessageChannel();
  t.after(() => spare.port1.close());
  assert.equal(d.routeAudio(spare.port2, { onLost: () => lost++ }), true);
  d.connect();
  await settle();
  assert.equal(lost, 1);
  assert.equal(d.offMain, false);
  assert.equal(d.state, 'reconnecting');
  assert.equal(FakeSocket.all.length, 0, 'the worker never made a socket');
  t.mock.timers.tick(5000);
  assert.equal(FakeSocket.all.length, 1, 'a socket on this thread');
  assert.equal(d.ws, FakeSocket.all[0]);
  d.close();
});

test('the presenter hands its video worker the socket worker\'s port and leaves configs and frames to it', async t => {
  const posted = [];
  globalThis.Worker = class {
    postMessage(m) {
      posted.push(m);
      queueMicrotask(() => { if (m.type === 'probe') this.onmessage({ data: { type: 'caps', decoder: true, vtg: false } }); });
    }
    terminate() { }
  };
  t.after(() => delete globalThis.Worker);
  const canvas = () => ({ cloneNode: canvas, replaceWith() { }, transferControlToOffscreen: () => ({}) });
  const p = new VideoPresenter({ canvas: canvas(), video: {} });
  t.after(() => p.close());
  await p.start();
  assert.equal(p.mode, 'worker-canvas');
  let routed = null;
  p.receiveFrom({ offMain: true, routeVideo: (port, o) => { routed = { port, o }; return true; } });
  assert.equal(posted.at(-1).type, 'port');
  assert.ok(routed.port);
  assert.equal(routed.o.optimizeForLatency, true);
  const before = posted.length;
  p.configure({ epoch: 1, codec: 'avc1', description: btoa('\x01'), width: 320, height: 200 });
  p.frame({ epoch: 1, frameId: 1, key: true, data: null, captureUs: 1 });
  assert.equal(posted.length, before, 'nothing posted: the socket worker sent them');
  assert.deepEqual([p.width, p.height], [320, 200]);
  routed.o.onLost();
  p.configure({ epoch: 2, codec: 'avc1', description: btoa('\x01'), width: 320, height: 200 });
  assert.equal(posted.at(-1).type, 'config', 'the worker is gone: the page sends them again');
});
