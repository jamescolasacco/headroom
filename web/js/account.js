// Your Headroom account (account-server/, docs/ACCOUNTS.md): sign in with your email and every device in the
// account is listed, each with a token made for this sign-in. Kept in localStorage; the token is this sign-in.
import { postNative, nativeViewer } from './platform.js';

const KEY = 'headroom.account.v2';

export function loadAccount() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

function saveAccount(a) {
  try { if (a) localStorage.setItem(KEY, JSON.stringify(a)); else localStorage.removeItem(KEY); } catch { }
}

/** Older versions kept paired computers and username sign-ins here: they don't work any more. */
export function forgetOldData() {
  for (const k of ['headroom.account.v1', 'headroom.hosts.v1', 'headroom.lastAccountServer', 'headroom.lastRelay', 'headroom.lastUsername', 'headroom.supportName']) {
    try { localStorage.removeItem(k); } catch { }
  }
}

async function call(server, path, { method = 'GET', body, token, timeout = 10000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(server + path, {
      method, signal: ctl.signal, cache: 'no-store',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('Can\'t reach Headroom right now. Check your connection.');
    e.unreachable = true;
    throw e;
  } finally { clearTimeout(t); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.message || data.error || `HTTP ${r.status}`);
    e.status = r.status; e.body = data;
    throw e;
  }
  return data;
}

/** GET /api/info, only if it's a Headroom account server (else null). */
export async function serverInfo(server) {
  try {
    const i = await call(server, '/api/info', { timeout: 5000 });
    return i.service === 'headroom-account-server' ? i : null;
  } catch { return null; }
}

function remember(server, r) {
  const a = {
    server, token: r.token, email: r.account.email, accountId: r.account.id,
    deviceId: r.device.id, deviceName: r.device.name, computers: [], fetchedAt: 0, passwordWeak: !!r.passwordWeak,
  };
  saveAccount(a);
  try { localStorage.setItem('headroom.lastEmail', a.email); } catch { }
  return a;
}

// ------------------------------------------------------------------ signing in (no account needed)

export const signUp = (server, { email, password, turnstile }) => call(server, '/api/account/signup', { method: 'POST', body: { email, password, turnstile } });
export const confirmSignUp = async (server, { email, code, password, deviceName, platform }) =>
  remember(server, await call(server, '/api/account/verify', { method: 'POST', body: { email, code, password, deviceName, platform } }));
export const signIn = async (server, { email, password, totp, deviceName, platform }) =>
  remember(server, await call(server, '/api/account/login', { method: 'POST', body: { email, password, totp, deviceName, platform } }));
export const forgotPassword = (server, { email, turnstile }) => call(server, '/api/account/forgot', { method: 'POST', body: { email, turnstile } });
export const resetPassword = (server, { email, code, password }) => call(server, '/api/account/reset', { method: 'POST', body: { email, code, password } });
/** Emails a fresh code for a sign-up or reset that's waiting for one (the earlier code stops working). */
export const resendCode = (server, { email, kind }) => call(server, '/api/account/resend', { method: 'POST', body: { email, kind } });

export function updateAccount(patch) {
  const a = loadAccount();
  if (a) saveAccount({ ...a, ...patch });
}

export async function signOut() {
  const a = loadAccount();
  saveAccount(null);
  if (a) { try { await call(a.server, '/api/account/logout', { method: 'POST', token: a.token, timeout: 4000 }); } catch { } }
}

/** Forgets the sign-in on this device without telling the server (it's already gone there). */
export const forget = () => saveAccount(null);

// ------------------------------------------------------------------ devices

/**
 * Refreshes the account's devices. Returns the account (updated); null when this sign-in ended elsewhere (signed
 * out from another browser, password reset, account deleted), and then it's forgotten here; or undefined when this
 * browser signed out, or in again, while the request was out (the newer state stands: nothing to do).
 */
export async function refreshComputers() {
  const started = loadAccount();
  if (!started) return null;
  // Signing out (or in as someone else) while this request was out wins: never save the old sign-in back.
  const current = () => { const a = loadAccount(); return a && a.token === started.token ? a : null; };
  try {
    const { computers } = await call(started.server, '/api/account/computers', { token: started.token });
    const a = current();
    if (!a) return undefined;
    // Keep what this device learned about each one: the address that worked, when it was last used.
    const prev = new Map(a.computers.map(c => [c.id, c]));
    a.computers = computers.map(c => ({ ...c, lastUrl: prev.get(c.id)?.lastUrl, lastConnected: prev.get(c.id)?.lastConnected }));
    a.fetchedAt = Date.now();
    a.error = null;
    saveAccount(a);
    trustPins(computers);
    return a;
  } catch (e) {
    const a = current();
    if (!a) return undefined;
    if (e.status === 401 || e.status === 403) { saveAccount(null); return null; }
    a.error = e.message; // offline: keep showing the last list
    saveAccount(a);
    return a;
  }
}

/** Headroom Viewer: devices vouched for by the account get their certificate pinned (for direct connections). */
function trustPins(computers) {
  if (!nativeViewer) return;
  const pins = [];
  for (const c of computers) {
    if (!c.spki) continue;
    for (const u of c.urls) {
      try { pins.push({ host: new URL(u).hostname, spki: c.spki, fingerprint: c.fingerprint, subject: c.name }); } catch { }
    }
  }
  if (pins.length) postNative({ cmd: 'accountPins', pins });
}

/** The account's devices in the shape a session uses. */
export function accountHosts(a = loadAccount()) {
  if (!a) return [];
  return a.computers.map(c => ({
    id: c.hostId || c.id, name: c.name, os: c.os, token: c.token, computerId: c.id,
    urls: c.urls || [], relayUrl: c.relayId ? `${a.server}/r/${c.relayId}` : null, relayOnline: !!c.relayOnline,
    lastUrl: c.lastUrl, online: c.online, lastSeen: c.lastSeen, account: true,
    deviceId: a.deviceId, deviceName: a.deviceName, lastConnected: c.lastConnected || 0, viewOnly: c.viewOnly,
  }));
}

/** Remembers which address worked (tried first next time) and when it was last used. */
export function noteConnected(computerId, url) {
  const a = loadAccount();
  const c = a?.computers.find(x => x.id === computerId);
  if (!c) return;
  c.lastUrl = url;
  c.lastConnected = Date.now();
  saveAccount(a);
}

/**
 * Where to connect. A browser always goes through the relay. Headroom Viewer also tries the device directly
 * (same network, Tailscale), all at once, preferring last time's choice and the device's own addresses; once
 * something answers, slower better choices get a moment more, not the full timeout.
 */
export async function reachableUrl(host) {
  if (!nativeViewer) return host.relayOnline ? host.relayUrl : null;
  const direct = [host.lastUrl, ...host.urls].filter(u => u && u !== host.relayUrl);
  const urls = [...new Set([...direct, host.relayOnline ? host.relayUrl : null].filter(Boolean).map(u => u.replace(/\/$/, '')))];
  const results = urls.map(() => undefined);
  return new Promise(resolve => {
    let grace = null, settled = false;
    const pick = () => {
      for (let i = 0; i < urls.length; i++) {
        if (results[i] === true) return urls[i];
        if (results[i] === undefined) return null;
      }
      return undefined; // all failed
    };
    const decide = force => {
      if (settled) return;
      const p = pick();
      if (p || p === undefined) { settled = true; clearTimeout(grace); resolve(p || null); return; }
      if (force) { settled = true; resolve(urls.find((u, i) => results[i] === true) || null); }
    };
    if (!urls.length) { resolve(null); return; }
    urls.forEach((u, i) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3500);
      fetch(`${u}/api/info`, { signal: ctl.signal, cache: 'no-store' })
        .then(r => r.ok).catch(() => false)
        .then(ok => {
          clearTimeout(t);
          results[i] = ok;
          if (ok && !grace) grace = setTimeout(() => decide(true), 700);
          decide(false);
        });
    });
  });
}

// ------------------------------------------------------------------ the Account page

export const me = a => call(a.server, '/api/account/me', { token: a.token });
export const listDevices = a => call(a.server, '/api/account/devices', { token: a.token }).then(r => r.devices);
export const removeDevice = (a, id) => call(a.server, `/api/account/devices/${encodeURIComponent(id)}`, { method: 'DELETE', token: a.token });
export const changePassword = (a, current, password) => call(a.server, '/api/account/password', { method: 'POST', token: a.token, body: { current, password } });
export const changeEmail = (a, password, email) => call(a.server, '/api/account/email', { method: 'POST', token: a.token, body: { password, email } });
export const confirmEmail = (a, code) => call(a.server, '/api/account/email/verify', { method: 'POST', token: a.token, body: { code } });
export const deleteAccount = (a, password) => call(a.server, '/api/account/delete', { method: 'POST', token: a.token, body: { password } });
export const totpSetup = a => call(a.server, '/api/account/totp/setup', { method: 'POST', token: a.token });
export const totpEnable = (a, code) => call(a.server, '/api/account/totp/enable', { method: 'POST', token: a.token, body: { code } });
export const totpDisable = (a, password) => call(a.server, '/api/account/totp/disable', { method: 'POST', token: a.token, body: { password } });

// ------------------------------------------------------------------ guest codes

/** "123456789" → "123 456 789". */
export const prettyCode = c => String(c || '').replace(/\D/g, '').slice(0, 9).replace(/(\d{3})(?=\d)/g, '$1 ');

/**
 * Looks a guest code up: its first 4 digits find the device on the relay (the other 5 only the device checks).
 * Returns the device's { host } info, or throws with a message to show.
 */
export async function lookUpCode(server, code) {
  const slot = code.slice(0, 4);
  let r, data;
  try {
    r = await fetch(`${server}/c/${slot}/api/info`, { cache: 'no-store' });
    data = await r.json().catch(() => ({}));
  } catch {
    throw new Error('Can\'t reach Headroom right now. Check your connection.');
  }
  if (!r.ok) throw new Error(data.message || (data.error === 'bad-code' ? 'That code isn\'t valid. Check it, or ask for a new one.' : `Something went wrong (${r.status}).`));
  return { url: `${server}/c/${slot}`, info: data };
}
