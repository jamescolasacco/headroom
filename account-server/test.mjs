// End-to-end tests of the account server's API and relay on a throwaway data directory: node test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-accounts-'));
process.env.DATA_DIR = dir;
process.env.BREACH_CHECK = 'off'; // no network in tests
const { createApp, Store, totpCode, passwordProblem } = await import('./server.mjs');
const store = new Store(dir);
// Email goes to an in-memory inbox.
const inbox = new Map();
const mail = (to, subject, text) => { inbox.set(to, [...(inbox.get(to) || []), { subject, text }]); };
const lastMail = to => inbox.get(to)?.at(-1);
const codeFor = to => /Your code: (\d{6})/.exec(lastMail(to)?.text || '')?.[1];
const app = createApp({ store, mail });
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
async function test(name, fn) {
  app.limiter.failures.clear(); // every request here comes from 127.0.0.1: each test starts with a clean slate
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.log(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`); process.exitCode = 1; }
}

const PW = 'violet canyon river 42';
const SAM = 'sam@example.com';
let viewer, computer, phone;

// ------------------------------------------------------------------------------------------ accounts
await test('info: open sign-up, version, no human check configured', async () => {
  const r = await call('GET', '/api/info');
  assert.equal(r.body.service, 'headroom-account-server');
  assert.equal(r.body.signup, true);
  assert.equal(r.body.turnstile, null);
  assert.match(r.body.version, /^0\.4\./);
});
await test('sign-up refuses bad emails and weak passwords', async () => {
  assert.equal((await call('POST', '/api/account/signup', { email: 'not-an-email', password: PW })).body.error, 'bad-email');
  assert.equal((await call('POST', '/api/account/signup', { email: SAM, password: 'short' })).body.error, 'weak-password');
  assert.equal(inbox.size, 0);
});
await test('sign-up emails a code; nothing is stored until it is entered', async () => {
  const r = await call('POST', '/api/account/signup', { email: ' Sam@Example.com ', password: PW });
  assert.equal(r.status, 200);
  assert.match(codeFor(SAM), /^\d{6}$/);
  assert.equal(store.data.accounts.length, 0);
});
await test('"send a new code" replaces the code, only while one is waiting, at most 3 times', async () => {
  const first = codeFor(SAM);
  assert.equal((await call('POST', '/api/account/resend', { email: SAM, kind: 'signup' })).status, 200);
  const second = codeFor(SAM);
  assert.match(second, /^\d{6}$/);
  if (second !== first) assert.equal((await call('POST', '/api/account/verify', { email: SAM, code: first, password: PW })).body.error, 'bad-code');
  for (let i = 0; i < 3; i++) await call('POST', '/api/account/resend', { email: SAM, kind: 'signup' });
  assert.equal(inbox.get(SAM).length, 4); // the first code and 3 resends, no more
  const before = inbox.get('nobody@example.com')?.length || 0;
  assert.equal((await call('POST', '/api/account/resend', { email: 'nobody@example.com', kind: 'signup' })).status, 200);
  assert.equal((inbox.get('nobody@example.com')?.length || 0), before);
});
await test('a wrong code is refused', async () => {
  const wrong = codeFor(SAM) === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/api/account/verify', { email: SAM, code: wrong, password: PW })).body.error, 'bad-code');
});
await test('the right code creates the account and signs in (no alert for the new account)', async () => {
  const before = inbox.get(SAM).length;
  const r = await call('POST', '/api/account/verify', { email: SAM, code: codeFor(SAM), password: PW, deviceName: 'Safari on Mac' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.account.email, SAM);
  assert.equal(r.body.passwordWeak, false);
  assert.equal(inbox.get(SAM).length, before);
  viewer = r.body;
});
await test('a code works once', async () => {
  assert.equal((await call('POST', '/api/account/verify', { email: SAM, code: '123456', password: PW })).body.error, 'bad-code');
});
await test('signing up with a taken email answers the same, and tells the owner instead', async () => {
  const r = await call('POST', '/api/account/signup', { email: SAM, password: 'another good passphrase' });
  assert.equal(r.status, 200);
  assert.match(lastMail(SAM).subject, /tried to create/);
  assert.equal(codeFor(SAM), undefined);
});
await test('someone who starts a sign-up for another person\'s email can\'t set its password', async () => {
  const victim = 'vic@example.com';
  await call('POST', '/api/account/signup', { email: victim, password: 'attacker chosen words 1' });
  // Only the inbox owner has the code, and they choose the password when they enter it.
  const r = await call('POST', '/api/account/verify', { email: victim, code: codeFor(victim), password: 'maple orbit seventy 9' });
  assert.equal(r.status, 200);
  assert.equal((await call('POST', '/api/account/login', { email: victim, password: 'attacker chosen words 1' })).status, 401);
});
await test('wrong password and unknown email look the same', async () => {
  const a = await call('POST', '/api/account/login', { email: SAM, password: 'nope nope nope' });
  const b = await call('POST', '/api/account/login', { email: 'nobody@example.com', password: 'nope nope nope' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.body.error, 'bad-credentials'); assert.equal(b.body.error, 'bad-credentials');
});
await test('every new sign-in is emailed to the owner', async () => {
  const r = await call('POST', '/api/account/login', { email: 'SAM@example.com', password: PW, deviceName: 'Chrome on Windows' });
  assert.equal(r.status, 200);
  assert.match(lastMail(SAM).subject, /New sign-in/);
  assert.match(lastMail(SAM).text, /Chrome on Windows/);
  assert.equal((await call('POST', '/api/account/logout', null, r.body.token)).status, 200);
});
await test('a device joins with the account and the owner is told', async () => {
  const r = await call('POST', '/api/account/login', { email: SAM, password: PW, deviceName: 'Studio iMac', kind: 'computer' });
  assert.equal(r.status, 200);
  assert.equal(r.body.device.kind, 'computer');
  assert.match(lastMail(SAM).subject, /Studio iMac was added/);
  computer = r.body;
});
let beat;
await test('heartbeat publishes the device and returns its sign-ins\' hashes', async () => {
  const r = await call('POST', '/api/computer/heartbeat', {
    hostId: 'host-1', name: 'Studio iMac', os: 'macos', urls: ['https://studio.local:7443/', 'http://ignored/'], spki: 'c3BraQ==', fingerprint: 'AAAA BBBB',
  }, computer.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.account.email, SAM);
  assert.equal(r.body.devices.length, 1);
  assert.equal(r.body.devices[0].id, viewer.device.id);
  beat = r.body;
});
await test('a browser lists the account\'s devices with a per-device token matching the hash', async () => {
  const r = await call('GET', '/api/account/computers', null, viewer.token);
  assert.equal(r.body.computers.length, 1);
  const c = r.body.computers[0];
  assert.deepEqual(c.urls, ['https://studio.local:7443/']);
  assert.equal(c.online, true);
  assert.equal(sha(c.token), beat.devices[0].tokenHash);
  assert.notEqual(c.token, viewer.token);
});
await test('renaming happens on the device (its check-in), not in the browser', async () => {
  await call('POST', '/api/computer/heartbeat', { hostId: 'host-1', name: 'Studio' }, computer.token);
  assert.equal((await call('GET', '/api/account/computers', null, viewer.token)).body.computers[0].name, 'Studio');
  assert.equal(store.device(computer.device.id).name, 'Studio');
});
await test('devices can only check in', async () => {
  assert.equal((await call('GET', '/api/account/computers', null, computer.token)).status, 403);
  assert.equal((await call('GET', '/api/account/devices', null, computer.token)).status, 403);
  assert.equal((await call('POST', '/api/account/password', { current: PW, password: 'x' }, computer.token)).status, 403);
});
await test('a second sign-in gets its own, different token', async () => {
  phone = (await call('POST', '/api/account/login', { email: SAM, password: PW, deviceName: 'Safari on iPhone' })).body;
  const t1 = (await call('GET', '/api/account/computers', null, viewer.token)).body.computers[0].token;
  const t2 = (await call('GET', '/api/account/computers', null, phone.token)).body.computers[0].token;
  assert.notEqual(t1, t2);
  const hb = (await call('POST', '/api/computer/heartbeat', { hostId: 'host-1' }, computer.token)).body;
  assert.equal(hb.devices.length, 2);
});
await test('"where you\'re signed in" lists sign-ins and devices; signing one out works', async () => {
  const list = (await call('GET', '/api/account/devices', null, viewer.token)).body.devices;
  assert.deepEqual(list.map(d => d.name).sort(), ['Safari on Mac', 'Safari on iPhone', 'Studio'].sort());
  assert.equal(list.find(d => d.current).id, viewer.device.id);
  assert.equal((await call('DELETE', `/api/account/devices/${phone.device.id}`, null, viewer.token)).status, 200);
  const hb = (await call('POST', '/api/computer/heartbeat', { hostId: 'host-1' }, computer.token)).body;
  assert.equal(hb.devices.some(d => d.id === phone.device.id), false);
  assert.equal((await call('GET', '/api/account/me', null, phone.token)).status, 401);
});
await test('each account sees only its own devices', async () => {
  const vic = (await call('POST', '/api/account/login', { email: 'vic@example.com', password: 'maple orbit seventy 9' })).body;
  assert.equal((await call('GET', '/api/account/computers', null, vic.token)).body.computers.length, 0);
  assert.equal((await call('DELETE', `/api/account/devices/${computer.device.id}`, null, vic.token)).status, 404);
});
await test('two-factor: setup, enable, then required to sign in', async () => {
  const setup = (await call('POST', '/api/account/totp/setup', null, viewer.token)).body;
  assert.match(setup.uri, /Headroom:sam%40example\.com/);
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await call('POST', '/api/account/totp/enable', { code: totpCode(setup.secret, step) }, viewer.token)).status, 200);
  assert.equal((await call('POST', '/api/account/login', { email: SAM, password: PW })).body.error, 'totp-required');
  // The enabling code can't be replayed; the next step's code works.
  assert.equal((await call('POST', '/api/account/login', { email: SAM, password: PW, totp: totpCode(setup.secret, step) })).body.error, 'bad-totp');
  const ok = await call('POST', '/api/account/login', { email: SAM, password: PW, totp: totpCode(setup.secret, step + 1) });
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', '/api/account/totp/disable', { password: PW }, viewer.token)).status, 200);
  assert.match(lastMail(SAM).subject, /Two-factor sign-in was turned off/);
});
await test('password policy: length, email name, runs, common passwords; passphrases pass', async () => {
  assert.match(await passwordProblem('short pw', 'sam'), /at least 12/);
  assert.match(await passwordProblem('my name is sam ok', 'sam'), /email/);
  assert.match(await passwordProblem('1234567890123', 'x'), /predictable/);
  assert.match(await passwordProblem('qwertyuiopasd', 'x'), /predictable/);
  assert.match(await passwordProblem('aaaaaaaaaaaaaaa', 'x'), /predictable/);
  assert.match(await passwordProblem('Password1234', 'x'), /common/);
  assert.equal(await passwordProblem(PW, 'sam'), null);
  assert.equal(await passwordProblem('ünïcödé pässwörd ok', 'sam'), null);
});

// -------------------------------------------------------------------------- forgot password, changes
const PW2 = 'amber harbor lantern 7';
await test('forgot password answers the same for unknown emails (and sends nothing)', async () => {
  const r = await call('POST', '/api/account/forgot', { email: 'ghost@example.com' });
  assert.equal(r.status, 200);
  assert.equal(inbox.has('ghost@example.com'), false);
});
await test('a reset code sets a new password and signs the browsers out (not the devices)', async () => {
  const other = (await call('POST', '/api/account/login', { email: SAM, password: PW })).body;
  await call('POST', '/api/account/forgot', { email: SAM });
  const code = codeFor(SAM);
  assert.match(code, /^\d{6}$/);
  assert.equal((await call('POST', '/api/account/reset', { email: SAM, code: code === '000000' ? '111111' : '000000', password: PW2 })).body.error, 'bad-code');
  assert.equal((await call('POST', '/api/account/reset', { email: SAM, code, password: PW2 })).status, 200);
  assert.match(lastMail(SAM).subject, /password was changed/);
  assert.equal((await call('GET', '/api/account/me', null, other.token)).status, 401);
  assert.equal((await call('POST', '/api/computer/heartbeat', { hostId: 'host-1' }, computer.token)).status, 200);
  assert.equal((await call('POST', '/api/account/login', { email: SAM, password: PW })).status, 401);
  viewer = (await call('POST', '/api/account/login', { email: SAM, password: PW2, deviceName: 'Safari on Mac' })).body;
  assert.ok(viewer.token);
});
await test('changing the password needs the current one and signs out the other browsers', async () => {
  const other = (await call('POST', '/api/account/login', { email: SAM, password: PW2 })).body;
  assert.equal((await call('POST', '/api/account/password', { current: 'wrong wrong wrong', password: PW }, viewer.token)).status, 401);
  const r = await call('POST', '/api/account/password', { current: PW2, password: PW }, viewer.token);
  assert.equal(r.body.signedOut, 1);
  assert.equal((await call('GET', '/api/account/me', null, other.token)).status, 401);
  assert.equal((await call('GET', '/api/account/me', null, viewer.token)).status, 200);
});
await test('changing the email: a code to the new address, a notice to the old one', async () => {
  const NEW = 'samuel@example.org';
  assert.equal((await call('POST', '/api/account/email', { password: PW, email: 'vic@example.com' }, viewer.token)).body.error, 'exists');
  assert.equal((await call('POST', '/api/account/email', { password: PW, email: NEW }, viewer.token)).status, 200);
  const r = await call('POST', '/api/account/email/verify', { code: codeFor(NEW) }, viewer.token);
  assert.equal(r.body.email, NEW);
  assert.match(lastMail(SAM).subject, /email was changed/);
  assert.equal((await call('POST', '/api/account/login', { email: NEW, password: PW })).status, 200);
  // and back, for the rest of the tests
  await call('POST', '/api/account/email', { password: PW, email: SAM }, viewer.token);
  await call('POST', '/api/account/email/verify', { code: codeFor(SAM) }, viewer.token);
});
await test('a sign-in unused for 90 days expires', async () => {
  const stale = (await call('POST', '/api/account/login', { email: SAM, password: PW, deviceName: 'old' })).body;
  store.data.devices.find(d => d.id === stale.device.id).lastSeen = new Date(Date.now() - 91 * 86_400_000).toISOString();
  assert.equal((await call('GET', '/api/account/me', null, stale.token)).body.error, 'expired');
});
await test('older password hashes are upgraded at sign-in', async () => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync('old style secret words', salt, 32, { N: 16384, r: 8, p: 1 });
  store.data.accounts.push({ id: 'legacy1', email: 'legacy@example.com', totpEnabled: false, created: new Date().toISOString(),
    password: { algorithm: 'scrypt', N: 16384, r: 8, p: 1, salt: salt.toString('base64'), hash: hash.toString('base64') } });
  const r = await call('POST', '/api/account/login', { email: 'legacy@example.com', password: 'old style secret words' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rec = store.account('legacy1').password;
  assert.deepEqual([rec.N, rec.p], [32768, 3]);
});
await test('a disabled account can\'t sign in or be used', async () => {
  const s = (await call('POST', '/api/account/login', { email: 'legacy@example.com', password: 'old style secret words' })).body;
  store.account('legacy1').disabled = true;
  assert.equal((await call('POST', '/api/account/login', { email: 'legacy@example.com', password: 'old style secret words' })).body.error, 'disabled');
  assert.equal((await call('GET', '/api/account/me', null, s.token)).body.error, 'disabled');
});
await test('the web app is served with security headers (Turnstile allowed, nothing else)', async () => {
  const r = await fetch(base + '/');
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
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
  seen.push({ url: req.url, client: req.headers['x-headroom-client'], guest: req.headers['x-headroom-guest'], ws: true });
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
/** A device's control connection: with an account's device token, or none (a device without an account). */
function connectControl(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/api/relay/control`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    ws.replies = [];
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.t === 'hello') { ws.relayId = msg.relayId; resolve(ws); }
      if (msg.t === 'open') { ws.opens = (ws.opens || 0) + 1; ws.lastOpen = msg; openTunnel(msg.id); }
      if (msg.t === 'slot') ws.replies.push(msg);
    };
    ws.onerror = () => reject(new Error('control connection failed'));
    ws.onclose = e => { if (!ws.relayId) reject(new Error('refused')); };
  });
}
/** Asks the relay for a guest-code slot. */
async function askSlot(ws) {
  const id = Math.random().toString(36).slice(2);
  ws.send(JSON.stringify({ t: 'slot', id }));
  for (let i = 0; i < 50; i++) {
    const r = ws.replies.find(m => m.id === id);
    if (r) return r;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('no slot reply');
}
const getJson = async (p, init) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json().catch(() => null) }; };

let control;
await test('relay: browsers\' sign-ins can\'t act as devices; tunnels need a real request', async () => {
  assert.equal((await relayUpgrade('/api/relay/control', { Authorization: `Bearer ${viewer.token}` })).res.statusCode, 403);
  assert.equal((await relayUpgrade('/api/relay/control', { Authorization: 'Bearer nonsense' })).res.statusCode, 401);
  assert.equal((await relayUpgrade('/api/relay/tunnel/notarealnonceatallreally')).res.statusCode, 404);
});
await test('relay: an account device connects and gets a 9-digit relay ID, listed in the account', async () => {
  control = await connectControl(computer.token);
  assert.match(control.relayId, /^[1-9]\d{8}$/);
  const c = (await call('GET', '/api/account/computers', null, viewer.token)).body.computers[0];
  assert.equal(c.relayId, control.relayId);
  assert.equal(c.relayOnline, true);
});
await test('relay: requests reach the device, with the viewer\'s address (which can\'t be forged)', async () => {
  const r = await getJson(`/r/${control.relayId}/api/info`, { headers: { 'X-Headroom-Client': '6.6.6.6', 'X-Headroom-Guest': '1' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.host.id, 'host-1');
  assert.equal(seen.at(-1).client, '127.0.0.1');
});
await test('relay: request bodies stream through (uploads)', async () => {
  const r = await getJson(`/r/${control.relayId}/api/files/upload?name=a.bin`, { method: 'POST', body: Buffer.alloc(300_000, 7) });
  assert.equal(r.body.received, 300_000);
  assert.equal(r.body.path, '/api/files/upload?name=a.bin');
});
await test('relay: only session paths are forwarded (no settings, no web pages)', async () => {
  for (const p of ['/api/pair', '/api/admin/status', '/', '/index.html', '/api/files/../admin/status']) {
    assert.equal((await getJson(`/r/${control.relayId}${p}`)).status, 403, p);
  }
});
await test('relay: WebSockets go through', async () => {
  const ws = new WebSocket(`${wsBase}/r/${control.relayId}/ws`);
  const reply = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send('hi');
    ws.onmessage = e => resolve(e.data);
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  ws.close();
  assert.equal(reply, 'echo:hi');
  assert.equal(seen.at(-1).ws, true);
  assert.equal(seen.at(-1).guest, undefined);
  assert.equal(control.lastOpen.guest, false);
});
await test('relay: unknown and offline devices look the same; the relay ID survives reconnecting', async () => {
  const unknown = control.relayId === '123456789' ? '987654321' : '123456789';
  assert.equal((await getJson(`/r/${unknown}/api/info`)).body.error, 'offline');
  const id = control.relayId;
  control.close();
  await sleep(200);
  assert.equal((await getJson(`/r/${id}/api/info`)).body.error, 'offline');
  assert.equal((await call('GET', '/api/account/computers', null, viewer.token)).body.computers[0].relayOnline, false);
  control = await connectControl(computer.token);
  assert.equal(control.relayId, id);
});

// ------------------------------------------------------------------------------------------- guest codes
let guestHost, slot;
await test('guest codes: a device without an account connects; it gets a long random relay ID and is listed nowhere', async () => {
  guestHost = await connectControl();
  assert.match(guestHost.relayId, /^[\w-]{16}$/);
  assert.equal((await call('GET', '/api/account/computers', null, viewer.token)).body.computers.length, 1);
});
await test('guest codes: a device gets a 4-digit slot; /c/<slot>/ reaches it, marked as a guest', async () => {
  const r = await askSlot(guestHost);
  assert.match(r.slot, /^\d{4}$/);
  assert.ok(Date.parse(r.expires) > Date.now() + 9 * 60_000);
  slot = r.slot;
  assert.equal((await getJson(`/c/${slot}/api/info`)).body.host.id, 'host-1');
  const ws = new WebSocket(`${wsBase}/c/${slot}/ws`);
  const reply = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send('guest');
    ws.onmessage = e => resolve(e.data);
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  ws.close();
  assert.equal(reply, 'echo:guest');
  assert.equal(seen.at(-1).guest, '1');
  assert.equal(guestHost.lastOpen.guest, true);
  assert.equal(guestHost.lastOpen.client, '127.0.0.1');
});
await test('guest codes: only the session goes through a code (no files before the device accepts)', async () => {
  for (const p of ['/api/files/list', '/api/me', '/', '/api/admin/status']) assert.equal((await getJson(`/c/${slot}${p}`)).status, 403, p);
});
await test('guest codes: a new code replaces the old one; releasing it ends it', async () => {
  const r = await askSlot(guestHost);
  if (r.slot !== slot) assert.equal((await getJson(`/c/${slot}/api/info`)).body.error, 'bad-code');
  slot = r.slot;
  guestHost.send(JSON.stringify({ t: 'slot-release' }));
  await sleep(100);
  assert.equal((await getJson(`/c/${slot}/api/info`)).body.error, 'bad-code');
});
await test('guest codes: a code stops working when its device disconnects', async () => {
  slot = (await askSlot(guestHost)).slot;
  guestHost.close();
  await sleep(200);
  assert.equal((await getJson(`/c/${slot}/api/info`)).body.error, 'bad-code');
});
await test('devices without an account: a few per network address', async () => {
  const hosts = [];
  for (let i = 0; i < 5; i++) hosts.push(await connectControl());
  await assert.rejects(connectControl());
  for (const h of hosts) h.close();
});

// ------------------------------------------------------------------------------------------ leaving
await test('leaving: a device signs itself out and disappears (and drops off the relay)', async () => {
  assert.equal((await call('POST', '/api/account/logout', null, computer.token)).status, 200);
  assert.equal((await call('GET', '/api/account/computers', null, viewer.token)).body.computers.length, 0);
  await sleep(200);
  assert.equal(control.readyState, WebSocket.CLOSED);
});
await test('deleting the account needs the password and removes everything', async () => {
  assert.equal((await call('POST', '/api/account/delete', { password: 'wrong wrong wrong' }, viewer.token)).status, 401);
  assert.equal((await call('POST', '/api/account/delete', { password: PW }, viewer.token)).status, 200);
  assert.match(lastMail(SAM).subject, /deleted/);
  assert.equal(store.accountByEmail(SAM), undefined);
  assert.equal((await call('GET', '/api/account/me', null, viewer.token)).status, 401);
});
await test('no secrets in the database', async () => {
  store.save();
  const db = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  assert.equal(db.includes(viewer.token), false);
  assert.equal(db.includes(PW), false);
  assert.equal(db.includes('maple orbit seventy 9'), false);
});

// ------------------------------------------------------------------------------------- rate limits
await test('repeated failures are rate limited', async () => {
  let last;
  for (let i = 0; i < 7; i++) last = await call('POST', '/api/account/login', { email: 'mallory@example.com', password: 'guess guess ' + i });
  assert.equal(last.status, 429);
  assert.ok(last.body.retryAfter > 0);
});
await test('nobody can be flooded with codes', async () => {
  let last;
  for (let i = 0; i < 8; i++) last = await call('POST', '/api/account/forgot', { email: SAM });
  assert.equal(last.status, 429);
});
await test('guest codes: guessing codes is throttled', async () => {
  let last;
  for (let i = 0; i < 8; i++) last = await getJson(`/c/${String(i).padStart(4, '0')}/api/info`);
  assert.equal(last.status, 429);
});

// ------------------------------------------------------------------------------------------------ CLI
await test('CLI: add, list, disable and delete accounts (the operator\'s tools)', async () => {
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-cli-'));
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), ...args],
    { input: PW + '\n', env: { ...process.env, DATA_DIR: cliDir }, encoding: 'utf8' });
  assert.equal(run('add-user', 'Op@Example.com').status, 0);
  assert.match(run('list-users').stdout, /op@example\.com/);
  assert.equal(run('disable-user', 'op@example.com').status, 0);
  assert.match(run('list-users').stdout, /DISABLED/);
  assert.equal(run('delete-user', 'op@example.com').status, 0);
  assert.doesNotMatch(run('list-users').stdout, /op@example\.com/);
  fs.rmSync(cliDir, { recursive: true, force: true });
});
await test('an old (username) database is set aside, not mixed in', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-v1-'));
  fs.writeFileSync(path.join(d, 'db.json'), JSON.stringify({ accounts: [{ username: 'old' }], devices: [], computers: [] }));
  const s = new Store(d);
  assert.equal(s.data.version, 2);
  assert.equal(s.data.accounts.length, 0);
  assert.ok(fs.readdirSync(d).some(f => /^db\.v1-\d+\.json$/.test(f)));
  fs.rmSync(d, { recursive: true, force: true });
});

store.save = () => { }; // a batched last-seen write may still be pending
server.close();
server.closeAllConnections?.();
fs.rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode ? '\nSome tests failed.' : `\nAll ${passed} tests passed.`);
process.exit(process.exitCode ?? 0); // relay sockets and timers would keep the process alive
