#!/usr/bin/env node
// Headroom Account Server — optional accounts for Headroom: sign in once on a device and every computer in the
// account is there, with no per-computer pairing. Zero dependencies (Node 20+), JSON-file storage.
//
//   node server.mjs                     run (PORT, BIND, DATA_DIR, WEB_ROOT, TLS_CERT/TLS_KEY, SIGNUP, NAME, TRUST_PROXY)
//   node server.mjs add-user <name> [--admin]   create an account (asks for the password; the first is the admin)
//   node server.mjs list-users | reset-password <name> | reset-2fa <name> | make-admin <name> | make-user <name> | delete-user <name>
//
// Trust model (docs/ACCOUNTS.md): computers check in with their addresses and certificate pins and receive the
// account's devices as (id, name, token hash). Each signed-in device gets one token *per computer*, derived as
// HMAC(server key, device|computer|epoch): a computer only ever sees hashes, and a token is useless on any other
// computer. Revoking a device removes its hashes at the next check-in (20 s), and computers drop its sessions.
//
// Relay (docs/RELAY.md): computers also keep an outbound connection here, so browsers anywhere reach them at
// /r/<Headroom ID>/… without port forwarding, Tailscale or installing certificates. Only session paths are
// forwarded (/ws, /api/info, /api/me, /api/files/*); the computer still authenticates every session itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

const VERSION = '0.3.0';
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
const RELAY = env.RELAY !== 'off';            // on (default) | off
const TRUST_PROXY = env.TRUST_PROXY === '1';   // behind a reverse proxy: take the client IP from X-Forwarded-For
// Passwords (NIST SP 800-63B, OWASP ASVS): a length floor, no composition rules, screened against common and
// breached passwords (Have I Been Pwned's k-anonymity API: only 5 hex digits of a SHA-1 leave the server).
const MIN_PASSWORD = Math.max(8, Number(env.MIN_PASSWORD) || 12);
const BREACH_CHECK = env.BREACH_CHECK !== 'off';
const DEVICE_IDLE_DAYS = Number(env.DEVICE_IDLE_DAYS ?? 90); // sign-ins unused this long expire (0 = never)
const INVITE_DAYS = 7;
const RESET_HOURS = 24;
const HEARTBEAT_S = 20;
const ONLINE_S = 70;                           // a computer counts as online if it checked in this recently

// ------------------------------------------------------------------------------------------------- storage

/** The whole database: small (one person's or family's devices), so a JSON file with atomic writes. */
export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, accounts: [], devices: [], computers: [] };
    // Roles: the first account (the server's owner) is an admin; older databases had none.
    for (const a of this.data.accounts) a.role ||= 'user';
    if (this.data.accounts.length && !this.data.accounts.some(a => a.role === 'admin')) this.data.accounts[0].role = 'admin';
    this.data.invites ||= [];
    this.data.resets ||= [];
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

// OWASP Password Storage Cheat Sheet: scrypt with N=2^15, r=8, p=3 (equivalent to its N=2^17, p=1 baseline). Each
// record keeps its parameters; older ones are upgraded at the next successful sign-in.
const SCRYPT = { N: 32768, r: 8, p: 3, keylen: 32 };
const needsRehash = rec => rec?.algorithm !== 'scrypt' || rec.N !== SCRYPT.N || rec.r !== SCRYPT.r || rec.p !== SCRYPT.p;
/** Unicode passwords compare by their NFKC form (NIST SP 800-63B §3.1.1.2), so the same phrase typed on any keyboard works. */
const normalizePassword = s => String(s ?? '').normalize('NFKC');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  password = normalizePassword(password);
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 }, (err, key) => {
    if (err) reject(err);
    else resolve({ algorithm: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), hash: key.toString('base64') });
  }));
}

function scryptCheck(password, rec) {
  const expected = Buffer.from(rec.hash, 'base64');
  return new Promise(resolve => crypto.scrypt(password, Buffer.from(rec.salt, 'base64'), expected.length, { N: rec.N, r: rec.r, p: rec.p, maxmem: 256 * 1024 * 1024 }, (err, key) => {
    resolve(!err && crypto.timingSafeEqual(key, expected));
  }));
}

async function verifyPassword(password, rec) {
  if (!rec) return false;
  const n = normalizePassword(password);
  if (await scryptCheck(n, rec)) return true;
  // Hashes made before normalization: the raw form (only differs for some non-ASCII passwords).
  return n !== String(password ?? '') && scryptCheck(String(password), rec);
}

// A few common passwords long enough to pass the length rule (the breach check catches the rest).
const COMMON_PASSWORDS = new Set(['password1234', 'password12345', 'password123456', 'qwertyuiop123', 'qwerty123456', '123456789012',
  '1234567890123', 'iloveyou1234', 'abc123456789', 'passw0rd1234', 'letmein12345', 'welcome12345', 'administrator', 'adminadmin123',
  'changeme1234', 'trustno11234', 'football1234', 'baseball1234', 'superman1234', 'whatever1234', 'sunshine1234', 'princess1234',
  'qwertyqwerty', 'asdfghjkl123', 'zxcvbnm12345', 'p@ssw0rd1234', 'password!234', 'correcthorsebatterystaple']);

/** Have I Been Pwned range API (k-anonymity). Unreachable = no answer, not a refusal. */
async function breached(password) {
  if (!BREACH_CHECK) return false;
  const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  try {
    const r = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'Headroom-Account-Server' }, signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return false;
    const suffix = sha1.slice(5);
    return (await r.text()).split('\n').some(line => { const [h, n] = line.trim().split(':'); return h === suffix && Number(n) > 0; });
  } catch {
    return false;
  }
}

/**
 * What's wrong with a new password, or null (NIST SP 800-63B §3.1.1.2, OWASP ASVS V6): at least MIN_PASSWORD
 * characters, at most 256, any characters including spaces, no composition rules; refuses the username, repeated or
 * sequential runs, common passwords and passwords known from breaches.
 */
export async function passwordProblem(password, username, { breach = true } = {}) {
  const pw = normalizePassword(password);
  if ([...pw].length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters. A few words make a good one; spaces are fine.`;
  if (pw.length > 256) return 'Use at most 256 characters.';
  const lower = pw.toLowerCase();
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) return 'Don\'t include your username.';
  const compact = lower.replace(/\s+/g, '');
  if (new Set(compact).size < 4) return 'That\'s too predictable: use more different characters.';
  for (const run of ['0123456789012345678901234567890', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnm']) {
    if (run.includes(compact) || [...run].reverse().join('').includes(compact)) return 'That\'s too predictable: avoid keyboard runs and sequences.';
  }
  if (COMMON_PASSWORDS.has(compact) || COMMON_PASSWORDS.has(lower)) return 'That\'s one of the most common passwords. Choose another.';
  if (breach && await breached(pw)) return 'That password appears in known data breaches (haveibeenpwned.com), so attackers try it. Choose another.';
  return null;
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

// ------------------------------------------------------------------------------------------------- relay

/** What a viewer may reach through the relay: sessions and their file transfers. Never pairing or settings. */
const RELAYED_PATHS = /^\/(ws|api\/info|api\/me|api\/files\/(list|download|upload|mkdir))$/;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'host']);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 16 * 1024 * 1024;

/** "123456789", unique among this server's computers; shown as 123 456 789. */
function newRelayId(taken) {
  for (;;) {
    const id = String(100_000_000 + crypto.randomInt(900_000_000));
    if (!taken(id)) return id;
  }
}

function rawResponse(socket, status, reason, headers = {}, body = '') {
  const lines = [`HTTP/1.1 ${status} ${reason}`, 'Connection: close', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  // Always a length, even for no body: proxies (cloudflared, nginx) treat a length-less answer as broken (502).
  lines.push(...(body ? ['Content-Type: application/json'] : []), `Content-Length: ${Buffer.byteLength(body)}`);
  socket.end(lines.join('\r\n') + '\r\n\r\n' + body);
}

/**
 * The server end of a WebSocket from a computer (control or tunnel). Links between computers and the relay are
 * WebSockets so that reverse proxies and tunnels (Caddy, nginx, Cloudflare) pass them like any other. As a stream,
 * binary messages carry raw bytes (a tunnel's HTTP traffic); text messages are JSON ('text' events).
 */
class WsLink extends Duplex {
  constructor(socket, head) {
    super({ allowHalfOpen: false });
    this.socket = socket;
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.lastHeard = Date.now();
    socket.setNoDelay(true);
    socket.on('data', d => { this.lastHeard = Date.now(); this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d; this.parse(); });
    socket.on('end', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { this.push(null); this.destroy(); });
    if (this.buf.length) setImmediate(() => this.parse());
  }

  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const op = b[0] & 0x0f, masked = b[1] & 0x80;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) { this.socket.destroy(); return; }
        len = Number(big); off = 10;
      }
      if (!masked) { this.socket.destroy(); return; } // a client must mask (RFC 6455 §5.1)
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x2 || op === 0x0) { if (payload.length && !this.push(payload)) this.socket.pause(); }
      else if (op === 0x1) this.emit('text', payload.toString('utf8'));
      else if (op === 0x9) this.frame(0xa, payload);
      else if (op === 0x8) { this.frame(0x8, Buffer.alloc(0)); this.socket.end(); return; }
    }
  }

  frame(op, payload) {
    if (this.socket.destroyed) return true;
    const n = payload.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    this.socket.write(head);
    return this.socket.write(payload);
  }

  sendText(s) { this.frame(0x1, Buffer.from(s)); }
  ping() { this.frame(0x9, Buffer.alloc(0)); }
  _read() { this.socket.resume(); }
  _write(chunk, enc, cb) { if (this.frame(0x2, chunk)) cb(); else this.socket.once('drain', () => cb()); }
  _final(cb) { this.frame(0x8, Buffer.alloc(0)); this.socket.end(); cb(); }
  _destroy(err, cb) { this.socket.destroy(); cb(err); }
}

/** Completes a computer's WebSocket handshake; null (after answering) if it isn't one. */
function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    rawResponse(socket, 400, 'Bad Request', {}, '{"error":"websocket expected"}');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WsLink(socket, head);
}

/**
 * Each connected computer holds a control WebSocket. To reach it, the relay sends {"t":"open"}; the computer
 * opens a tunnel WebSocket to /api/relay/tunnel/<nonce>, and that carries one viewer connection's raw bytes
 * (an HTTP request, or a WebSocket session) exactly as if the viewer had connected to the computer.
 */
export class Relay {
  constructor() {
    this.hosts = new Map();    // relayId -> { link, computerId, name, since, tunnels }
    this.pending = new Map();  // nonce -> { relayId, resolve }
  }

  online(relayId) { return !!relayId && this.hosts.has(relayId); }

  attach(relayId, computerId, name, link) {
    const old = this.hosts.get(relayId);
    if (old) old.link.destroy(); // reconnected (e.g. after a network change): the newest connection wins
    const h = { link, computerId, name, since: Date.now(), tunnels: 0 };
    this.hosts.set(relayId, h);
    link.socket.setKeepAlive(true, 15_000);
    link.resume(); // nothing flows on the control link's byte stream
    const ping = setInterval(() => {
      if (Date.now() - link.lastHeard > 75_000) { link.destroy(); return; }
      link.ping();
    }, 25_000);
    ping.unref();
    link.on('close', () => {
      clearInterval(ping);
      if (this.hosts.get(relayId) === h) { this.hosts.delete(relayId); log(`relay: '${name}' (${relayId}) disconnected`); }
    });
    link.on('error', () => link.destroy());
    link.sendText(JSON.stringify({ t: 'hello', relayId, ping: 25 }));
    log(`relay: '${name}' (${relayId}) connected`);
  }

  detachComputer(computerId) {
    for (const h of this.hosts.values()) if (h.computerId === computerId) h.link.destroy();
  }

  /** Asks the computer for a tunnel; resolves with it (a duplex byte stream). */
  openTunnel(relayId, clientIp, timeoutMs = 10_000) {
    const h = this.hosts.get(relayId);
    if (!h) return Promise.reject(Object.assign(new Error('offline'), { status: 503 }));
    if (h.tunnels >= 64) return Promise.reject(Object.assign(new Error('busy'), { status: 503 }));
    const nonce = crypto.randomBytes(18).toString('base64url');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(Object.assign(new Error('the computer didn\'t answer'), { status: 504 }));
      }, timeoutMs);
      this.pending.set(nonce, {
        resolve: link => {
          clearTimeout(timer);
          h.tunnels++;
          link.once('close', () => { h.tunnels--; });
          link.on('error', () => link.destroy());
          resolve(link);
        },
      });
      h.link.sendText(JSON.stringify({ t: 'open', id: nonce, client: clientIp }));
    });
  }

  /** The computer's end of a tunnel arrived. */
  acceptTunnel(nonce, req, socket, head) {
    const p = this.pending.get(nonce);
    if (!p) { rawResponse(socket, 404, 'Not Found'); return; }
    this.pending.delete(nonce);
    const link = acceptWebSocket(req, socket, head);
    if (link) p.resolve(link);
  }
}

// ------------------------------------------------------------------------------------------------- the API

export function createApp({ store, now = () => Date.now() }) {
  const limiter = new Limiter();
  const relay = new Relay();
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
    // A browser or phone that hasn't been used for a long time is signed out (computers check in all the time).
    const last = Date.parse(dev.lastSeen || dev.created);
    if (dev.kind === 'viewer' && DEVICE_IDLE_DAYS > 0 && now() - last > DEVICE_IDLE_DAYS * 86_400_000) {
      removeDevice(dev);
      store.save();
      audit(`'${dev.name}' of '${account.username}' signed out after ${DEVICE_IDLE_DAYS} days unused`);
      fail(401, 'expired', { message: 'Signed out after a long time unused. Sign in again.' });
    }
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
      urls: c.urls || [], tailscale: c.tailscale || null, lastSeen: c.lastSeen,
      online: now() - seen < ONLINE_S * 1000 || relay.online(c.relayId),
      relayId: RELAY ? c.relayId || null : null, relayOnline: RELAY && relay.online(c.relayId),
      spki: c.spki || null, fingerprint: c.fingerprint || null, ca: c.ca || null,
      token: computerToken(store, viewer, c), viewOnly: !!viewer.viewOnly,
    };
  }

  function removeDevice(dev) {
    store.data.devices = store.data.devices.filter(d => d.id !== dev.id);
    if (dev.kind === 'computer') {
      store.data.computers = store.data.computers.filter(c => c.id !== dev.id);
      relay.detachComputer(dev.id);
    }
  }

  async function login(req, body, kind) {
    const ip = clientIp(req);
    const username = normalizeName(body.username);
    const retry = limiter.retryAfter(ip, 'user:' + username);
    if (retry) fail(429, 'rate-limited', { retryAfter: retry });
    const account = store.accountByName(username);
    // Same work and answer for unknown users and wrong passwords.
    const ok = await verifyPassword(body.password, account?.password || DUMMY_PASSWORD) && !!account;
    if (!ok) { limiter.fail(ip, 'user:' + username); audit(`failed sign-in for '${username}' from ${ip}`); fail(401, 'bad-credentials'); }
    if (account.totpEnabled) {
      if (!body.totp) fail(401, 'totp-required');
      if (!totpVerify(account, body.totp)) { limiter.fail(ip, 'user:' + username); audit(`wrong two-factor code for '${username}' from ${ip}`); fail(401, 'bad-totp'); }
    }
    limiter.ok(ip, 'user:' + username);
    if (needsRehash(account.password)) account.password = await hashPassword(body.password); // stronger parameters
    // Passwords set under an older, weaker rule still work; the app suggests changing them.
    const weak = kind === 'viewer' && !!await passwordProblem(body.password, username, { breach: false });
    const { dev, token } = newDevice(account, kind, str(body.deviceName, 64), str(body.platform, 32), ip);
    store.save();
    audit(`${kind} '${dev.name}' signed in to '${account.username}' from ${ip}`);
    return { token, device: deviceJson(dev, dev.id), account: accountJson(account), passwordWeak: weak };
  }

  const accountJson = a => ({ id: a.id, username: a.username, role: a.role || 'user', totpEnabled: !!a.totpEnabled });

  /** Admin endpoints: a signed-in device of an admin account. */
  function requireAdmin(req) {
    const ctx = authenticate(req, 'viewer');
    if (ctx.account.role !== 'admin') fail(403, 'admin-only', { message: 'Only an administrator can do that.' });
    return ctx;
  }

  /** Re-authentication before dangerous actions (OWASP ASVS: re-auth for sensitive operations). */
  async function confirmPassword(req, account, password) {
    const ip = clientIp(req);
    const retry = limiter.retryAfter(ip, 'user:' + account.username);
    if (retry) fail(429, 'rate-limited', { retryAfter: retry });
    if (!await verifyPassword(password, account.password)) {
      limiter.fail(ip, 'user:' + account.username);
      fail(401, 'bad-credentials', { message: 'Wrong password.' });
    }
  }

  /** Signs out an account's browsers and phones (not its computers), except `keep`. */
  function signOutViewers(accountId, keep) {
    const gone = store.data.devices.filter(d => d.accountId === accountId && d.kind === 'viewer' && d.id !== keep);
    for (const d of gone) removeDevice(d);
    return gone.length;
  }

  /** A single-use secret for a link (invite or password reset); only its hash is stored. */
  function newLinkToken() {
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, tokenHash: sha256Hex(token) };
  }
  function findByToken(list, token) {
    const h = sha256Hex(String(token || ''));
    const item = list.find(x => x.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.tokenHash), Buffer.from(h)));
    return item && Date.parse(item.expires) > now() ? item : null;
  }
  function pruneLinks() {
    store.data.invites = store.data.invites.filter(x => Date.parse(x.expires) > now());
    store.data.resets = store.data.resets.filter(x => Date.parse(x.expires) > now());
  }
  /** Looking up link tokens is rate limited like sign-in, so they can't be probed. */
  function tokenAttempt(req, item) {
    const ip = clientIp(req);
    const retry = limiter.retryAfter(ip);
    if (retry) fail(429, 'rate-limited', { retryAfter: retry });
    if (!item) { limiter.fail(ip); fail(404, 'invalid-link', { message: 'This link is invalid, used or expired. Ask for a new one.' }); }
  }

  const routes = {
    'GET /api/info': () => ({ service: 'headroom-account-server', name: NAME, version: VERSION, signup: signupOpen(), firstAccount: store.data.accounts.length === 0, relay: RELAY }),

    'POST /api/account/register': async (req) => {
      const body = await readJson(req);
      // With an invite from an administrator, or while sign-up is open (the first account, or SIGNUP=open).
      pruneLinks();
      const invite = body.invite ? findByToken(store.data.invites, body.invite) : null;
      if (body.invite) tokenAttempt(req, invite);
      else if (!signupOpen()) fail(403, 'signup-closed', { message: 'Accounts on this server are by invitation. Ask its administrator for an invite link.' });
      const username = normalizeName(body.username);
      if (!/^[a-z0-9._-]{3,64}$/.test(username)) fail(400, 'bad-username', { message: 'Use 3–64 letters, digits, dots, dashes or underscores.' });
      if (store.accountByName(username)) fail(409, 'username-taken', { message: 'That username is taken.' });
      const problem = await passwordProblem(body.password, username);
      if (problem) fail(400, 'weak-password', { message: problem });
      const first = store.data.accounts.length === 0;
      store.data.accounts.push({
        id: randomId(), username, password: await hashPassword(body.password), created: new Date(now()).toISOString(), totpEnabled: false,
        role: first ? 'admin' : invite?.role === 'admin' ? 'admin' : 'user',
      });
      if (invite) store.data.invites = store.data.invites.filter(x => x !== invite);
      store.save();
      audit(`account '${username}' created${invite ? ` with an invite from '${store.account(invite.createdBy)?.username || '?'}'` : ''}${first ? ' (administrator)' : ''}`);
      return login(req, body, 'viewer');
    },

    // Invite and password-reset links: what the page shows before the form.
    'POST /api/account/reset': async (req) => {
      const body = await readJson(req);
      pruneLinks();
      const reset = findByToken(store.data.resets, body.token);
      tokenAttempt(req, reset);
      const account = store.account(reset.accountId);
      if (!account) fail(404, 'invalid-link');
      const problem = await passwordProblem(body.password, account.username);
      if (problem) fail(400, 'weak-password', { message: problem });
      account.password = await hashPassword(body.password);
      store.data.resets = store.data.resets.filter(x => x !== reset);
      const n = signOutViewers(account.id);
      store.save();
      audit(`password of '${account.username}' reset with a link; ${n} device(s) signed out`);
      return { ok: true, username: account.username };
    },

    'POST /api/account/login': async (req) => {
      const body = await readJson(req);
      return login(req, body, body.kind === 'computer' ? 'computer' : 'viewer');
    },

    'GET /api/account/me': (req) => {
      const { dev, account } = authenticate(req);
      return { account: accountJson(account), device: deviceJson(dev, dev.id) };
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
      const { dev, account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      await confirmPassword(req, account, body.current);
      const problem = await passwordProblem(body.password, account.username);
      if (problem) fail(400, 'weak-password', { message: problem });
      account.password = await hashPassword(body.password);
      // Other browsers and phones sign in again with the new password (OWASP ASVS: invalidate sessions on change).
      const n = signOutViewers(account.id, dev.id);
      store.save();
      audit(`'${account.username}' changed their password; ${n} other device(s) signed out`);
      return { ok: true, signedOut: n };
    },

    // ------------------------------------------------------------------------------------- administration

    'GET /api/admin/users': (req) => {
      requireAdmin(req);
      return {
        users: store.data.accounts.map(a => {
          const devs = store.data.devices.filter(d => d.accountId === a.id);
          const seen = devs.map(d => d.lastSeen).filter(Boolean).sort().at(-1) || null;
          return { ...accountJson(a), created: a.created, devices: devs.filter(d => d.kind === 'viewer').length, computers: devs.filter(d => d.kind === 'computer').length, lastSeen: seen };
        }),
      };
    },

    'GET /api/admin/invites': (req) => {
      requireAdmin(req);
      pruneLinks();
      return { invites: store.data.invites.map(x => ({ id: x.id, role: x.role, note: x.note, created: x.created, expires: x.expires, createdBy: store.account(x.createdBy)?.username })) };
    },

    'POST /api/admin/invites': async (req) => {
      const { account } = requireAdmin(req);
      const body = await readJson(req);
      const role = body.role === 'admin' ? 'admin' : 'user';
      if (role === 'admin') await confirmPassword(req, account, body.password);
      pruneLinks();
      const { token, tokenHash } = newLinkToken();
      const invite = { id: randomId(), tokenHash, role, note: str(body.note, 80), createdBy: account.id, created: new Date(now()).toISOString(), expires: new Date(now() + INVITE_DAYS * 86_400_000).toISOString() };
      store.data.invites.push(invite);
      store.save();
      audit(`'${account.username}' created an invite (${role}${invite.note ? `, "${invite.note}"` : ''})`);
      return { id: invite.id, token, role, expires: invite.expires };
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
      audit(`'${account.username}' turned on two-factor sign-in`);
      return { ok: true };
    },

    'POST /api/account/totp/disable': async (req) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      await confirmPassword(req, account, body.password);
      Object.assign(account, { totpSecret: null, totpEnabled: false });
      store.save();
      audit(`'${account.username}' turned off two-factor sign-in`);
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
    [/^GET \/api\/invite\/([\w-]{20,60})$/, async (req, token) => {
      pruneLinks();
      const invite = findByToken(store.data.invites, token);
      tokenAttempt(req, invite);
      return { ok: true, role: invite.role, expires: invite.expires, from: store.account(invite.createdBy)?.username || null, name: NAME };
    }],
    [/^GET \/api\/reset\/([\w-]{20,60})$/, async (req, token) => {
      pruneLinks();
      const reset = findByToken(store.data.resets, token);
      tokenAttempt(req, reset);
      return { ok: true, username: store.account(reset.accountId)?.username, expires: reset.expires };
    }],
    [/^DELETE \/api\/admin\/invites\/([\w-]+)$/, async (req, id) => {
      const { account } = requireAdmin(req);
      const before = store.data.invites.length;
      store.data.invites = store.data.invites.filter(x => x.id !== id);
      if (store.data.invites.length === before) fail(404, 'not found');
      store.save();
      audit(`'${account.username}' cancelled an invite`);
      return { ok: true };
    }],
    [/^POST \/api\/admin\/users\/([\w-]+)\/reset-link$/, async (req, id) => {
      const { account } = requireAdmin(req);
      const user = store.account(id) || fail(404, 'not found');
      pruneLinks();
      store.data.resets = store.data.resets.filter(x => x.accountId !== id); // one live link per account
      const { token, tokenHash } = newLinkToken();
      const reset = { id: randomId(), accountId: id, tokenHash, created: new Date(now()).toISOString(), expires: new Date(now() + RESET_HOURS * 3_600_000).toISOString() };
      store.data.resets.push(reset);
      store.save();
      audit(`'${account.username}' created a password reset link for '${user.username}'`);
      return { token, username: user.username, expires: reset.expires };
    }],
    [/^POST \/api\/admin\/users\/([\w-]+)\/reset-2fa$/, async (req, id) => {
      const { account } = requireAdmin(req);
      const body = await readJson(req);
      await confirmPassword(req, account, body.password);
      const user = store.account(id) || fail(404, 'not found');
      Object.assign(user, { totpSecret: null, totpEnabled: false });
      store.save();
      audit(`'${account.username}' turned off two-factor sign-in for '${user.username}'`);
      return { ok: true };
    }],
    [/^POST \/api\/admin\/users\/([\w-]+)$/, async (req, id) => {
      const { account } = requireAdmin(req);
      const body = await readJson(req);
      const user = store.account(id) || fail(404, 'not found');
      if (body.role !== 'admin' && body.role !== 'user') fail(400, 'bad-role');
      await confirmPassword(req, account, body.password);
      if (body.role === 'user' && user.role === 'admin' && store.data.accounts.filter(a => a.role === 'admin').length === 1) {
        fail(409, 'last-admin', { message: 'This is the only administrator. Make someone else an administrator first.' });
      }
      user.role = body.role;
      store.save();
      audit(`'${account.username}' made '${user.username}' ${body.role === 'admin' ? 'an administrator' : 'a regular user'}`);
      return { ok: true };
    }],
    [/^DELETE \/api\/admin\/users\/([\w-]+)$/, async (req, id) => {
      const { account } = requireAdmin(req);
      const body = await readJson(req);
      await confirmPassword(req, account, body.password);
      const user = store.account(id) || fail(404, 'not found');
      if (user.id === account.id) fail(409, 'self', { message: 'You can\'t delete your own account here.' });
      for (const d of store.data.devices.filter(d => d.accountId === id)) removeDevice(d);
      store.data.computers = store.data.computers.filter(c => c.accountId !== id);
      store.data.accounts = store.data.accounts.filter(a => a.id !== id);
      store.data.invites = store.data.invites.filter(x => x.createdBy !== id);
      store.data.resets = store.data.resets.filter(x => x.accountId !== id);
      store.save();
      audit(`'${account.username}' deleted the account '${user.username}' with its devices and computers`);
      return { ok: true };
    }],
    [/^DELETE \/api\/account\/devices\/([\w-]+)$/, async (req, id) => {
      const { account } = authenticate(req, 'viewer');
      const d = store.device(id);
      if (!d || d.accountId !== account.id) fail(404, 'not found');
      removeDevice(d);
      store.save();
      audit(`${d.kind} '${d.name}' removed from '${account.username}'`);
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

  // ----------------------------------------------------------------------------------------------- relay

  /** The computer behind /r/<relayId>/…, or an error to answer with. */
  function relayTarget(url) {
    const m = /^\/r\/(\d{9})(\/.*)?$/.exec(url.pathname);
    if (!m) return null;
    const [, relayId, rest = '/'] = m;
    if (!RELAY) return { error: [404, 'relay-off'] };
    if (!RELAYED_PATHS.test(rest)) return { error: [403, 'not-relayed', 'Only sessions and file transfers go through the relay.'] };
    if (!relay.online(relayId)) {
      const known = store.data.computers.some(c => c.relayId === relayId);
      return { error: known ? [503, 'offline', 'That computer isn\'t connected right now.'] : [404, 'unknown-id', 'No computer has that ID.'] };
    }
    return { relayId, path: rest + url.search };
  }

  /** Request headers as the computer should see them: hop-by-hop ones dropped, the viewer's address added. */
  function forwardHeaders(req, ip) {
    const out = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || lk.startsWith('x-headroom-')) continue;
      out[k] = req.rawHeaders[i + 1];
    }
    out['X-Headroom-Client'] = ip;
    return out;
  }

  async function proxyRequest(req, res, target) {
    const ip = clientIp(req);
    let tunnel;
    try {
      tunnel = await relay.openTunnel(target.relayId, ip);
    } catch (e) {
      const body = JSON.stringify({ error: e.status === 504 ? 'timeout' : 'offline', message: e.message });
      res.writeHead(e.status || 502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      return;
    }
    const preq = http.request({
      createConnection: () => tunnel, setHost: false, // no agent: then Node uses createConnection
      method: req.method, path: target.path, headers: { Host: 'relay', ...forwardHeaders(req, ip), Connection: 'close' },
    });
    preq.on('response', pres => {
      const h = {};
      for (const [k, v] of Object.entries(pres.headers)) if (!HOP_BY_HOP.has(k) && k !== 'transfer-encoding') h[k] = v;
      res.writeHead(pres.statusCode, h);
      pres.pipe(res);
    });
    preq.on('error', e => {
      if (process.env.RELAY_DEBUG) console.error('relay proxy error', e);
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":"relay"}'); } else res.destroy();
    });
    res.on('close', () => tunnel.destroy());
    req.pipe(preq);
  }

  /** HTTP upgrades: computers' control and tunnel connections, and viewers' WebSockets to /r/<id>/ws. */
  async function upgrade(req, socket, head) {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url, 'http://x');
    const proto = String(req.headers.upgrade || '').toLowerCase();
    try {
      if (url.pathname === '/api/relay/control') {
        if (!RELAY) return rawResponse(socket, 404, 'Not Found', {}, '{"error":"relay-off"}');
        const { dev, account } = authenticate(req, 'computer');
        let c = store.computer(dev.id);
        if (!c) { c = { id: dev.id, accountId: account.id, name: dev.name }; store.data.computers.push(c); }
        c.hostId ||= str(req.headers['x-headroom-host-id'], 64) || undefined;
        if (!c.relayId) {
          // Like an AnyDesk ID, a computer keeps its Headroom ID if it leaves the account and joins again.
          const key = c.hostId && `${account.id}:${c.hostId}`;
          const known = key && store.data.relayIds?.[key];
          const taken = id => store.data.computers.some(x => x !== c && x.relayId === id);
          c.relayId = known && !taken(known) ? known : newRelayId(taken);
          if (key) (store.data.relayIds ||= {})[key] = c.relayId;
          store.save();
        }
        const link = acceptWebSocket(req, socket, head);
        if (link) relay.attach(c.relayId, c.id, c.name || dev.name, link);
        return;
      }
      const tm = /^\/api\/relay\/tunnel\/([\w-]{20,40})$/.exec(url.pathname);
      if (tm) return relay.acceptTunnel(tm[1], req, socket, head);
      const target = relayTarget(url);
      if (target && proto === 'websocket') {
        if (target.error) return rawResponse(socket, target.error[0], 'Error', {}, JSON.stringify({ error: target.error[1] }));
        const ip = clientIp(req);
        const tunnel = await relay.openTunnel(target.relayId, ip).catch(e => { rawResponse(socket, e.status || 502, 'Unavailable'); return null; });
        if (!tunnel) return;
        const lines = [`GET ${target.path} HTTP/1.1`, 'Host: relay', 'Connection: Upgrade', 'Upgrade: websocket'];
        for (const [k, v] of Object.entries(forwardHeaders(req, ip))) lines.push(`${k}: ${v}`);
        tunnel.write(lines.join('\r\n') + '\r\n\r\n');
        if (head?.length) tunnel.write(head);
        socket.setNoDelay(true);
        socket.pipe(tunnel).pipe(socket);
        const close = () => { socket.destroy(); tunnel.destroy(); };
        for (const s2 of [socket, tunnel]) { s2.on('close', close); s2.on('end', close); s2.on('error', close); }
        return;
      }
      rawResponse(socket, 404, 'Not Found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      rawResponse(socket, status, 'Error', {}, JSON.stringify(e instanceof HttpError ? e.body : { error: 'server error' }));
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const headers = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      // The web app runs only its own scripts; it connects to computers anywhere (directly or through this relay).
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "media-src 'self' blob:; font-src 'self'; connect-src 'self' https: wss: http: ws:; worker-src 'self'; manifest-src 'self'; " +
        "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    };
    if (req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').startsWith('https'))) {
      headers['Strict-Transport-Security'] = 'max-age=31536000';
    }
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const target = relayTarget(url);
    if (target) {
      if (target.error) {
        const [status, error, message] = target.error;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error, message }));
        return;
      }
      return proxyRequest(req, res, target);
    }
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
  }

  handle.upgrade = upgrade;
  handle.relay = relay;
  return handle;
}

// An existing hash to verify against when the username doesn't exist, so timing doesn't reveal accounts.
let DUMMY_PASSWORD = null;

function log(msg) { console.log(`${new Date().toISOString()} ${msg}`); }
/** Security events (sign-ins, password and two-factor changes, administration), never secrets. */
function audit(msg) { log(`audit: ${msg}`); }

// ------------------------------------------------------------------------------------------------- CLI

function ask(prompt, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  if (hidden && process.stdin.isTTY) {
    rl._writeToOutput = s => { if (!s.includes(prompt)) rl.output.write('*'); else rl.output.write(s); };
  }
  return new Promise(resolve => rl.question(prompt, a => { rl.close(); if (hidden && process.stdin.isTTY) process.stdout.write('\n'); resolve(a); }));
}

/** The pid of a server running on this data directory, if any (it keeps the database in memory). */
function runningServer() {
  try {
    const pid = Number(fs.readFileSync(path.join(DATA_DIR, 'server.pid'), 'utf8'));
    if (!pid) return 0;
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    return e.code === 'EPERM' ? -1 : 0; // EPERM: alive, but another user's
  }
}

async function cli(cmd, args) {
  // A running server would overwrite changes made here with its in-memory copy: refuse instead.
  if (['add-user', 'reset-password', 'reset-2fa', 'make-admin', 'make-user', 'delete-user'].includes(cmd) && runningServer()) {
    console.log('The account server is running on this data directory. Stop it first (e.g. sudo systemctl stop headroom-accounts),');
    console.log('run this again, then start it.');
    return 1;
  }
  const store = new Store(DATA_DIR);
  const name = normalizeName(args[0]);
  const account = name && store.accountByName(name);
  switch (cmd) {
    case 'add-user': {
      if (!/^[a-z0-9._-]{3,64}$/.test(name)) { console.log('usage: add-user <username>  (3–64 letters, digits, . - _)'); return 1; }
      if (account) { console.log('That username exists.'); return 1; }
      const pw = await ask(`Password (${MIN_PASSWORD}+ characters): `, true);
      const problem = await passwordProblem(pw, name);
      if (problem) { console.log(problem); return 1; }
      const admin = store.data.accounts.length === 0 || args.includes('--admin');
      store.data.accounts.push({ id: randomId(), username: name, password: await hashPassword(pw), created: new Date().toISOString(), totpEnabled: false, role: admin ? 'admin' : 'user' });
      store.save();
      audit(`account '${name}' created from the command line${admin ? ' (administrator)' : ''}`);
      console.log(`Created '${name}'${admin ? ' (administrator)' : ''}.`);
      return 0;
    }
    case 'list-users':
      for (const a of store.data.accounts) {
        const devs = store.data.devices.filter(d => d.accountId === a.id);
        console.log(`${a.username.padEnd(24)} ${(a.role || 'user').padEnd(6)} ${devs.filter(d => d.kind === 'computer').length} computer(s), ${devs.filter(d => d.kind === 'viewer').length} device(s)${a.totpEnabled ? ', 2FA on' : ''}`);
      }
      return 0;
    case 'reset-password': {
      if (!account) { console.log('No such user.'); return 1; }
      const pw = await ask(`New password (${MIN_PASSWORD}+ characters): `, true);
      const problem = await passwordProblem(pw, name);
      if (problem) { console.log(problem); return 1; }
      account.password = await hashPassword(pw);
      const out = store.data.devices.filter(d => d.accountId === account.id && d.kind === 'viewer');
      store.data.devices = store.data.devices.filter(d => !out.includes(d));
      store.save();
      audit(`password of '${name}' reset from the command line; ${out.length} device(s) signed out`);
      console.log(`Password changed; ${out.length} signed-in browser(s)/phone(s) must sign in again.`);
      return 0;
    }
    case 'reset-2fa':
      if (!account) { console.log('No such user.'); return 1; }
      Object.assign(account, { totpSecret: null, totpEnabled: false });
      store.save();
      console.log('Two-factor sign-in turned off.');
      return 0;
    case 'make-admin':
    case 'make-user': {
      if (!account) { console.log('No such user.'); return 1; }
      const admins = store.data.accounts.filter(a => a.role === 'admin');
      if (cmd === 'make-user' && account.role === 'admin' && admins.length === 1) { console.log('That is the only administrator.'); return 1; }
      account.role = cmd === 'make-admin' ? 'admin' : 'user';
      store.save();
      audit(`'${name}' made ${account.role === 'admin' ? 'an administrator' : 'a regular user'} from the command line`);
      console.log(`'${name}' is now ${account.role === 'admin' ? 'an administrator' : 'a regular user'}.`);
      return 0;
    }
    case 'delete-user':
      if (!account) { console.log('No such user.'); return 1; }
      store.data.devices = store.data.devices.filter(d => d.accountId !== account.id);
      store.data.computers = store.data.computers.filter(c => c.accountId !== account.id);
      store.data.accounts = store.data.accounts.filter(a => a.id !== account.id);
      store.save();
      console.log('Deleted, with its devices and computers.');
      return 0;
    default:
      console.log('commands: add-user <name> [--admin] | list-users | reset-password <name> | reset-2fa <name> | make-admin <name> | make-user <name> | delete-user <name>');
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
  server.on('upgrade', handler.upgrade);
  server.headersTimeout = 20_000;
  server.requestTimeout = 0; // relayed uploads and downloads can take a while; headersTimeout still guards slow clients
  server.listen(PORT, BIND, () => {
    log(`Headroom Account Server ${VERSION} on ${tls ? 'https' : 'http'}://${BIND}:${PORT}/ — data ${DATA_DIR}${WEB_ROOT ? `, web app ${WEB_ROOT}` : ''}`);
    log(`sign-up: ${SIGNUP === 'first' ? (store.data.accounts.length ? 'closed (an account exists; use add-user)' : 'open for the first account') : SIGNUP}`);
    if (!tls) log('serving plain HTTP: put it behind HTTPS (a reverse proxy, or TLS_CERT/TLS_KEY) before using it beyond this machine');
    log(`relay: ${RELAY ? 'on — computers in an account are reachable at /r/<Headroom ID>/' : 'off'}`);
  });
  const pidFile = path.join(DATA_DIR, 'server.pid');
  fs.writeFileSync(pidFile, String(process.pid));
  const stop = () => {
    store.save();
    try { fs.unlinkSync(pidFile); } catch { }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
