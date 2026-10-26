#!/usr/bin/env node
// Headless end-to-end test of Headroom accounts against a running host (Windows or macOS) and account server.
// Joins the host to the account through its loopback admin API, signs in a throwaway viewer device, connects
// with the key the account made for this computer, checks that a tampered key is refused, removes the device
// and waits for the host to close its session, then leaves the account again.
//
//   node tools/account-check.mjs --account=http://127.0.0.1:8780 --username=<u> --password=<p> [--register]
//                                [--url=http://127.0.0.1:7080] [--totp=123456]
//
//   --register  create the account first (a fresh account server allows the first sign-up)
//
// Run it on the host itself (the admin API is loopback-only). The host stays joined if a check fails midway;
// `curl -X POST http://127.0.0.1:7080/api/admin/account/leave` undoes it.
const arg = (name, def) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const host = arg('url', 'http://127.0.0.1:7080').replace(/\/$/, '');
const account = arg('account', 'http://127.0.0.1:8780').replace(/\/$/, '');
const username = arg('username');
const password = arg('password');
const totp = arg('totp');
if (!username || !password) {
  console.error('usage: node tools/account-check.mjs --account=<url> --username=<u> --password=<p> [--register] [--url=<host>]');
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

function finish() {
  console.log(problems.length ? `\n${problems.length} check(s) failed.` : '\nAll account checks passed.');
  process.exit(problems.length ? 1 : 0);
}

// ------------------------------------------------------------------------------------------------ setup
const info = await json(`${account}/api/info`).catch(e => ({ status: 0, body: { error: e.message } }));
if (!check(info.body.service === 'headroom-account-server', `account server at ${account} (${info.body.name || info.body.error || info.status})`)) finish();
const hostInfo = await json(`${host}/api/info`).catch(e => ({ status: 0, body: { error: e.message } }));
if (!check(!!hostInfo.body.host?.id, `host at ${host}: ${hostInfo.body.host?.name} (${hostInfo.body.host?.os})`)) finish();
const hostId = hostInfo.body.host.id;

if (process.argv.includes('--register')) {
  const reg = await json(`${account}/api/account/register`, { method: 'POST', body: { username, password, deviceName: 'account-check setup', platform: 'other' } });
  // Already there (or sign-up closed after the first account): the join below checks the credentials.
  check(reg.status === 200 || ['username-taken', 'signup-closed'].includes(reg.body.error),
    `account '${username}' ${reg.status === 200 ? 'created' : ['username-taken', 'signup-closed'].includes(reg.body.error) ? `not created (${reg.body.error}): using the existing one` : `not created: ${reg.body.message || reg.body.error}`}`);
}

// ------------------------------------------------------------------------------------------- join the host
const join = await json(`${host}/api/admin/account/join`, { method: 'POST', body: { server: account, username, password, totp } });
if (!check(join.status === 200 && join.body.ok, `host joins the account (${join.status} ${join.body.error || join.body.username})`)) finish();
const status = await json(`${host}/api/admin/status`);
check(status.body.account?.username === username && !!status.body.account?.lastSync, `host status shows the account, checked in ${status.body.account?.lastSync}`);

// --------------------------------------------------------------------------------- a device signs in
const login = await json(`${account}/api/account/login`, { method: 'POST', body: { username, password, totp, deviceName: 'account-check', platform: 'other' } });
if (!check(login.status === 200 && login.body.token, `viewer device signs in (${login.status} ${login.body.error || login.body.device?.id})`)) finish();
const viewer = login.body.token;
const list = await json(`${account}/api/account/computers`, { token: viewer });
const computer = list.body.computers?.find(c => c.hostId === hostId);
if (!check(!!computer, `the account lists this computer (${list.body.computers?.length ?? 0} computer(s))`)) finish();
check(computer.online && computer.urls.length > 0 && /^[A-Za-z0-9+/]{43}=$/.test(computer.spki || '') && !!computer.ca,
  `it reported: online, ${computer.urls.length} address(es), key pin ${computer.spki?.slice(0, 10)}…, CA certificate`);

// ------------------------------------------------------------------------------------------ connect
function connect(token) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${host.replace(/^http/, 'ws')}/ws`);
    const st = { ws, welcome: null, error: null, closed: null };
    const timer = setTimeout(() => { st.error = st.error || 'timeout'; ws.close(); resolve(st); }, 25000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token, client: 'account-check' }));
    ws.onmessage = e => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.t === 'welcome') {
        st.welcome = m;
        clearTimeout(timer);
        // Stay alive like the app does (hosts close sessions after 20 s of silence).
        let id = 0;
        st.pinger = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', id: ++id, ts: Date.now() })); }, 1000);
        resolve(st);
      }
      if (m.t === 'error') st.error = m.code;
    };
    ws.onclose = e => { st.closed = { code: e.code, at: Date.now() }; clearTimeout(timer); clearInterval(st.pinger); resolve(st); };
  });
}

// The device signed in moments ago: the host doesn't know its key yet and must check in for it.
const s1 = await connect(computer.token);
check(!!s1.welcome, `connects with the account's key right after signing in (${s1.welcome ? `welcome as '${s1.welcome.device?.name}'` : s1.error || 'closed'}, ${at()})`);
const tampered = await connect(computer.token.slice(0, -2) + (computer.token.endsWith('AA') ? 'BB' : 'AA'));
check(!tampered.welcome && tampered.error === 'unauthorized', `a tampered key is refused (${tampered.error || 'accepted!'})`);

// ------------------------------------------------------------------------------------------ revoke
const devices = await json(`${account}/api/account/devices`, { token: viewer });
const me = devices.body.devices?.find(d => d.current);
const removedAt = Date.now();
const del = await json(`${account}/api/account/devices/${me?.id}`, { method: 'DELETE', token: viewer });
check(del.status === 200, 'the device is removed from the account');
if (s1.welcome) {
  for (let i = 0; i < 40 && !s1.closed; i++) await sleep(1000);
  check(!!s1.closed, `the host closes its session at its next check-in (${s1.closed ? `after ${((s1.closed.at - removedAt) / 1000).toFixed(1)} s, code ${s1.closed.code}` : 'still open after 40 s'})`);
}
const again = await connect(computer.token);
check(!again.welcome, `the removed device's key no longer works (${again.error || 'closed'})`);

// ------------------------------------------------------------------------------------------- leave
const leave = await json(`${host}/api/admin/account/leave`, { method: 'POST' });
check(leave.status === 200, 'the host leaves the account');
const after = await json(`${host}/api/admin/status`);
check(!after.body.account, 'host status no longer shows an account');
finish();
