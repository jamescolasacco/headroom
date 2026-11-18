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

/** Sign in (or create the account, with an invite) and remember it on this device. */
export async function signIn(server, { username, password, totp, deviceName, platform, register = false, invite }) {
  const r = await call(server, register ? '/api/account/register' : '/api/account/login', {
    method: 'POST', body: { username, password, totp, deviceName, platform, invite },
  });
  const a = {
    server, token: r.token, username: r.account.username, accountId: r.account.id, role: r.account.role || 'user',
    deviceId: r.device.id, deviceName: r.device.name, computers: [], fetchedAt: 0, passwordWeak: !!r.passwordWeak,
  };
  saveAccount(a);
  try { localStorage.setItem('headroom.lastUsername', a.username); } catch { }
  return a;
}

/** Remembers what the server says about the account (role, after an administrator changed it). */
export function updateAccount(patch) {
  const a = loadAccount();
  if (a) saveAccount({ ...a, ...patch });
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
  return a.computers.map(c => {
    const relayUrl = c.relayId ? `${a.server}/r/${c.relayId}` : null;
    return {
      id: c.hostId || c.id, name: c.name, os: c.os, token: c.token, url: c.lastUrl || c.urls[0] || relayUrl || '',
      urls: c.urls, relayUrl, relayId: c.relayId, relayOnline: !!c.relayOnline,
      online: c.online, lastSeen: c.lastSeen, account: true, computerId: c.id,
      deviceId: a.deviceId, deviceName: a.deviceName, lastConnected: c.lastConnected || 0, viewOnly: c.viewOnly,
    };
  });
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
 * Picks the computer's address that answers from here. All are tried at once, in order of preference: the one
 * that worked last time, the computer's own (Tailscale, .local name, LAN addresses), then the relay, which
 * works from anywhere. Once something answers, slower better choices get a moment more, not the full timeout.
 */
export async function reachableUrl(host) {
  const urls = [...new Set([host.url, ...(host.urls || []), host.relayOnline ? host.relayUrl : null].filter(Boolean).map(u => u.replace(/\/$/, '')))];
  if (host.relayUrl && urls.indexOf(host.relayUrl) !== urls.length - 1 && host.relayOnline) {
    // The relay goes last even if it was last time's choice: a direct path, when there is one, is faster.
    urls.splice(urls.indexOf(host.relayUrl), 1);
    urls.push(host.relayUrl);
  }
  const results = urls.map(() => undefined);
  return new Promise(resolve => {
    let grace = null, settled = false;
    const pick = () => {
      // The best answer so far, if everything ranked above it has failed.
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

/** "123456789" as AnyDesk-style groups: 123 456 789. */
export const prettyId = id => String(id || '').replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ');

// ------------------------------------------------------------------ management (account dialog)

export const listDevices = a => call(a.server, '/api/account/devices', { token: a.token }).then(r => r.devices);
export const removeDevice = (a, id) => call(a.server, `/api/account/devices/${encodeURIComponent(id)}`, { method: 'DELETE', token: a.token });
export const setViewOnly = (a, id, viewOnly) => call(a.server, `/api/account/devices/${encodeURIComponent(id)}`, { method: 'POST', token: a.token, body: { viewOnly } });
export const changePassword = (a, current, password) => call(a.server, '/api/account/password', { method: 'POST', token: a.token, body: { current, password } });
export const totpSetup = a => call(a.server, '/api/account/totp/setup', { method: 'POST', token: a.token });
export const totpEnable = (a, code) => call(a.server, '/api/account/totp/enable', { method: 'POST', token: a.token, body: { code } });
export const totpDisable = (a, password) => call(a.server, '/api/account/totp/disable', { method: 'POST', token: a.token, body: { password } });
export const me = a => call(a.server, '/api/account/me', { token: a.token });

// ------------------------------------------------------------------ invite and reset links (no sign-in needed)

export const inviteInfo = (server, token) => call(server, `/api/invite/${encodeURIComponent(token)}`);
export const resetInfo = (server, token) => call(server, `/api/reset/${encodeURIComponent(token)}`);
export const resetPassword = (server, token, password) => call(server, '/api/account/reset', { method: 'POST', body: { token, password } });

// ------------------------------------------------------------------ administration (administrators only)

export const listUsers = a => call(a.server, '/api/admin/users', { token: a.token }).then(r => r.users);
export const listInvites = a => call(a.server, '/api/admin/invites', { token: a.token }).then(r => r.invites);
export const createInvite = (a, { role, note, password }) => call(a.server, '/api/admin/invites', { method: 'POST', token: a.token, body: { role, note, password } });
export const cancelInvite = (a, id) => call(a.server, `/api/admin/invites/${encodeURIComponent(id)}`, { method: 'DELETE', token: a.token });
export const setUserRole = (a, id, role, password) => call(a.server, `/api/admin/users/${encodeURIComponent(id)}`, { method: 'POST', token: a.token, body: { role, password } });
export const resetLink = (a, id) => call(a.server, `/api/admin/users/${encodeURIComponent(id)}/reset-link`, { method: 'POST', token: a.token });
export const resetUserTwoFactor = (a, id, password) => call(a.server, `/api/admin/users/${encodeURIComponent(id)}/reset-2fa`, { method: 'POST', token: a.token, body: { password } });
export const deleteUser = (a, id, password) => call(a.server, `/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', token: a.token, body: { password } });

/** A link that opens the app on `server` with a token in the fragment (never sent to any server by the browser). */
export const linkFor = (server, kind, token) => `${server}/#${kind}=${token}`;
