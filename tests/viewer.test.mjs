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
