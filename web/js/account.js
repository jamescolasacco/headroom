// The optional Headroom account (account-server/, docs/ACCOUNTS.md): sign in once and every computer in the
// account is listed, each with a token made for it — no pairing. Paired computers keep working alongside.
// Stored in localStorage like the address book; the account token is this device's sign-in.
import { postNative, nativeViewer } from './platform.js';

const KEY = 'headroom.account.v1';

export function loadAccount() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

function saveAccount(a) {
  try { if (a) localStorage.setItem(KEY, JSON.stringify(a)); else localStorage.removeItem(KEY); } catch { }
}

export function normalizeServer(input) {
  let s = (input || '').trim();
  if (!s) throw new Error('Enter the account server\'s address.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

async function call(server, path, { method = 'GET', body, token, timeout = 8000 } = {}) {
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
    const e = new Error('Can\'t reach the account server. Check the address and your connection.');
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

/** GET /api/info, only if it's an account server (else null). */
export async function serverInfo(server) {
  try {
    const i = await call(server, '/api/info', { timeout: 4000 });
    return i.service === 'headroom-account-server' ? i : null;
  } catch { return null; }
}

/** Sign in (or create the account) and remember it on this device. */
export async function signIn(server, { username, password, totp, deviceName, platform, register = false }) {
  const r = await call(server, register ? '/api/account/register' : '/api/account/login', {
    method: 'POST', body: { username, password, totp, deviceName, platform },
  });
  const a = { server, token: r.token, username: r.account.username, accountId: r.account.id, deviceId: r.device.id, deviceName: r.device.name, computers: [], fetchedAt: 0 };
  saveAccount(a);
  return a;
}

export async function signOut() {
  const a = loadAccount();
  saveAccount(null);
  if (a) { try { await call(a.server, '/api/account/logout', { method: 'POST', token: a.token, timeout: 4000 }); } catch { } }
}

/**
 * Refreshes the account's computers. Returns the account (updated), or null when this device was signed out
 * from elsewhere (removed in the device list) — then the account is forgotten.
 */
export async function refreshComputers() {
  const a = loadAccount();
  if (!a) return null;
  try {
    const { computers } = await call(a.server, '/api/account/computers', { token: a.token });
    // Keep what this device learned about each computer: the address that worked, when it was last used.
    const prev = new Map(a.computers.map(c => [c.id, c]));
    a.computers = computers.map(c => ({ ...c, lastUrl: prev.get(c.id)?.lastUrl, lastConnected: prev.get(c.id)?.lastConnected }));
    a.fetchedAt = Date.now();
    a.error = null;
    saveAccount(a);
    trustPins(computers);
  } catch (e) {
    if (e.status === 401) { saveAccount(null); return null; }
    a.error = e.message; // offline: keep showing the last list
    saveAccount(a);
  }
  return a;
}

/** Headroom Viewer: computers vouched for by the account get their certificate pinned without asking. */
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

/** The account's computers as address-book entries (same shape the session uses). */
export function accountHosts(a = loadAccount()) {
  if (!a) return [];
  return a.computers.map(c => ({
    id: c.hostId || c.id, name: c.name, os: c.os, token: c.token, url: c.lastUrl || c.urls[0] || '',
    urls: c.urls, online: c.online, lastSeen: c.lastSeen, account: true, computerId: c.id,
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
 * Picks the computer's address that answers from here: all are tried at once; the last one that worked wins,
 * then the computer's own order (Tailscale, .local name, LAN addresses).
 */
export async function reachableUrl(host) {
  const urls = [...new Set([host.url, ...(host.urls || [])].filter(Boolean))];
  const probe = u => new Promise(resolve => {
    const ctl = new AbortController();
    const t = setTimeout(() => { ctl.abort(); resolve(false); }, 3500);
    fetch(`${u.replace(/\/$/, '')}/api/info`, { signal: ctl.signal, cache: 'no-store' })
      .then(r => resolve(r.ok)).catch(() => resolve(false)).finally(() => clearTimeout(t));
  });
  const results = urls.map(u => ({ u, ok: probe(u) }));
  for (const r of results) if (await r.ok) return r.u.replace(/\/$/, '');
  return null;
}

// ------------------------------------------------------------------ management (account dialog)

export const listDevices = a => call(a.server, '/api/account/devices', { token: a.token }).then(r => r.devices);
export const removeDevice = (a, id) => call(a.server, `/api/account/devices/${encodeURIComponent(id)}`, { method: 'DELETE', token: a.token });
export const setViewOnly = (a, id, viewOnly) => call(a.server, `/api/account/devices/${encodeURIComponent(id)}`, { method: 'POST', token: a.token, body: { viewOnly } });
export const changePassword = (a, current, password) => call(a.server, '/api/account/password', { method: 'POST', token: a.token, body: { current, password } });
export const totpSetup = a => call(a.server, '/api/account/totp/setup', { method: 'POST', token: a.token });
export const totpEnable = (a, code) => call(a.server, '/api/account/totp/enable', { method: 'POST', token: a.token, body: { code } });
export const totpDisable = (a, password) => call(a.server, '/api/account/totp/disable', { method: 'POST', token: a.token, body: { password } });
export const me = a => call(a.server, '/api/account/me', { token: a.token });
