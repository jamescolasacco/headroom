// End-to-end tests of the account server's API on a throwaway data directory: node test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-accounts-'));
process.env.DATA_DIR = dir;
process.env.SIGNUP = 'first';
const { createApp, Store, totpCode } = await import('./server.mjs');
const store = new Store(dir);
const server = http.createServer(createApp({ store }));
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
await test('leaving: a computer signs itself out and disappears', async () => {
  assert.equal((await call('POST', '/api/account/logout', null, computer.token)).status, 200);
  assert.equal((await call('GET', '/api/account/computers', null, viewer.token)).body.computers.length, 0);
});
await test('no secrets in the database', async () => {
  const db = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  assert.equal(db.includes(viewer.token), false);
  assert.equal(db.includes('correct horse'), false);
});

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(process.exitCode ? '\nSome tests failed.' : `\nAll ${passed} tests passed.`);
