#!/usr/bin/env node
// Headroom Account Server — optional accounts for Headroom: sign in once on a device and every computer in the
// account is there, with no per-computer pairing. Zero dependencies (Node 20+), JSON-file storage.
//
//   node server.mjs                     run (PORT, BIND, DATA_DIR, WEB_ROOT, TLS_CERT/TLS_KEY, SIGNUP, NAME, TRUST_PROXY)
//   node server.mjs add-user <name>     create an account (asks for the password)
//   node server.mjs list-users | reset-password <name> | reset-2fa <name> | delete-user <name>
//
// Trust model (docs/ACCOUNTS.md): computers check in with their addresses and certificate pins and receive the
// account's devices as (id, name, token hash). Each signed-in device gets one token *per computer*, derived as
// HMAC(server key, device|computer|epoch): a computer only ever sees hashes, and a token is useless on any other
// computer. Revoking a device removes its hashes at the next check-in (20 s), and computers drop its sessions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 8780);
const BIND = env.BIND || '0.0.0.0';
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(here, 'data'));
const WEB_ROOT = (() => {
  if (env.WEB_ROOT === '') return null;
  const p = path.resolve(env.WEB_ROOT || path.join(here, '..', 'web'));
  return fs.existsSync(path.join(p, 'index.html')) ? p : null;
})();
const SIGNUP = env.SIGNUP || 'first';          // first (only while no account exists) | open | closed
const NAME = env.NAME || 'Headroom';
const TRUST_PROXY = env.TRUST_PROXY === '1';   // behind a reverse proxy: take the client IP from X-Forwarded-For
const HEARTBEAT_S = 20;
const ONLINE_S = 70;                           // a computer counts as online if it checked in this recently

// ------------------------------------------------------------------------------------------------- storage

/** The whole database: small (one person's or family's devices), so a JSON file with atomic writes. */
export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, accounts: [], devices: [], computers: [] };
    const keyFile = path.join(dir, 'secret.key');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    this.key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
    this.dirty = false;
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  /** Last-seen updates are frequent and unimportant: batch them. */
  touch() {
    if (this.dirty) return;
    this.dirty = true;
    setTimeout(() => { this.dirty = false; this.save(); }, 5000).unref();
  }
  account(id) { return this.data.accounts.find(a => a.id === id); }
  accountByName(name) { return this.data.accounts.find(a => a.username === normalizeName(name)); }
  device(id) { return this.data.devices.find(d => d.id === id); }
  computer(id) { return this.data.computers.find(c => c.id === id); }
}

const normalizeName = s => String(s || '').trim().toLowerCase();
const randomId = (n = 9) => crypto.randomBytes(n).toString('base64url');
const sha256Hex = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase(); // = hosts' HashToken

// ------------------------------------------------------------------------------------------------- crypto

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * 1024 * 1024 }, (err, key) => {
    if (err) reject(err);
    else resolve({ algorithm: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), hash: key.toString('base64') });
  }));
}

function verifyPassword(password, rec) {
  if (!rec) return Promise.resolve(false);
  const expected = Buffer.from(rec.hash, 'base64');
  return new Promise(resolve => crypto.scrypt(password, Buffer.from(rec.salt, 'base64'), expected.length, { N: rec.N, r: rec.r, p: rec.p, maxmem: 128 * 1024 * 1024 }, (err, key) => {
    resolve(!err && crypto.timingSafeEqual(key, expected));
  }));
}

/** The token device `d` uses on computer `c`. Never stored; computers only receive its hash. */
function computerToken(store, d, c) {
  return crypto.createHmac('sha256', store.key).update(`headroom-computer-token|v1|${d.id}|${c.id}|${d.epoch || 0}`).digest('base64url');
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totpSecret() {
  let bits = '', out = '';
  for (const b of crypto.randomBytes(20)) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function base32Decode(s) {
  let bits = '';
  for (const ch of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totpCode(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
/** RFC 6238, ±1 step, and a code can't be used twice. */
function totpVerify(account, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !account.totpSecret) return false;
  const now = Math.floor(Date.now() / 30000);
  for (let s = now - 1; s <= now + 1; s++) {
    if (crypto.timingSafeEqual(Buffer.from(totpCode(account.totpSecret, s)), Buffer.from(c))) {
      if (s <= (account.totpLastStep || -1)) return false;
      account.totpLastStep = s;
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------------------------------------- rate limiting

/** 5 free failures per key, then 2 s, 4 s, 8 s … up to 15 minutes; plus a global cap. Keys: IP and username. */
class Limiter {
  constructor() { this.failures = new Map(); this.recent = []; }
  retryAfter(...keys) {
    const now = Date.now();
    for (const k of keys) {
      const r = this.failures.get(k);
      if (r && r.blockedUntil > now) return Math.ceil((r.blockedUntil - now) / 1000);
    }
    this.recent = this.recent.filter(t => t > now - 60000);
    return this.recent.length >= 60 ? 60 : 0;
  }
  fail(...keys) {
    const now = Date.now();
    this.recent.push(now);
    for (const k of keys) {
      const r = this.failures.get(k) || { count: 0, last: 0, blockedUntil: 0 };
      if (r.last < now - 3600_000) r.count = 0;
      r.count++;
      r.last = now;
      if (r.count >= 5) r.blockedUntil = now + Math.min(900, 2 ** (r.count - 4)) * 1000;
      this.failures.set(k, r);
    }
  }
  ok(...keys) { for (const k of keys) this.failures.delete(k); }
}

// ------------------------------------------------------------------------------------------------- HTTP plumbing

class HttpError extends Error {
  constructor(status, body) { super(body?.error || String(status)); this.status = status; this.body = body; }
}
const fail = (status, error, extra = {}) => { throw new HttpError(status, { error, ...extra }); };

function clientIp(req) {
  if (TRUST_PROXY) {
    const f = req.headers['x-forwarded-for'];
    if (f) return String(f).split(',')[0].trim();
  }
  return (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) fail(413, 'request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch { fail(400, 'bad json'); }
}

const str = (v, max = 256) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  if (!WEB_ROOT) return false;
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  // The settings page belongs to the computers, not here.
  if (p === '/admin.html' || p === '/js/admin.js' || p === '/css/admin.css') return false;
  let file = path.join(WEB_ROOT, path.normalize(p));
  if (!file.startsWith(WEB_ROOT + path.sep)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(p)) return false;
    file = path.join(WEB_ROOT, 'index.html'); // SPA fallback
  }
  const stat = fs.statSync(file);
  const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
  const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag };
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

// ------------------------------------------------------------------------------------------------- the API

export function createApp({ store, now = () => Date.now() }) {
  const limiter = new Limiter();
  const pendingTotp = new Map(); // accountId -> secret awaiting verification

  const signupOpen = () => SIGNUP === 'open' || (SIGNUP === 'first' && store.data.accounts.length === 0);

  function authenticate(req, kind) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) fail(401, 'unauthorized');
    const hash = sha256Hex(m[1]);
    const dev = store.data.devices.find(d => d.tokenHash.length === hash.length && crypto.timingSafeEqual(Buffer.from(d.tokenHash), Buffer.from(hash)));
    if (!dev) fail(401, 'unauthorized');
    if (kind && dev.kind !== kind) fail(403, kind === 'computer' ? 'computers only' : 'not allowed for computers');
    const account = store.account(dev.accountId);
    if (!account) fail(401, 'unauthorized');
    dev.lastSeen = new Date(now()).toISOString();
    dev.lastAddress = clientIp(req);
    store.touch();
    return { dev, account };
  }

  function newDevice(account, kind, name, platform, ip) {
    const token = crypto.randomBytes(32).toString('base64url');
    const dev = {
      id: randomId(), accountId: account.id, kind, name: name || (kind === 'computer' ? 'Computer' : 'Device'), platform: platform || '',
      tokenHash: sha256Hex(token), created: new Date(now()).toISOString(), lastSeen: null, lastAddress: ip, viewOnly: false, epoch: 0,
    };
    store.data.devices.push(dev);
    return { dev, token };
  }

  const deviceJson = (d, current) => ({
    id: d.id, kind: d.kind, name: d.name, platform: d.platform, created: d.created, lastSeen: d.lastSeen,
    lastAddress: d.lastAddress, viewOnly: !!d.viewOnly, current: d.id === current,
    online: d.kind === 'computer' && !!d.lastSeen && now() - Date.parse(d.lastSeen) < ONLINE_S * 1000,
  });

  function computerJson(c, viewer) {
    const seen = c.lastSeen ? Date.parse(c.lastSeen) : 0;
    return {
      id: c.id, hostId: c.hostId, name: c.name, os: c.os, osVersion: c.osVersion, version: c.version,
      urls: c.urls || [], tailscale: c.tailscale || null, online: now() - seen < ONLINE_S * 1000, lastSeen: c.lastSeen,
      spki: c.spki || null, fingerprint: c.fingerprint || null, ca: c.ca || null,
      token: computerToken(store, viewer, c), viewOnly: !!viewer.viewOnly,
    };
  }

  function removeDevice(dev) {
    store.data.devices = store.data.devices.filter(d => d.id !== dev.id);
    if (dev.kind === 'computer') store.data.computers = store.data.computers.filter(c => c.id !== dev.id);
  }

  async function login(req, body, kind) {
    const ip = clientIp(req);
    const username = normalizeName(body.username);
    const retry = limiter.retryAfter(ip, 'user:' + username);
    if (retry) fail(429, 'rate-limited', { retryAfter: retry });
    const account = store.accountByName(username);
    // Same work and answer for unknown users and wrong passwords.
    const ok = await verifyPassword(String(body.password || ''), account?.password || DUMMY_PASSWORD) && !!account;
    if (!ok) { limiter.fail(ip, 'user:' + username); fail(401, 'bad-credentials'); }
    if (account.totpEnabled) {
      if (!body.totp) fail(401, 'totp-required');
      if (!totpVerify(account, body.totp)) { limiter.fail(ip, 'user:' + username); fail(401, 'bad-totp'); }
    }
    limiter.ok(ip, 'user:' + username);
    const { dev, token } = newDevice(account, kind, str(body.deviceName, 64), str(body.platform, 32), ip);
    store.save();
    log(`${kind} '${dev.name}' signed in to '${account.username}' from ${ip}`);
    return { token, device: deviceJson(dev, dev.id), account: { id: account.id, username: account.username, totpEnabled: !!account.totpEnabled } };
  }

  const routes = {
    'GET /api/info': () => ({ service: 'headroom-account-server', name: NAME, version: VERSION, signup: signupOpen(), firstAccount: store.data.accounts.length === 0 }),

    'POST /api/account/register': async (req) => {
      if (!signupOpen()) fail(403, 'signup-closed', { message: 'New accounts are created by the administrator of this server.' });
      const body = await readJson(req);
      const username = normalizeName(body.username);
      if (!/^[a-z0-9._-]{3,64}$/.test(username)) fail(400, 'bad-username', { message: 'Use 3–64 letters, digits, dots, dashes or underscores.' });
      if (String(body.password || '').length < 8) fail(400, 'weak-password', { message: 'Password must be at least 8 characters.' });
      if (store.accountByName(username)) fail(409, 'username-taken');
      store.data.accounts.push({ id: randomId(), username, password: await hashPassword(String(body.password)), created: new Date(now()).toISOString(), totpEnabled: false });
      store.save();
      log(`account '${username}' created`);
      return login(req, body, 'viewer');
    },

    'POST /api/account/login': async (req) => {
      const body = await readJson(req);
      return login(req, body, body.kind === 'computer' ? 'computer' : 'viewer');
    },

    'GET /api/account/me': (req) => {
      const { dev, account } = authenticate(req);
      return { account: { id: account.id, username: account.username, totpEnabled: !!account.totpEnabled }, device: deviceJson(dev, dev.id) };
    },

    'POST /api/account/logout': (req) => {
      const { dev } = authenticate(req);
      removeDevice(dev);
      store.save();
      return { ok: true };
    },

    'GET /api/account/devices': (req) => {
      const { dev, account } = authenticate(req, 'viewer');
      return { devices: store.data.devices.filter(d => d.accountId === account.id).map(d => deviceJson(d, dev.id)) };
    },

    'GET /api/account/computers': (req) => {
      const { dev, account } = authenticate(req, 'viewer');
      return { computers: store.data.computers.filter(c => c.accountId === account.id).map(c => computerJson(c, dev)) };
    },

    'POST /api/account/password': async (req) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      if (!await verifyPassword(String(body.current || ''), account.password)) fail(401, 'bad-credentials');
      if (String(body.password || '').length < 8) fail(400, 'weak-password', { message: 'Password must be at least 8 characters.' });
      account.password = await hashPassword(String(body.password));
      store.save();
      return { ok: true };
    },

    'POST /api/account/totp/setup': (req) => {
      const { account } = authenticate(req, 'viewer');
      const secret = totpSecret();
      pendingTotp.set(account.id, secret);
      return { secret, uri: `otpauth://totp/Headroom:${encodeURIComponent(account.username)}?secret=${secret}&issuer=Headroom&digits=6&period=30` };
    },

    'POST /api/account/totp/enable': async (req) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      const secret = pendingTotp.get(account.id);
      if (!secret) fail(400, 'Start setup first.');
      if (!totpVerify({ totpSecret: secret }, body.code)) fail(400, 'That code didn\'t match. Check the time on your phone and try the next code.');
      pendingTotp.delete(account.id);
      Object.assign(account, { totpSecret: secret, totpEnabled: true, totpLastStep: Math.floor(Date.now() / 30000) });
      store.save();
      return { ok: true };
    },

    'POST /api/account/totp/disable': async (req) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      if (!await verifyPassword(String(body.password || ''), account.password)) fail(401, 'bad-credentials');
      Object.assign(account, { totpSecret: null, totpEnabled: false });
      store.save();
      return { ok: true };
    },

    // Computers check in: publish how to reach them, learn which devices may connect.
    'POST /api/computer/heartbeat': async (req) => {
      const { dev, account } = authenticate(req, 'computer');
      const b = await readJson(req, 256 * 1024);
      let c = store.computer(dev.id);
      if (!c) { c = { id: dev.id, accountId: account.id }; store.data.computers.push(c); }
      const changedName = str(b.name, 128) && str(b.name, 128) !== c.name;
      Object.assign(c, {
        hostId: str(b.hostId, 64), name: str(b.name, 128) || c.name || dev.name, os: str(b.os, 16), osVersion: str(b.osVersion, 32),
        version: str(b.version, 32), urls: Array.isArray(b.urls) ? b.urls.filter(u => /^https:\/\//.test(u)).slice(0, 16).map(u => str(u, 300)) : [],
        tailscale: str(b.tailscale, 255) || null, spki: str(b.spki, 64) || null, fingerprint: str(b.fingerprint, 64) || null,
        ca: str(b.ca, 8192) || null, lastSeen: new Date(now()).toISOString(),
      });
      if (changedName) dev.name = c.name;
      store.touch();
      const devices = store.data.devices
        .filter(d => d.accountId === account.id && d.kind === 'viewer')
        .map(d => ({ id: d.id, name: d.name, tokenHash: sha256Hex(computerToken(store, d, c)), viewOnly: !!d.viewOnly }));
      return { computerId: c.id, account: { id: account.id, username: account.username }, devices, interval: HEARTBEAT_S };
    },
  };

  // Routes with an id in the path.
  const dynamic = [
    [/^DELETE \/api\/account\/devices\/([\w-]+)$/, async (req, id) => {
      const { account } = authenticate(req, 'viewer');
      const d = store.device(id);
      if (!d || d.accountId !== account.id) fail(404, 'not found');
      removeDevice(d);
      store.save();
      log(`${d.kind} '${d.name}' removed from '${account.username}'`);
      return { ok: true };
    }],
    [/^POST \/api\/account\/devices\/([\w-]+)$/, async (req, id) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      const d = store.device(id);
      if (!d || d.accountId !== account.id) fail(404, 'not found');
      if (typeof body.viewOnly === 'boolean') d.viewOnly = body.viewOnly;
      if (str(body.name, 64)) d.name = str(body.name, 64);
      store.save();
      return { ok: true };
    }],
  ];

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (url.pathname.startsWith('/api/')) {
      // Bearer tokens, no cookies: any origin may call the API (the web app is often served by a computer).
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const key = `${req.method} ${url.pathname}`;
      let fn = routes[key], arg;
      if (!fn) for (const [re, f] of dynamic) { const m = re.exec(key); if (m) { fn = f; arg = m[1]; break; } }
      try {
        if (!fn) fail(404, 'not found');
        const out = await fn(req, arg);
        const body = JSON.stringify(out);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error(e);
        const body = JSON.stringify(e instanceof HttpError ? e.body : { error: 'server error' });
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
      }
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  };
}

// An existing hash to verify against when the username doesn't exist, so timing doesn't reveal accounts.
let DUMMY_PASSWORD = null;

function log(msg) { console.log(`${new Date().toISOString()} ${msg}`); }

// ------------------------------------------------------------------------------------------------- CLI

function ask(prompt, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  if (hidden && process.stdin.isTTY) {
    rl._writeToOutput = s => { if (!s.includes(prompt)) rl.output.write('*'); else rl.output.write(s); };
  }
  return new Promise(resolve => rl.question(prompt, a => { rl.close(); if (hidden && process.stdin.isTTY) process.stdout.write('\n'); resolve(a); }));
}

async function cli(cmd, args) {
  const store = new Store(DATA_DIR);
  const name = normalizeName(args[0]);
  const account = name && store.accountByName(name);
  switch (cmd) {
    case 'add-user': {
      if (!/^[a-z0-9._-]{3,64}$/.test(name)) { console.log('usage: add-user <username>  (3–64 letters, digits, . - _)'); return 1; }
      if (account) { console.log('That username exists.'); return 1; }
      const pw = await ask('Password (8+ characters): ', true);
      if (pw.length < 8) { console.log('Too short.'); return 1; }
      store.data.accounts.push({ id: randomId(), username: name, password: await hashPassword(pw), created: new Date().toISOString(), totpEnabled: false });
      store.save();
      console.log(`Created '${name}'.`);
      return 0;
    }
    case 'list-users':
      for (const a of store.data.accounts) {
        const devs = store.data.devices.filter(d => d.accountId === a.id);
        console.log(`${a.username.padEnd(24)} ${devs.filter(d => d.kind === 'computer').length} computer(s), ${devs.filter(d => d.kind === 'viewer').length} device(s)${a.totpEnabled ? ', 2FA on' : ''}`);
      }
      return 0;
    case 'reset-password': {
      if (!account) { console.log('No such user.'); return 1; }
      const pw = await ask('New password (8+ characters): ', true);
      if (pw.length < 8) { console.log('Too short.'); return 1; }
      account.password = await hashPassword(pw);
      store.save();
      console.log('Password changed. Signed-in devices stay signed in; remove them in the app if needed.');
      return 0;
    }
    case 'reset-2fa':
      if (!account) { console.log('No such user.'); return 1; }
      Object.assign(account, { totpSecret: null, totpEnabled: false });
      store.save();
      console.log('Two-factor sign-in turned off.');
      return 0;
    case 'delete-user':
      if (!account) { console.log('No such user.'); return 1; }
      store.data.devices = store.data.devices.filter(d => d.accountId !== account.id);
      store.data.computers = store.data.computers.filter(c => c.accountId !== account.id);
      store.data.accounts = store.data.accounts.filter(a => a.id !== account.id);
      store.save();
      console.log('Deleted, with its devices and computers.');
      return 0;
    default:
      console.log('commands: add-user <name> | list-users | reset-password <name> | reset-2fa <name> | delete-user <name>');
      return cmd ? 1 : 0;
  }
}

// ------------------------------------------------------------------------------------------------- main

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd) process.exit(await cli(cmd, args));
  DUMMY_PASSWORD = await hashPassword(crypto.randomBytes(16).toString('hex'));
  const store = new Store(DATA_DIR);
  const handler = createApp({ store });
  const tls = env.TLS_CERT && env.TLS_KEY;
  const server = tls
    ? https.createServer({ cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) }, handler)
    : http.createServer(handler);
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.listen(PORT, BIND, () => {
    log(`Headroom Account Server ${VERSION} on ${tls ? 'https' : 'http'}://${BIND}:${PORT}/ — data ${DATA_DIR}${WEB_ROOT ? `, web app ${WEB_ROOT}` : ''}`);
    log(`sign-up: ${SIGNUP === 'first' ? (store.data.accounts.length ? 'closed (an account exists; use add-user)' : 'open for the first account') : SIGNUP}`);
    if (!tls) log('serving plain HTTP: put it behind HTTPS (a reverse proxy, or TLS_CERT/TLS_KEY) before using it beyond this machine');
  });
  const stop = () => { store.save(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
