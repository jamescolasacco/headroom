// End-to-end tests of the account server's API on a throwaway data directory: node test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-accounts-'));
process.env.DATA_DIR = dir;
process.env.SIGNUP = 'first';
const { createApp, Store, totpCode } = await import('./server.mjs');
const store = new Store(dir);
const app = createApp({ store });
const server = http.createServer(app);
server.on('upgrade', app.upgrade);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, p, body, token) {
  const r = await fetch(base + p, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

let viewer, computer, phone;
await test('info advertises the service and open first sign-up', async () => {
  const r = await call('GET', '/api/info');
  assert.equal(r.body.service, 'headroom-account-server');
  assert.equal(r.body.signup, true);
});
await test('register rejects bad input', async () => {
  assert.equal((await call('POST', '/api/account/register', { username: 'x', password: 'longenough' })).body.error, 'bad-username');
  assert.equal((await call('POST', '/api/account/register', { username: 'sam', password: 'short' })).body.error, 'weak-password');
});
await test('first account registers and is signed in', async () => {
  const r = await call('POST', '/api/account/register', { username: 'Sam', password: 'correct horse', deviceName: 'Mac' });
  assert.equal(r.status, 200);
  assert.equal(r.body.account.username, 'sam');
  viewer = r.body;
});
await test('sign-up closes after the first account', async () => {
  const r = await call('POST', '/api/account/register', { username: 'eve', password: 'correct horse' });
  assert.equal(r.status, 403);
  assert.equal((await call('GET', '/api/info')).body.signup, false);
});
await test('wrong password and unknown user look the same', async () => {
  const a = await call('POST', '/api/account/login', { username: 'sam', password: 'nope nope' });
  const b = await call('POST', '/api/account/login', { username: 'nobody', password: 'nope nope' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.body.error, 'bad-credentials'); assert.equal(b.body.error, 'bad-credentials');
});
await test('a computer joins with the account password', async () => {
  const r = await call('POST', '/api/account/login', { username: 'sam', password: 'correct horse', deviceName: 'Studio iMac', kind: 'computer' });
  assert.equal(r.status, 200);
  assert.equal(r.body.device.kind, 'computer');
  computer = r.body;
});
let beat;
await test('heartbeat publishes the computer and returns its device hashes', async () => {
  const r = await call('POST', '/api/computer/heartbeat', {
    hostId: 'host-1', name: 'Studio iMac', os: 'macos', urls: ['https://studio.local:7443/', 'http://ignored/'], spki: 'c3BraQ==', fingerprint: 'AAAA BBBB',
  }, computer.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.devices.length, 1);
  assert.equal(r.body.devices[0].id, viewer.device.id);
  beat = r.body;
});
await test('a viewer lists computers with a per-computer token matching the hash', async () => {
  const r = await call('GET', '/api/account/computers', null, viewer.token);
  assert.equal(r.body.computers.length, 1);
  const c = r.body.computers[0];
  assert.deepEqual(c.urls, ['https://studio.local:7443/']);
  assert.equal(c.online, true);
  assert.equal(sha(c.token), beat.devices[0].tokenHash);
  assert.notEqual(c.token, viewer.token);
});
await test('computers can only check in', async () => {
  assert.equal((await call('GET', '/api/account/computers', null, computer.token)).status, 403);
  assert.equal((await call('GET', '/api/account/devices', null, computer.token)).status, 403);
});
await test('a second device gets its own, different token', async () => {
  phone = (await call('POST', '/api/account/login', { username: 'sam', password: 'correct horse', deviceName: 'iPhone' })).body;
  const t1 = (await call('GET', '/api/account/computers', null, viewer.token)).body.computers[0].token;
  const t2 = (await call('GET', '/api/account/computers', null, phone.token)).body.computers[0].token;
  assert.notEqual(t1, t2);
  const hb = (await call('POST', '/api/computer/heartbeat', { hostId: 'host-1', name: 'Studio iMac' }, computer.token)).body;
  assert.equal(hb.devices.length, 2);
});
await test('view-only propagates to computers', async () => {
  await call('POST', `/api/account/devices/${phone.device.id}`, { viewOnly: true }, viewer.token);
  const hb = (await call('POST', '/api/computer/heartbeat', { hostId: 'host-1' }, computer.token)).body;
  assert.equal(hb.devices.find(d => d.id === phone.device.id).viewOnly, true);
});
await test('removing a device drops it from check-ins and signs it out', async () => {
  assert.equal((await call('DELETE', `/api/account/devices/${phone.device.id}`, null, viewer.token)).status, 200);
  const hb = (await call('POST', '/api/computer/heartbeat', { hostId: 'host-1' }, computer.token)).body;
  assert.equal(hb.devices.some(d => d.id === phone.device.id), false);
  assert.equal((await call('GET', '/api/account/me', null, phone.token)).status, 401);
});
await test('two-factor: setup, enable, then required to sign in', async () => {
  const setup = (await call('POST', '/api/account/totp/setup', null, viewer.token)).body;
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await call('POST', '/api/account/totp/enable', { code: totpCode(setup.secret, step) }, viewer.token)).status, 200);
  assert.equal((await call('POST', '/api/account/login', { username: 'sam', password: 'correct horse' })).body.error, 'totp-required');
  // The enabling code can't be replayed; the next step's code works.
  assert.equal((await call('POST', '/api/account/login', { username: 'sam', password: 'correct horse', totp: totpCode(setup.secret, step) })).body.error, 'bad-totp');
  const ok = await call('POST', '/api/account/login', { username: 'sam', password: 'correct horse', totp: totpCode(setup.secret, step + 1) });
  assert.equal(ok.status, 200);
});
await test('repeated failures are rate limited', async () => {
  let last;
  for (let i = 0; i < 7; i++) last = await call('POST', '/api/account/login', { username: 'mallory', password: 'guess ' + i });
  assert.equal(last.status, 429);
  assert.ok(last.body.retryAfter > 0);
});
// ------------------------------------------------------------------------------------------------ relay
// A fake computer: a control WebSocket, and tunnel WebSockets piped to its own HTTP server (like the Windows host).
function relayUpgrade(p, headers = {}) { // for checking refusals: a plain HTTP upgrade request
  return new Promise((resolve, reject) => {
    const r = http.request(base + p, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...headers } });
    r.on('upgrade', (res, socket) => { socket.destroy(); resolve({ res }); });
    r.on('response', res => { res.resume(); res.on('end', () => resolve({ res })); });
    r.on('error', reject);
    r.end();
  });
}
const seen = [];
const fakeHost = http.createServer((req, res) => {
  seen.push({ url: req.url, client: req.headers['x-headroom-client'] });
  let n = 0;
  req.on('data', d => { n += d.length; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/info' ? { host: { id: 'host-1', name: 'Fake' } } : { received: n, path: req.url }));
  });
});
fakeHost.on('upgrade', (req, socket) => { // a WebSocket that echoes short text messages
  seen.push({ url: req.url, client: req.headers['x-headroom-client'], ws: true });
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', buf => {
    if ((buf[0] & 0x0f) !== 1) return;
    const len = buf[1] & 0x7f, mask = buf.subarray(2, 6);
    const text = Buffer.from(buf.subarray(6, 6 + len)).map((b, i) => b ^ mask[i % 4]).toString();
    const out = Buffer.from('echo:' + text);
    socket.write(Buffer.concat([Buffer.from([0x81, out.length]), out]));
  });
});
await new Promise(r => fakeHost.listen(0, '127.0.0.1', r));
const wsBase = base.replace('http', 'ws');

function openTunnel(nonce) {
  const ws = new WebSocket(`${wsBase}/api/relay/tunnel/${nonce}`);
  ws.binaryType = 'arraybuffer';
  const tcp = net.connect(fakeHost.address().port, '127.0.0.1');
  const early = [];
  ws.onopen = () => { for (const d of early) ws.send(d); early.length = 0; };
  tcp.on('data', d => { if (ws.readyState === 1) ws.send(d); else early.push(d); });
  ws.onmessage = e => tcp.write(Buffer.from(e.data));
  ws.onclose = () => tcp.destroy();
  tcp.on('close', () => ws.close());
}
let control, relayId;
function connectControl() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/api/relay/control`, { headers: { Authorization: `Bearer ${computer.token}` } });
    control = ws;
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.t === 'hello') resolve(msg.relayId);
      if (msg.t === 'open') { assert.equal(msg.client, '127.0.0.1'); openTunnel(msg.id); }
    };
    ws.onerror = () => reject(new Error('control connection failed'));
  });
}
const getJson = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json().catch(() => null) }; };

await test('relay: the control connection needs a computer credential', async () => {
  assert.equal((await relayUpgrade('/api/relay/control')).res.statusCode, 401);
  assert.equal((await relayUpgrade('/api/relay/control', { Authorization: `Bearer ${viewer.token}` })).res.statusCode, 403);
  assert.equal((await relayUpgrade('/api/relay/tunnel/notarealnonceatallreally')).res.statusCode, 404);
});
await test('relay: a computer connects and gets a 9-digit Headroom ID', async () => {
  relayId = await connectControl();
  assert.match(relayId, /^[1-9]\d{8}$/);
  const c = (await call('GET', '/api/account/computers', null, viewer.token)).body.computers[0];
  assert.equal(c.relayId, relayId);
  assert.equal(c.relayOnline, true);
});
await test('relay: requests reach the computer, with the viewer\'s address', async () => {
  const r = await getJson(`/r/${relayId}/api/info`);
  assert.equal(r.status, 200);
  assert.equal(r.body.host.id, 'host-1');
  assert.equal(seen.at(-1).client, '127.0.0.1');
});
await test('relay: a viewer can\'t forge its address', async () => {
  await getJson(`/r/${relayId}/api/info`, { headers: { 'X-Headroom-Client': '6.6.6.6' } });
  assert.equal(seen.at(-1).client, '127.0.0.1');
});
await test('relay: request bodies stream through (uploads)', async () => {
  const r = await getJson(`/r/${relayId}/api/files/upload?name=a.bin`, { method: 'POST', body: Buffer.alloc(300_000, 7) });
  assert.equal(r.body.received, 300_000);
  assert.equal(r.body.path, '/api/files/upload?name=a.bin');
});
await test('relay: only session paths are forwarded (no pairing, no settings)', async () => {
  for (const p of ['/api/pair', '/api/admin/status', '/', '/index.html', '/api/files/../admin/status']) {
    assert.equal((await getJson(`/r/${relayId}${p}`)).status, 403, p);
  }
});
await test('relay: WebSockets go through', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/r/${relayId}/ws`);
  const reply = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send('hi');
    ws.onmessage = e => resolve(e.data);
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  ws.close();
  assert.equal(reply, 'echo:hi');
  assert.equal(seen.at(-1).ws, true);
});
await test('relay: unknown and offline IDs are told apart; the ID survives reconnecting', async () => {
  const unknown = relayId === '123456789' ? '987654321' : '123456789';
  assert.equal((await getJson(`/r/${unknown}/api/info`)).body.error, 'unknown-id');
  control.close();
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await getJson(`/r/${relayId}/api/info`)).body.error, 'offline');
  assert.equal((await call('GET', '/api/account/computers', null, viewer.token)).body.computers[0].relayOnline, false);
  assert.equal(await connectControl(), relayId);
});

await test('leaving: a computer signs itself out and disappears (and drops off the relay)', async () => {
  assert.equal((await call('POST', '/api/account/logout', null, computer.token)).status, 200);
  assert.equal((await call('GET', '/api/account/computers', null, viewer.token)).body.computers.length, 0);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(control.readyState, WebSocket.CLOSED);
});
await test('no secrets in the database', async () => {
  const db = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  assert.equal(db.includes(viewer.token), false);
  assert.equal(db.includes('correct horse'), false);
});

store.save = () => { }; // a batched last-seen write may still be pending
server.close();
server.closeAllConnections?.();
fs.rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode ? '\nSome tests failed.' : `\nAll ${passed} tests passed.`);
process.exit(process.exitCode ?? 0); // relay sockets and timers would keep the process alive
