#!/usr/bin/env node
// Headless end-to-end test of the relay and remote support against a running host (Windows or macOS) and account
// server: joins the host to the account, waits until it's on the relay, then — only through the relay — checks
// what's reachable, streams video in a support session (one-time code, Accept on the host, resume key, files),
// declines one, ends one from the host, and connects an account device. Leaves the account at the end.
//
//   node tools/relay-check.mjs --account=http://127.0.0.1:8780 --username=<u> --password=<p> [--register]
//                              [--url=http://127.0.0.1:7080] [--frames=15]
//
//   --frames=0  skip the video part (a machine without a desktop to capture, e.g. a CI runner)
//
// Run it on the host itself (the admin API is loopback-only; the session traffic goes through the relay).
const arg = (name, def) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const host = arg('url', 'http://127.0.0.1:7080').replace(/\/$/, '');
const account = arg('account', 'http://127.0.0.1:8780').replace(/\/$/, '');
const username = arg('username');
const wantFrames = Number(arg('frames', '15'));
const password = arg('password');
if (!username || !password) {
  console.error('usage: node tools/relay-check.mjs --account=<url> --username=<u> --password=<p> [--register] [--url=<host>]');
  process.exit(2);
}

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); console.log(`${cond ? '  ok ' : 'FAIL '} ${msg}`); return cond; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  await admin('/account/leave', { method: 'POST' }).catch(() => { });
  console.log(problems.length ? `\n${problems.length} check(s) failed.` : '\nAll relay checks passed.');
  process.exit(problems.length ? 1 : 0);
}

// --------------------------------------------------------------------------------------------- setup
if (process.argv.includes('--register')) {
  await json(`${account}/api/account/register`, { method: 'POST', body: { username, password, deviceName: 'relay-check setup', platform: 'other' } });
}
const join = await admin('/account/join', { method: 'POST', body: { server: account, username, password } });
if (!check(join.status === 200, `host joins the account (${join.body.error || 'ok'})`)) await finish();
let relay;
for (let i = 0; i < 30; i++) {
  relay = (await admin('/status')).body.relay;
  if (relay?.state === 'online' && relay.id) break;
  await sleep(500);
}
if (!check(relay?.state === 'online' && /^\d{9}$/.test(relay.id || ''), `host is on the relay as Headroom ID ${relay?.id} (${relay?.state}${relay?.error ? ': ' + relay.error : ''})`)) await finish();
const base = `${account}/r/${relay.id}`;
const wsUrl = `${base.replace(/^http/, 'ws')}/ws`;

// ------------------------------------------------------------------------------ what the relay reaches
const info = await json(`${base}/api/info`);
const hostId = (await json(`${host}/api/info`)).body.host?.id;
check(info.status === 200 && info.body.host?.id === hostId, `GET /api/info through the relay reaches this host (${info.body.host?.name})`);
for (const p of ['/api/pair', '/api/admin/status', '/trust', '/']) {
  const r = await fetch(`${base}${p}`, { method: p === '/api/pair' ? 'POST' : 'GET' });
  check(r.status === 403, `${p} isn't reachable through the relay (${r.status})`);
}

// ------------------------------------------------------------------------------------------ sessions
function connect(hello, { frames = 0, onPending } = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    const st = { ws, welcome: null, error: null, pending: false, frames: 0, closed: null };
    const timer = setTimeout(() => { st.error ||= 'timeout'; ws.close(); }, 30000);
    const done = () => { clearTimeout(timer); resolve(st); };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', client: { name: 'relay-check' }, ...hello }));
    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.t === 'pending') { st.pending = true; onPending?.(); }
        if (m.t === 'error') st.error = m.code;
        if (m.t === 'welcome') {
          st.welcome = m;
          if (!frames) return done();
          ws.send(JSON.stringify({ t: 'start', audio: false, maxFps: 30 }));
          st.pinger = setInterval(() => ws.send(JSON.stringify({ t: 'ping', id: 1, ts: Date.now() })), 1000);
        }
        return;
      }
      const v = new DataView(e.data);
      if (v.getUint8(0) === 0x01 && (v.getUint8(1) & 4)) { // last fragment of a frame: ack it, like the app
        const a = new DataView(new ArrayBuffer(5));
        a.setUint8(0, 0x15); a.setUint32(1, v.getUint32(4, true), true);
        ws.send(a.buffer);
        if (++st.frames >= frames) done();
      }
    };
    ws.onclose = e => { st.closed = e.code; clearInterval(st.pinger); done(); };
  });
}
const pendingRequest = async () => {
  for (let i = 0; i < 20; i++) {
    const r = (await admin('/status')).body.support?.requests?.[0];
    if (r) return r;
    await sleep(250);
  }
  return null;
};
const decide = async (accept, viewOnly = false) => {
  const r = await pendingRequest();
  return r ? (await admin(`/support/requests/${r.id}`, { method: 'POST', body: { accept, viewOnly } })).status === 200 && r : null;
};

await admin('/settings', { method: 'POST', body: { supportAsk: true } });
let code = (await admin('/support/code', { method: 'POST' })).body.code;
check(/^\d{6}$/.test(code || ''), 'the host makes a 6-digit support code');
const wrong = await connect({ support: { code: code === '000000' ? '111111' : '000000', name: 'Mallory' } });
check(wrong.error === 'bad-code' && !wrong.welcome, `a wrong code is refused (${wrong.error})`);

let request;
const s1 = await connect({ support: { code, name: 'Helper' } }, { frames: wantFrames, onPending: async () => { request = await decide(true); } });
check(s1.pending, 'the viewer is told to wait for someone at the computer');
check(request?.name === 'Helper', `the host sees the request from '${request?.name}' (${request?.address})`);
check(!!s1.welcome?.resumeToken && s1.welcome?.support === true && s1.welcome?.permissions?.input === true, 'accepted: welcome with full control and a resume key');
if (wantFrames) check(s1.frames >= wantFrames, `video streams through the relay (${s1.frames} frames)`);
s1.ws.close();
await sleep(300);

const resumed = await connect({ token: s1.welcome?.resumeToken });
check(!!resumed.welcome && !resumed.pending, 'a dropped support session resumes with its key, without asking again');
const files = await json(`${base}/api/files/list`, { token: s1.welcome?.resumeToken });
check(files.status === 200 && Array.isArray(files.body.entries), `file browsing works through the relay (${files.body.entries?.length ?? files.status} roots)`);
const reused = await connect({ support: { code, name: 'Helper again' } });
check(reused.error === 'bad-code', `the code worked once only (${reused.error})`);

// The person at the computer ends it: the key stops working.
const sessions = (await admin('/status')).body.sessions;
const mine = sessions.find(s => s.deviceId === resumed.welcome?.device?.id);
await admin(`/sessions/${mine?.id}/disconnect`, { method: 'POST' });
await sleep(300);
const afterEnd = await connect({ token: s1.welcome?.resumeToken });
check(!afterEnd.welcome && afterEnd.error === 'unauthorized', `ended from the computer: the resume key is refused (${afterEnd.error})`);

code = (await admin('/support/code', { method: 'POST' })).body.code;
const declined = await connect({ support: { code, name: 'Stranger' } }, { onPending: () => decide(false) });
check(declined.error === 'declined' && !declined.welcome, `declined on the computer: the viewer is turned away (${declined.error})`);
code = (await admin('/support/code', { method: 'POST' })).body.code;
const viewOnly = await connect({ support: { code, name: 'Watcher' } }, { onPending: () => decide(true, true) });
check(viewOnly.welcome?.permissions?.input === false, 'accepted as view only: no control');
viewOnly.ws.close();

// --------------------------------------------------------------------------- an account device, via relay
const login = await json(`${account}/api/account/login`, { method: 'POST', body: { username, password, deviceName: 'relay-check device', platform: 'other' } });
const computer = (await json(`${account}/api/account/computers`, { token: login.body.token })).body.computers?.find(c => c.hostId === hostId);
check(computer?.relayId === relay.id && computer?.relayOnline === true, `the account lists it as on the relay (${computer?.relayId}, ${computer?.relayOnline})`);
const acct = await connect({ token: computer?.token });
check(!!acct.welcome, `an account device connects through the relay (${acct.welcome ? 'welcome' : acct.error})`);
acct.ws?.close();
await json(`${account}/api/account/logout`, { method: 'POST', token: login.body.token });

await finish();
