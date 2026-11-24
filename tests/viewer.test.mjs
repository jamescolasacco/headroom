import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = {};
globalThis.matchMedia = () => ({ matches: false });
const { Connection } = await import('../web/js/connection.js');
const { SoftKeyboard } = await import('../web/js/input/softkbd.js');

class Socket {
  static OPEN = 1;
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
