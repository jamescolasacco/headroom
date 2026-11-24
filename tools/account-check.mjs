#!/usr/bin/env node
// Headless end-to-end test of Headroom accounts and the relay against a running host (Windows or macOS) and
// account server. Points the host at the account server and signs it in through its loopback settings API, signs
// in a throwaway browser sign-in, then — only through the relay — connects with the key the account made for this
// computer (right after signing in), streams video, lists files, checks that a tampered key and the settings pages
// are refused, renames the computer, signs the browser out and waits for the host to close its session, and signs
// the host out again (it stays on the relay for guest codes).
//
//   node tools/account-check.mjs --account=http://127.0.0.1:8780 --email=<e> --password=<p> [--register]
//                                [--url=http://127.0.0.1:7080] [--frames=15] [--totp=123456]
//
//   --register  create the account first; the account server must run with DEV_MAIL=1 (reads the emailed code)
//   --frames=0  skip the video part (a machine without a desktop to capture, e.g. a CI runner)
//
// Run it on the host itself (the settings API is loopback-only). The host stays signed in if a check fails midway;
// `curl -X POST http://127.0.0.1:7080/api/admin/account/leave` undoes it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const arg = (name, def) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const host = arg('url', 'http://127.0.0.1:7080').replace(/\/$/, '');
const account = arg('account', 'http://127.0.0.1:8780').replace(/\/$/, '');
const email = arg('email');
const password = arg('password');
const totp = arg('totp');
const wantFrames = Number(arg('frames', '15'));
if (!email || !password) {
  console.error('usage: node tools/account-check.mjs --account=<url> --email=<e> --password=<p> [--register] [--url=<host>] [--frames=N]');
  process.exit(2);
}

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); console.log(`${cond ? '  ok ' : 'FAIL '} ${msg}`); return cond; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function json(url, { method = 'GET', body, token } = {}) {
  const r = await fetch(url, {
    method, cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const admin = (p, opts) => json(`${host}/api/admin${p}`, opts);

async function finish() {
  console.log(problems.length ? `\n${problems.length} check(s) failed.` : '\nAll account checks passed.');
  process.exit(problems.length ? 1 : 0);
}

// ------------------------------------------------------------------------------------------------ setup
const info = await json(`${account}/api/info`).catch(e => ({ status: 0, body: { error: e.message } }));
if (!check(info.body.service === 'headroom-account-server', `account server at ${account} (${info.body.name || info.body.error || info.status}, v${info.body.version})`)) await finish();
const hostInfo = await json(`${host}/api/info`).catch(e => ({ status: 0, body: { error: e.message } }));
if (!check(!!hostInfo.body.host?.id, `host at ${host}: ${hostInfo.body.host?.name} (${hostInfo.body.host?.os})`)) await finish();
const hostId = hostInfo.body.host.id;

if (process.argv.includes('--register')) {
  const up = await json(`${account}/api/account/signup`, { method: 'POST', body: { email, password } });
  const mail = await json(`${account}/api/dev/mail?to=${encodeURIComponent(email)}`);
  const code = /Your code: (\d{6})/.exec(mail.body.text || '')?.[1];
  if (code) {
    const v = await json(`${account}/api/account/verify`, { method: 'POST', body: { email, code, password, deviceName: 'account-check setup' } });
    check(v.status === 200, `account ${email} created with the emailed code (${v.status} ${v.body.error || ''})`);
  } else {
    // Already there (the email then says so instead of carrying a code): sign-in below checks the password.
    check(up.status === 200 && /tried to create/.test(mail.body.subject || ''), `account ${email} exists already: using it (${up.body.error || mail.body.subject || mail.status})`);
  }
}

// ------------------------------------------------------------------------------------------- sign the host in
await admin('/settings', { method: 'POST', body: { server: account } });
const before = (await admin('/status')).body.settings?.displayName ?? null;
const join = await admin('/account/join', { method: 'POST', body: { email, password, totp } });
if (!check(join.status === 200 && join.body.ok, `host signs in (${join.status} ${join.body.error || join.body.email})`)) await finish();
let st;
for (let i = 0; i < 30; i++) { st = (await admin('/status')).body; if (st.account?.lastSync && st.relay?.state === 'online') break; await sleep(500); }
check(st.account?.email === email && !!st.account?.lastSync, `host status shows the account, checked in ${st.account?.lastSync}`);
check(st.relay?.state === 'online', `host is on the relay as an account device (${st.relay?.state}${st.relay?.error ? `: ${st.relay.error}` : ''})`);

// --------------------------------------------------------------------------------- a browser signs in
const login = await json(`${account}/api/account/login`, { method: 'POST', body: { email, password, totp, deviceName: 'account-check', platform: 'other' } });
if (!check(login.status === 200 && login.body.token, `a browser signs in (${login.status} ${login.body.error || login.body.device?.name})`)) await finish();
const viewer = login.body.token;
let list, computer;
// Signing in moves the host's relay connection from "no account" to the account: give it a moment.
for (let i = 0; i < 30; i++) {
  list = await json(`${account}/api/account/computers`, { token: viewer });
  computer = list.body.computers?.find(c => c.hostId === hostId);
  if (computer?.relayOnline) break;
  await sleep(500);
}
if (!check(!!computer, `the account lists this computer (${list.body.computers?.length ?? 0} device(s))`)) await finish();
check(computer.online && computer.relayOnline && /^\d{9}$/.test(computer.relayId || ''), `it's online, on the relay (${computer.name}, ${at()})`);
const rbase = `${account}/r/${computer.relayId}`;

// ------------------------------------------------------------------------------------------ connect
function connect(token, { frames = 0 } = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${rbase.replace(/^http/, 'ws')}/ws`);
    ws.binaryType = 'arraybuffer';
    const s = { ws, welcome: null, error: null, closed: null, frames: 0 };
    const timer = setTimeout(() => { s.error = s.error || 'timeout'; ws.close(); resolve(s); }, 25000);
    let id = 0;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token, client: { name: 'account-check' } }));
    ws.onmessage = e => {
      if (typeof e.data !== 'string') {
        const v = new DataView(e.data);
        if (v.getUint8(0) === 0x01 && (v.getUint8(1) & 4)) {
          const ack = new ArrayBuffer(5); new DataView(ack).setUint8(0, 0x15); new DataView(ack).setUint32(1, v.getUint32(4, true), true);
          ws.send(ack);
          if (++s.frames >= frames) { clearTimeout(timer); resolve(s); }
        }
        return;
      }
      const m = JSON.parse(e.data);
      if (m.t === 'welcome') {
        s.welcome = m;
        // Stay alive like the app does (hosts close sessions after 20 s of silence).
        s.pinger = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', id: ++id, ts: Date.now() })); }, 1000);
        if (frames) ws.send(JSON.stringify({ t: 'start', monitor: m.monitors[0]?.id, maxFps: 30, maxWidth: 1280, maxHeight: 1280, audio: false }));
        else { clearTimeout(timer); resolve(s); }
      }
      if (m.t === 'error') s.error = m.code;
    };
    ws.onclose = e => { s.closed = { code: e.code, at: Date.now() }; clearTimeout(timer); clearInterval(s.pinger); resolve(s); };
  });
}

// The browser signed in moments ago: the host doesn't know its key yet and must check in for it.
const s1 = await connect(computer.token, { frames: wantFrames });
check(!!s1.welcome, `connects through the relay with the account's key right after signing in (${s1.welcome ? `welcome as '${s1.welcome.device?.name}'` : s1.error || 'closed'}, ${at()})`);
check(s1.welcome?.permissions?.input === true && s1.welcome?.permissions?.files === true, `own devices get this computer's settings: ${JSON.stringify(s1.welcome?.permissions)}`);
if (wantFrames) check(s1.frames >= wantFrames, `video streams through the relay (${s1.frames} frames, ${at()})`);
const files = await json(`${rbase}/api/files/list`, { token: computer.token });
check(files.status === 200 && Array.isArray(files.body.entries), `files list through the relay (${files.status}, ${files.body.entries?.length ?? 0} entries)`);
// This check runs on the host itself. Exercise streamed uploads through the relay and verify the actual files.
if (process.argv.includes('--check-uploads')) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'headroom-transfers-'));
  try {
    const name = 'shared notes.txt';
    await fs.writeFile(path.join(dir, name), 'original');
    const url = `${rbase}/api/files/upload?${new URLSearchParams({ dir, name })}`;
    const bodies = Array.from({ length: 6 }, (_, i) => Buffer.from(Uint8Array.from({ length: 256 * 1024 }, (_, n) => (i + n % 251) & 255)));
    const results = await Promise.allSettled(bodies.map(async body => {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${computer.token}` }, body });
      if (!r.ok) throw new Error(`upload returned ${r.status}`);
      const result = await r.json();
      const bytes = await fs.readFile(path.join(dir, path.basename(result.name)));
      check(bytes.equals(body), `uploaded contents match for ${result.name}`);
      return result.name;
    }));
    const names = results.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    const saved = path.join(dir, names[0]);
    const requestId = 'download-check';
    const token = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s1.ws.removeEventListener('message', onMessage);
        reject(new Error('download token timed out'));
      }, 10000);
      function onMessage(event) {
        if (typeof event.data !== 'string') return;
        const m = JSON.parse(event.data);
        if (m.t !== 'file-token' || m.id !== requestId || m.path !== saved) return;
        clearTimeout(timer);
        s1.ws.removeEventListener('message', onMessage);
        resolve(m.token);
      }
      s1.ws.addEventListener('message', onMessage);
      s1.ws.send(JSON.stringify({ t: 'file-token', path: saved, id: requestId }));
    });
    const download = await fetch(`${rbase}/api/files/download?t=${encodeURIComponent(token)}`, {
      headers: { Range: 'bytes=1024-2047' },
    });
    check(download.status === 206 && Buffer.from(await download.arrayBuffer()).equals(bodies[0].subarray(1024, 2048)),
      'a ranged download returns the requested bytes through the relay');
    check(new Set(names).size === bodies.length, 'simultaneous uploads receive distinct names');
    check(await fs.readFile(path.join(dir, name), 'utf8') === 'original', 'existing file survives the uploads');
    check((await fs.readdir(dir)).length === bodies.length + 1, 'no partial files are left behind');
  } catch (e) {
    check(false, `concurrent uploads: ${e.message}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
for (const p of ['/admin.html', '/api/admin/status', '/']) {
  const r = await fetch(`${rbase}${p}`);
  check(r.status === 403, `the relay doesn't reach ${p} (${r.status})`);
}
const tampered = await connect(computer.token.slice(0, -2) + (computer.token.endsWith('AA') ? 'BB' : 'AA'));
check(!tampered.welcome && tampered.error === 'unauthorized', `a tampered key is refused (${tampered.error || 'accepted!'})`);

// ------------------------------------------------------------------------------------------ rename
await admin('/settings', { method: 'POST', body: { displayName: 'account-check renamed' } });
let renamed;
for (let i = 0; i < 20 && renamed?.name !== 'account-check renamed'; i++) {
  await sleep(500);
  renamed = (await json(`${account}/api/account/computers`, { token: viewer })).body.computers?.find(c => c.hostId === hostId);
}
check(renamed?.name === 'account-check renamed', `renaming on the computer renames it in the account (${renamed?.name})`);
await admin('/settings', { method: 'POST', body: { displayName: before || '' } });

// ------------------------------------------------------------------------------------------ revoke
const devices = await json(`${account}/api/account/devices`, { token: viewer });
const me = devices.body.devices?.find(d => d.current);
const removedAt = Date.now();
const del = await json(`${account}/api/account/devices/${me?.id}`, { method: 'DELETE', token: viewer });
check(del.status === 200, 'the browser is signed out from the account');
if (s1.welcome) {
  for (let i = 0; i < 40 && !s1.closed; i++) await sleep(1000);
  check(!!s1.closed, `the host closes its session at its next check-in (${s1.closed ? `after ${((s1.closed.at - removedAt) / 1000).toFixed(1)} s, code ${s1.closed.code}` : 'still open after 40 s'})`);
}
const again = await connect(computer.token);
check(!again.welcome, `the signed-out browser's key no longer works (${again.error || 'closed'})`);

// ------------------------------------------------------------------------------------------- leave
const leave = await admin('/account/leave', { method: 'POST' });
check(leave.status === 200, 'the host signs out');
for (let i = 0; i < 30; i++) { st = (await admin('/status')).body; if (!st.account && st.relay?.state === 'online') break; await sleep(500); }
check(!st.account, 'host status no longer shows an account');
check(st.relay?.state === 'online', 'it stays on the relay without an account (guest codes keep working)');
const gone = (await json(`${account}/api/account/computers`, { token: login.body.token })).status;
check(gone === 401, 'the signed-out browser can\'t list devices any more');
await finish();
