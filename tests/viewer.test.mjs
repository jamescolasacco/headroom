import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = {};
globalThis.matchMedia = () => ({ matches: false });
const { Connection } = await import('../web/js/connection.js');
const { SoftKeyboard } = await import('../web/js/input/softkbd.js');

class Socket {
  static OPEN = 1;
  static CLOSING = 2;
  constructor() { this.readyState = 0; this.sent = []; }
  open() { this.readyState = Socket.OPEN; this.onopen(); }
  message(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

globalThis.WebSocket = Socket;

test('a replacement socket waits for its own welcome and ignores queued events from the old one', t => {
  const c = new Connection({ url: 'https://host.example', token: 'test' });
  t.after(() => c.close());
  c.connect();
  const old = c.ws;
  old.open();
  old.message({ t: 'welcome' });
  c.reconnectNow();
  const next = c.ws;
  next.open();
  old.message({ t: 'welcome', resumeToken: 'stale' });
  c.sendJson({ t: 'keyframe' });
  c.sendBinary(new ArrayBuffer(1));
  assert.equal(Boolean(c.isOpen), false);
  assert.equal(c.host.token, 'test');
  assert.deepEqual(next.sent.map(JSON.parse).map(m => m.t), ['hello']);
  next.message({ t: 'welcome' });
  c.sendJson({ t: 'keyframe' });
  assert.equal(JSON.parse(next.sent.at(-1)).t, 'keyframe');
});

test('bringing the viewer to the foreground after the host ends a session leaves it closed', t => {
  const c = new Connection({ url: 'https://host.example', token: 'test' });
  t.after(() => c.close());
  c.connect();
  c.ws.open();
  c.ws.message({ t: 'error', code: 'ended' });
  c.ws.onclose({ code: 1000 });
  c.reconnectNow();
  assert.equal(c.state, 'closed');
  assert.equal(c.ws, null);
});

test('mobile text goes to the current session after leaving and rejoining', () => {
  const sink = new EventTarget();
  sink.setSelectionRange = () => {};
  const sent = [];
  for (let session = 0; session < 20; session++) {
    const life = new AbortController();
    new SoftKeyboard({ sink, signal: life.signal, conn: { sendJson: m => sent.push([session, m.s]) } });
    sink.value = sink.value.slice(0, 12) + 'hello' + sink.value.slice(12);
    sink.dispatchEvent(new Event('input'));
    life.abort();
  }
  assert.deepEqual(sent, Array.from({ length: 20 }, (_, i) => [i, 'hello']));
});

const { VideoPresenter } = await import('../web/js/video/presenter.js');
const { DecoderCore } = await import('../web/js/video/decoder-core.js');
const canvas = () => ({ cloneNode: canvas, replaceWith() {} });

test('cancel during the video worker probe disposes resources without starting a renderer', async t => {
  let worker;
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage() {}
    terminate() { this.terminated = true; }
  };
  t.after(() => delete globalThis.Worker);
  const presenter = new VideoPresenter({ canvas: canvas(), video: {} });
  const starting = presenter.start();
  presenter.close();
  await starting;
  assert.equal(worker.terminated, true);
  assert.equal(presenter.core, null);
  assert.equal(presenter.mode, null);
});

test('a worker that reports video track support but fails initialization falls back to canvas', async t => {
  globalThis.Worker = class {
    postMessage(m) {
      queueMicrotask(() => {
        if (m.type === 'probe') this.onmessage({ data: { type: 'caps', decoder: true, vtg: true } });
        else this.onerror(new Error('track unavailable'));
      });
    }
    terminate() {}
  };
  t.after(() => delete globalThis.Worker);
  const presenter = new VideoPresenter({ canvas: canvas(), video: {}, preference: 'video' });
  t.after(() => presenter.close());
  await presenter.start();
  assert.equal(presenter.mode, 'main-canvas');
  assert.ok(presenter.core);
});

test('frame timing stays bounded through a long session with the stats overlay closed', () => {
  const p = new VideoPresenter({ canvas: canvas(), video: {} });
  p.frameTimes = Array.from({ length: 20000 }, (_, i) => performance.now() - 22000 + i);
  p._onWorker({ type: 'decoded' });
  assert.equal(p.frameTimes.length, 1);
  p.close();
});

test('closing a failed decoder cancels its queued recovery', async () => {
  const core = new DecoderCore({ kind: 'canvas' }, () => {});
  let reopened = false;
  core.config = {};
  core._createDecoder = () => { reopened = true; };
  core._error(new Error('decode stopped'));
  core.close();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(reopened, false);
});

test('switching apps while a guest is waiting keeps the same approval request', t => {
  const c = new Connection({ url: 'https://host.test', support: 'guest' });
  t.after(() => c.close());
  c.connect();
  const socket = c.ws;
  socket.open();
  socket.message({ t: 'pending' });
  c.resume();
  assert.equal(c.ws, socket);
  assert.equal(socket.sent.length, 1);
  socket.message({ t: 'welcome' });
  c.resume();
  assert.equal(JSON.parse(socket.sent.at(-1)).t, 'keyframe');
});

test('a new video config waits for the host\'s keyframe; a decoder reset mid-stream asks for one', async t => {
  const decoders = [];
  globalThis.VideoDecoder = class {
    constructor(init) { this.init = init; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = []; decoders.push(this); }
    configure() { this.state = 'configured'; }
    decode(chunk) { this.chunks.push(chunk); }
    close() { this.state = 'closed'; }
  };
  globalThis.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
  t.after(() => { delete globalThis.VideoDecoder; delete globalThis.EncodedVideoChunk; });
  const posted = [];
  const core = new DecoderCore({ kind: 'vtg', writer: { desiredSize: 1, write: async () => {} } }, m => posted.push(m));
  t.after(() => core.close());
  const asks = () => posted.filter(m => m.type === 'need-keyframe').map(m => m.reason);
  // A session's first config (the worker's clock has barely started), then a resolution change: the host sends
  // the new epoch's keyframe right after its config either way.
  core.configure({ epoch: 1, codec: 'avc1.640028', description: new ArrayBuffer(8), width: 1280, height: 720 });
  core.decode({ epoch: 1, frameId: 1, key: true, data: new ArrayBuffer(4), ts: 1 });
  core.keyRequestAt = -Infinity; // (no earlier request to throttle against)
  core.configure({ epoch: 2, codec: 'avc1.640028', description: new ArrayBuffer(8), width: 640, height: 360 });
  assert.deepEqual(asks(), []);
  // A delta before any keyframe can't be decoded: dropped, and a keyframe asked for (even right at the start).
  core.decode({ epoch: 2, frameId: 2, key: false, data: new ArrayBuffer(4), ts: 2 });
  assert.deepEqual(asks(), ['waiting-for-key']);
  assert.equal(decoders.at(-1).chunks.length, 0);
  core.decode({ epoch: 2, frameId: 3, key: true, data: new ArrayBuffer(4), ts: 3 });
  assert.equal(decoders.at(-1).chunks.length, 1);
  // The decoder fails mid-epoch: it's recreated and nothing more is coming by itself, so it asks.
  core.keyRequestAt = -Infinity;
  decoders.at(-1).init.error(new Error('decode failed'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(asks(), ['waiting-for-key', 'reset']);
  assert.equal(decoders.at(-1).state, 'configured');
});

test('a guest whose session can no longer be resumed is told it ended instead of reconnecting forever', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  const tryFor = (host, ms) => {
    const c = new Connection(host);
    const fatal = [];
    c.addEventListener('fatal', e => fatal.push(e.detail));
    c.connect();
    c.ws.open();
    c.ws.message({ t: 'welcome', resumeToken: 'key', relayPath: '/r/abcdefghijkl', support: !!host.support });
    // The connection drops, and every try after it fails (the computer came back under another relay address).
    c.ws.onclose({ code: 1006 });
    let tries = 0;
    for (let waited = 0; waited < ms && c.state !== 'closed'; waited += 6100) {
      t.mock.timers.tick(6100);
      if (c.ws) { tries++; c.ws.onclose({ code: 1006 }); }
    }
    return { c, fatal, tries };
  };
  const guest = tryFor({ url: 'https://relay.test/c/1234', name: 'Studio Mac', support: { code: '123456789', name: 'Sam' } }, 600_000);
  assert.equal(guest.c.state, 'closed');
  assert.deepEqual(guest.fatal.map(f => f.code), ['ended']);
  assert.match(guest.fatal[0].message, /connection to Studio Mac was lost/);
  assert.ok(guest.tries > 10 && guest.tries < 40, `tried ${guest.tries} times`);
  guest.c.resume();
  guest.c.reconnectNow();
  assert.equal(guest.c.ws, null);
  // Your own computer may just be asleep: that keeps being tried.
  const own = tryFor({ url: 'https://relay.test/r/123456789', name: 'Studio Mac', token: 'device-key' }, 600_000);
  assert.equal(own.c.state, 'reconnecting');
  assert.deepEqual(own.fatal, []);
  own.c.close();
});

test('a guest whose tries connect but never get back in also ends once its resume key has run out', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  const c = new Connection({ url: 'https://relay.test/c/1234', name: 'Studio Mac', support: { code: '123456789', name: 'Sam' } });
  const fatal = [];
  c.addEventListener('fatal', e => fatal.push(e.detail));
  c.connect();
  c.ws.open();
  c.ws.message({ t: 'welcome', resumeToken: 'key', relayPath: '/r/abcdefghijkl', support: true });
  c.ws.onclose({ code: 1006 });
  // From now on each try reaches something that accepts the socket and then never answers its hello.
  for (let waited = 0; waited < 600_000 && c.state !== 'closed'; waited += 1000) {
    t.mock.timers.tick(1000);
    if (c.ws && c.ws.readyState === 0) c.ws.open();
  }
  assert.equal(c.state, 'closed');
  assert.deepEqual(fatal.map(f => f.code), ['ended']);
  assert.equal(c.ws, null);
});
