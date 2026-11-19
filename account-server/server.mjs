#!/usr/bin/env node
// Headroom Account Server — accounts and the relay. Zero dependencies (Node 20+), JSON-file storage.
//
// An account (email + password) owns devices: anything that has signed in with Headroom Server. The Viewer (web or
// app) lists the account's devices and connects to them, directly or through the relay here. Anyone can also let
// a guest in with a one-time 9-digit code, which the person at the device must accept; guests need only a browser.
//
//   node server.mjs                     run (see the settings below and docs/ACCOUNTS.md)
//   node server.mjs list-users | add-user <email> | disable-user <email> | enable-user <email> | reset-2fa <email> | delete-user <email>
//
// Trust model (docs/ACCOUNTS.md): devices check in with how to reach them and receive the account's signed-in
// browsers as (id, name, token hash). Each sign-in gets one token *per device*, derived as
// HMAC(server key, sign-in|device|epoch): a device only ever sees hashes, and a token is useless on any other device.
//
// Relay (docs/RELAY.md): devices keep an outbound connection here, so browsers anywhere reach them without port
// forwarding or certificates. Only session paths are forwarded (/ws, /api/info, /api/me, /api/files/*); the device
// still authenticates every session itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

const VERSION = '0.4.7';
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
const SIGNUP = env.SIGNUP === 'closed' ? 'closed' : 'open'; // open (anyone with an email) | closed (add-user only)
const NAME = env.NAME || 'Headroom';
const RELAY = env.RELAY !== 'off';            // on (default) | off
const TRUST_PROXY = env.TRUST_PROXY === '1';   // behind a reverse proxy: take the client IP from X-Forwarded-For
// Email (verification codes, password resets, sign-in alerts) through Resend.
const RESEND_API_KEY = env.RESEND_API_KEY || '';
const EMAIL_FROM = env.EMAIL_FROM || '';       // e.g. "Headroom <no-reply@example.com>", on a domain verified in Resend
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/+$/, ''); // e.g. https://relay.example.com (for links in emails)
const DEV_MAIL = env.DEV_MAIL === '1';         // testing only: don't send; GET /api/dev/mail shows the last message
// Cloudflare Turnstile on sign-up and "forgot password" (the forms that send email).
const TURNSTILE_SITEKEY = env.TURNSTILE_SITEKEY || '';
const TURNSTILE_SECRET = env.TURNSTILE_SECRET || '';
// Passwords (NIST SP 800-63B, OWASP ASVS): a length floor, no composition rules, screened against common and
// breached passwords (Have I Been Pwned's k-anonymity API: only 5 hex digits of a SHA-1 leave the server).
const MIN_PASSWORD = Math.max(8, Number(env.MIN_PASSWORD) || 12);
const BREACH_CHECK = env.BREACH_CHECK !== 'off';
const DEVICE_IDLE_DAYS = Number(env.DEVICE_IDLE_DAYS ?? 90); // sign-ins unused this long expire (0 = never)
const EMAIL_CODE_MINUTES = 15;
const GUEST_CODE_MINUTES = 10;
const HEARTBEAT_S = 20;
const ONLINE_S = 70;                           // a device counts as online if it checked in this recently
const MAX_HOSTS = Number(env.MAX_HOSTS) || 5000;     // devices connected to the relay at once
const MAX_TUNNELS = Number(env.MAX_TUNNELS) || 2000; // viewer connections through the relay at once
const GUEST_HOSTS_PER_ADDRESS = 5;             // devices without an account, per network address

// ------------------------------------------------------------------------------------------------- storage

/** The whole database, a JSON file with atomic writes. Version 2: email accounts (older databases are set aside). */
export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : null;
    if (this.data && this.data.version !== 2) {
      // Version 1 had usernames: start fresh, keeping the old file beside it.
      const old = path.join(dir, `db.v1-${Date.now()}.json`);
      fs.renameSync(this.file, old);
      console.log(`${new Date().toISOString()} the old (username) database was set aside as ${path.basename(old)}; starting fresh`);
      this.data = null;
    }
    this.data ||= { version: 2, accounts: [], devices: [], computers: [] };
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
  accountByEmail(email) { const e = normalizeEmail(email); return this.data.accounts.find(a => a.email === e); }
  device(id) { return this.data.devices.find(d => d.id === id); }
  computer(id) { return this.data.computers.find(c => c.id === id); }
}

const normalizeEmail = s => String(s || '').trim().toLowerCase();
/** A plausible address (the emailed code is the real check). */
const validEmail = e => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const randomId = (n = 9) => crypto.randomBytes(n).toString('base64url');
const sha256Hex = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex').toUpperCase(); // = hosts' HashToken
/** 6 random digits, for codes sent by email. */
const emailCode = () => String(crypto.randomInt(1_000_000)).padStart(6, '0');

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
 * characters, at most 256, any characters including spaces, no composition rules; refuses the email name, repeated or
 * sequential runs, common passwords and passwords known from breaches.
 */
export async function passwordProblem(password, username /* the email's name part */, { breach = true } = {}) {
  const pw = normalizePassword(password);
  if ([...pw].length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters. A few words make a good one; spaces are fine.`;
  if (pw.length > 256) return 'Use at most 256 characters.';
  const lower = pw.toLowerCase();
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) return 'Don\'t include your email address.';
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

/**
 * 5 free failures per key and hour (20 for emails sent from one network address, which many people can share),
 * then 2 s, 4 s, 8 s … up to 15 minutes; plus a global cap on failures. Keys: network address, email, account.
 */
class Limiter {
  constructor() { this.failures = new Map(); this.recent = []; }
  static free(key) { return key.startsWith('mail-from:') ? 20 : 5; }
  retryAfter(...keys) {
    const now = Date.now();
    for (const k of keys) {
      const r = this.failures.get(k);
      if (r && r.blockedUntil > now) return Math.ceil((r.blockedUntil - now) / 1000);
    }
    this.recent = this.recent.filter(t => t > now - 60000);
    return this.recent.length >= 600 ? 60 : 0;
  }
  fail(...keys) {
    this.recent.push(Date.now());
    this.note(...keys);
  }
  /** Counts toward the keys' limits only (things that aren't failures, like emails sent). */
  note(...keys) {
    const now = Date.now();
    for (const k of keys) {
      const r = this.failures.get(k) || { count: 0, last: 0, blockedUntil: 0 };
      if (r.last < now - 3600_000) r.count = 0;
      r.count++;
      r.last = now;
      const free = Limiter.free(k);
      if (r.count >= free) r.blockedUntil = now + Math.min(900, 2 ** (r.count - free + 1)) * 1000;
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
  '.woff2': 'font/woff2',
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
  // no-transform: a proxy in front (Cloudflare's Rocket Loader, script injection, minifying) must not rewrite the app.
  const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-transform', ETag: etag };
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

// ------------------------------------------------------------------------------------------------- relay

/** What a viewer may reach through the relay: sessions and their file transfers. Never pairing or settings. */
const RELAYED_PATHS = /^\/(ws|api\/info|api\/me|api\/files\/(list|download|upload|mkdir))$/;
/** What a guest code reaches before it's accepted: the device's name, and the session. */
const GUEST_PATHS = /^\/(ws|api\/info)$/;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'host']);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 16 * 1024 * 1024;

/** A device's address on the relay (never shown to people): 9 digits for account devices, kept across sign-ins. */
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
 * Each connected device holds a control WebSocket. To reach it, the relay sends {"t":"open"}; the device opens a
 * tunnel WebSocket to /api/relay/tunnel/<nonce>, and that carries one viewer connection's raw bytes (an HTTP request,
 * or a WebSocket session) exactly as if the viewer had connected to the device.
 *
 * Guest codes: a device asks for a "slot" ({"t":"slot"}), 4 digits that find it here; it adds 5 secret digits of
 * its own. The relay routes /c/<slot>/… to the device but never learns the rest of the code: the device checks it.
 */
export class Relay {
  constructor() {
    this.hosts = new Map();    // relayId -> { link, computerId (null: no account), name, ip, since, tunnels, slots }
    this.pending = new Map();  // nonce -> { resolve }
    this.slots = new Map();    // slot -> { relayId, expires }
    this.tunnels = 0;
  }

  online(relayId) { return !!relayId && this.hosts.has(relayId); }

  guestHostsFrom(ip) {
    let n = 0;
    for (const h of this.hosts.values()) if (!h.computerId && h.ip === ip) n++;
    return n;
  }

  /** Computers connected without an account. */
  anonymous() {
    let n = 0;
    for (const h of this.hosts.values()) if (!h.computerId) n++;
    return n;
  }

  attach(relayId, computerId, name, link, ip) {
    const old = this.hosts.get(relayId);
    if (old) old.link.destroy(); // reconnected (e.g. after a network change): the newest connection wins
    const h = { link, computerId, name, ip, since: Date.now(), tunnels: 0, slots: new Set() };
    this.hosts.set(relayId, h);
    link.socket.setKeepAlive(true, 15_000);
    link.resume(); // nothing flows on the control link's byte stream
    link.on('text', t => this.onHostMessage(relayId, h, t));
    const ping = setInterval(() => {
      if (Date.now() - link.lastHeard > 75_000) { link.destroy(); return; }
      link.ping();
    }, 25_000);
    ping.unref();
    link.on('close', () => {
      clearInterval(ping);
      for (const sl of h.slots) this.slots.delete(sl);
      if (this.hosts.get(relayId) === h) { this.hosts.delete(relayId); log(`relay: '${name}' disconnected${computerId ? '' : ' (no account)'}`); }
    });
    link.on('error', () => link.destroy());
    link.sendText(JSON.stringify({ t: 'hello', relayId, ping: 25 }));
    log(`relay: '${name}' connected${computerId ? '' : ' (no account)'}`);
  }

  onHostMessage(relayId, h, text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.t === 'slot') {
      // A new guest code: one at a time per device; the old one stops working.
      this.pruneSlots();
      for (const sl of h.slots) this.slots.delete(sl);
      h.slots.clear();
      if (this.slots.size >= 9000) { h.link.sendText(JSON.stringify({ t: 'slot', id: m.id, error: 'busy' })); return; }
      let slot;
      do { slot = String(crypto.randomInt(10_000)).padStart(4, '0'); } while (this.slots.has(slot));
      const expires = Date.now() + GUEST_CODE_MINUTES * 60_000;
      this.slots.set(slot, { relayId, expires });
      h.slots.add(slot);
      h.link.sendText(JSON.stringify({ t: 'slot', id: m.id, slot, expires: new Date(expires).toISOString() }));
    } else if (m.t === 'slot-release') {
      for (const sl of h.slots) this.slots.delete(sl);
      h.slots.clear();
    }
  }

  /** The device a guest code's first 4 digits point to, if it's still valid and connected. */
  slotTarget(slot) {
    this.pruneSlots();
    const s = this.slots.get(slot);
    return s && this.hosts.has(s.relayId) ? s.relayId : null;
  }

  pruneSlots() {
    const now = Date.now();
    for (const [k, v] of this.slots) {
      if (v.expires > now) continue;
      this.slots.delete(k);
      this.hosts.get(v.relayId)?.slots.delete(k);
    }
  }

  detachComputer(computerId) {
    for (const h of this.hosts.values()) if (h.computerId === computerId) h.link.destroy();
  }

  /**
   * Asks the device for a tunnel; resolves with it (a duplex byte stream). `meta` tells the device who is coming:
   * their address and country, and whether they came with a guest code.
   */
  openTunnel(relayId, meta = {}, timeoutMs = 10_000) {
    const h = this.hosts.get(relayId);
    if (!h) return Promise.reject(Object.assign(new Error('offline'), { status: 503 }));
    if (h.tunnels >= 64 || this.tunnels >= MAX_TUNNELS) return Promise.reject(Object.assign(new Error('busy'), { status: 503 }));
    const nonce = crypto.randomBytes(18).toString('base64url');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce);
        reject(Object.assign(new Error('the device didn\'t answer'), { status: 504 }));
      }, timeoutMs);
      this.pending.set(nonce, {
        resolve: link => {
          clearTimeout(timer);
          h.tunnels++;
          this.tunnels++;
          link.once('close', () => { h.tunnels--; this.tunnels--; });
          link.on('error', () => link.destroy());
          resolve(link);
        },
      });
      h.link.sendText(JSON.stringify({ t: 'open', id: nonce, client: meta.ip, country: meta.country || undefined, guest: !!meta.guest }));
    });
  }

  /** The device's end of a tunnel arrived. */
  acceptTunnel(nonce, req, socket, head) {
    const p = this.pending.get(nonce);
    if (!p) { rawResponse(socket, 404, 'Not Found'); return; }
    this.pending.delete(nonce);
    const link = acceptWebSocket(req, socket, head);
    if (link) p.resolve(link);
  }
}

// ------------------------------------------------------------------------------------------------- the API

export function createApp({ store, now = () => Date.now(), mail = sendMail }) {
  const limiter = new Limiter();
  const relay = new Relay();
  const pendingTotp = new Map(); // accountId -> secret awaiting verification
  // Codes sent by email, kept in memory only: an unverified sign-up never becomes an account.
  const pending = new Map();     // `${kind}:${email or accountId}` -> { codeHash, expires, attempts, ... }
  const devMailbox = new Map();  // DEV_MAIL: email -> last message

  const send = (to, subject, text) => {
    if (DEV_MAIL) devMailbox.set(to, { subject, text });
    Promise.resolve(mail(to, subject, text)).catch(e => log(`email to ${to} failed: ${e.message}`));
  };
  const site = () => PUBLIC_URL || NAME;

  // ----------------------------------------------------------------------------------------------- helpers

  function authenticate(req, kind) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) fail(401, 'unauthorized');
    const hash = sha256Hex(m[1]);
    const dev = store.data.devices.find(d => d.tokenHash.length === hash.length && crypto.timingSafeEqual(Buffer.from(d.tokenHash), Buffer.from(hash)));
    if (!dev) fail(401, 'unauthorized');
    if (kind && dev.kind !== kind) fail(403, kind === 'computer' ? 'devices only' : 'not allowed for devices');
    const account = store.account(dev.accountId);
    if (!account) fail(401, 'unauthorized');
    if (account.disabled) fail(403, 'disabled', { message: 'This account is disabled.' });
    // A browser or phone that hasn't been used for a long time is signed out (devices check in all the time).
    const last = Date.parse(dev.lastSeen || dev.created);
    if (dev.kind === 'viewer' && DEVICE_IDLE_DAYS > 0 && now() - last > DEVICE_IDLE_DAYS * 86_400_000) {
      removeDevice(dev);
      store.save();
      audit(`'${dev.name}' of ${account.email} signed out after ${DEVICE_IDLE_DAYS} days unused`);
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
      id: randomId(), accountId: account.id, kind, name: name || (kind === 'computer' ? 'Computer' : 'Browser'), platform: platform || '',
      tokenHash: sha256Hex(token), created: new Date(now()).toISOString(), lastSeen: null, lastAddress: ip, viewOnly: false, epoch: 0,
    };
    store.data.devices.push(dev);
    return { dev, token };
  }

  const accountJson = a => ({ id: a.id, email: a.email, totpEnabled: !!a.totpEnabled });

  const deviceJson = (d, current) => ({
    id: d.id, kind: d.kind, name: d.name, platform: d.platform, created: d.created, lastSeen: d.lastSeen,
    lastAddress: d.lastAddress, viewOnly: !!d.viewOnly, current: d.id === current,
    online: d.kind === 'computer' && (relay.online(store.computer(d.id)?.relayId) || (!!d.lastSeen && now() - Date.parse(d.lastSeen) < ONLINE_S * 1000)),
  });

  function computerJson(c, viewer) {
    const seen = c.lastSeen ? Date.parse(c.lastSeen) : 0;
    return {
      id: c.id, hostId: c.hostId, name: c.name, os: c.os, osVersion: c.osVersion, version: c.version,
      urls: c.urls || [], lastSeen: c.lastSeen,
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

  /** Signs out an account's browsers and phones (not its devices), except `keep`. */
  function signOutViewers(accountId, keep) {
    const gone = store.data.devices.filter(d => d.accountId === accountId && d.kind === 'viewer' && d.id !== keep);
    for (const d of gone) removeDevice(d);
    return gone.length;
  }

  function throttle(req, ...keys) {
    const retry = limiter.retryAfter(clientIp(req), ...keys);
    if (retry) fail(429, 'rate-limited', { retryAfter: retry, message: `Too many attempts. Try again in ${retry} s.` });
  }

  /** Limits on emails sent: per network address and per recipient (so nobody is flooded with codes). */
  const mailKeys = (req, email) => ['mail-from:' + clientIp(req), 'mail-to:' + email];

  /** Re-authentication before sensitive changes (OWASP ASVS). */
  async function confirmPassword(req, account, password) {
    const ip = clientIp(req);
    throttle(req, 'account:' + account.id);
    if (!await verifyPassword(password, account.password)) {
      limiter.fail(ip, 'account:' + account.id);
      fail(401, 'bad-credentials', { message: 'Wrong password.' });
    }
  }

  /** Cloudflare Turnstile, on the forms that send email (when configured). */
  async function humanCheck(req, token) {
    if (!TURNSTILE_SECRET) return;
    let ok = false;
    try {
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token || ''), remoteip: clientIp(req) }),
        signal: AbortSignal.timeout(5000),
      });
      ok = (await r.json()).success === true;
    } catch { }
    if (!ok) fail(400, 'human-check', { message: 'Please complete the check and try again.' });
  }

  /** Starts an emailed-code step (sign-up, reset, new email): stores the code's hash, emails the code. */
  function startCode(key, to, subject, intro, extra = {}) {
    const code = emailCode();
    if (pending.size > 10_000) for (const [k, v] of pending) if (v.expires < now()) pending.delete(k);
    pending.set(key, { codeHash: sha256Hex(code), expires: now() + EMAIL_CODE_MINUTES * 60_000, attempts: 0, ...extra });
    send(to, subject, `${intro}\n\nYour code: ${code}\n\nIt works for ${EMAIL_CODE_MINUTES} minutes. If you didn't ask for it, ignore this email.\n\n${site()}`);
  }

  /** Checks an emailed code: five tries, then it's gone. */
  function takeCode(req, key, code) {
    throttle(req, key);
    const p = pending.get(key);
    if (!p || p.expires < now()) { pending.delete(key); limiter.fail(clientIp(req), key); fail(400, 'bad-code', { message: 'That code is wrong or expired. Ask for a new one.' }); }
    const c = sha256Hex(String(code || '').replace(/\D/g, ''));
    if (!crypto.timingSafeEqual(Buffer.from(c), Buffer.from(p.codeHash))) {
      if (++p.attempts >= 5) pending.delete(key);
      limiter.fail(clientIp(req), key);
      fail(400, 'bad-code', { message: p.attempts >= 5 ? 'Too many wrong codes. Ask for a new one.' : 'That code is wrong. Check the email and try again.' });
    }
    pending.delete(key);
    return p;
  }

  function where(req) {
    const country = TRUST_PROXY ? str(req.headers['cf-ipcountry'], 8) : '';
    return `${clientIp(req)}${country && country !== 'XX' ? ` (${country})` : ''}`;
  }

  async function signIn(req, account, body, kind, { alert = true } = {}) {
    const ip = clientIp(req);
    const { dev, token } = newDevice(account, kind, str(body.deviceName, 64), str(body.platform, 32), ip);
    store.save();
    audit(`${kind === 'computer' ? 'device' : 'sign-in'} '${dev.name}' for ${account.email} from ${ip}`);
    if (alert) send(account.email, kind === 'computer' ? `${dev.name} was added to your Headroom account` : 'New sign-in to your Headroom account',
      kind === 'computer'
        ? `"${dev.name}" signed in with Headroom Server and is now one of your devices.\n\nFrom: ${where(req)}\nWhen: ${new Date(now()).toUTCString()}\n\nIf this wasn't you, change your password and remove the device in your account.\n\n${site()}`
        : `Someone signed in to your Headroom account on "${dev.name}".\n\nFrom: ${where(req)}\nWhen: ${new Date(now()).toUTCString()}\n\nIf this wasn't you, change your password now and sign out the browsers you don't recognize (Account → Where you're signed in).\n\n${site()}`);
    const weak = alert && kind === 'viewer' && !!await passwordProblem(body.password, account.email.split('@')[0], { breach: false });
    return { token, device: deviceJson(dev, dev.id), account: accountJson(account), passwordWeak: weak };
  }

  // ----------------------------------------------------------------------------------------------- routes

  const routes = {
    'GET /api/info': () => ({
      service: 'headroom-account-server', name: NAME, version: VERSION, signup: SIGNUP === 'open', relay: RELAY,
      turnstile: TURNSTILE_SECRET ? TURNSTILE_SITEKEY : null, email: !!RESEND_API_KEY || DEV_MAIL,
    }),

    // Sign-up: email + password, then the 6-digit code from the email creates the account.
    'POST /api/account/signup': async (req) => {
      if (SIGNUP !== 'open') fail(403, 'signup-closed', { message: 'This server isn\'t taking new accounts.' });
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) fail(400, 'bad-email', { message: 'Enter a valid email address.' });
      throttle(req, ...mailKeys(req, email));
      await humanCheck(req, body.turnstile);
      const problem = await passwordProblem(body.password, email.split('@')[0]);
      if (problem) fail(400, 'weak-password', { message: problem });
      limiter.note(...mailKeys(req, email));
      if (store.accountByEmail(email)) {
        // Same answer either way (no account enumeration); the owner hears about it instead.
        send(email, 'Someone tried to create a Headroom account with your email',
          `Someone tried to create a new Headroom account with this email, but you already have one.\n\nIf it was you, sign in instead, or use "Forgot password?".\n\n${site()}`);
      } else {
        startCode(`signup:${email}`, email, 'Your Headroom sign-up code', 'Finish creating your Headroom account with this code.');
      }
      return { ok: true };
    },

    'POST /api/account/verify': async (req) => {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      // The password is taken here, with the code: whoever proves the address chooses it.
      const problem = await passwordProblem(body.password, email.split('@')[0]);
      if (problem) fail(400, 'weak-password', { message: problem });
      takeCode(req, `signup:${email}`, body.code);
      if (store.accountByEmail(email)) fail(409, 'exists', { message: 'That email already has an account. Sign in instead.' });
      const account = { id: randomId(), email, password: await hashPassword(body.password), created: new Date(now()).toISOString(), totpEnabled: false };
      store.data.accounts.push(account);
      audit(`account created: ${email}`);
      return signIn(req, account, body, 'viewer', { alert: false });
    },

    'POST /api/account/login': async (req) => {
      const body = await readJson(req);
      const kind = body.kind === 'computer' ? 'computer' : 'viewer';
      const ip = clientIp(req);
      const email = normalizeEmail(body.email);
      throttle(req, 'login:' + email);
      const account = store.accountByEmail(email);
      await dummyReady;
      // Same work and answer for unknown emails and wrong passwords.
      const ok = await verifyPassword(body.password, account?.password || DUMMY_PASSWORD) && !!account;
      if (!ok) { limiter.fail(ip, 'login:' + email); audit(`failed sign-in for ${email || '?'} from ${ip}`); fail(401, 'bad-credentials', { message: 'Wrong email or password.' }); }
      if (account.disabled) fail(403, 'disabled', { message: 'This account is disabled.' });
      if (account.totpEnabled) {
        if (!body.totp) fail(401, 'totp-required');
        if (!totpVerify(account, body.totp)) { limiter.fail(ip, 'login:' + email); audit(`wrong two-factor code for ${email} from ${ip}`); fail(401, 'bad-totp', { message: 'That code didn\'t work. Wait for the next one.' }); }
      }
      limiter.ok(ip, 'login:' + email);
      if (needsRehash(account.password)) account.password = await hashPassword(body.password);
      return signIn(req, account, body, kind);
    },

    'POST /api/account/forgot': async (req) => {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) fail(400, 'bad-email', { message: 'Enter a valid email address.' });
      throttle(req, ...mailKeys(req, email));
      await humanCheck(req, body.turnstile);
      limiter.note(...mailKeys(req, email));
      const account = store.accountByEmail(email);
      if (account && !account.disabled) startCode(`reset:${account.id}`, email, 'Your Headroom password reset code', 'Use this code to choose a new password.');
      return { ok: true }; // the same whether or not the account exists
    },

    // "Send a new code": only for a sign-up or reset from the last 15 minutes (which passed the human check), at
    // most 3 times; the earlier code stops working. The same answer whether or not anything was sent.
    'POST /api/account/resend': async (req) => {
      const body = await readJson(req);
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) fail(400, 'bad-email', { message: 'Enter a valid email address.' });
      throttle(req, ...mailKeys(req, email));
      const reset = body.kind === 'reset';
      const account = reset ? store.accountByEmail(email) : null;
      const key = reset ? account && `reset:${account.id}` : `signup:${email}`;
      const p = key && pending.get(key);
      if (p && p.expires > now() && (p.resends || 0) < 3) {
        limiter.note(...mailKeys(req, email));
        if (reset) startCode(key, email, 'Your Headroom password reset code', 'Use this code to choose a new password.', { resends: (p.resends || 0) + 1 });
        else startCode(key, email, 'Your Headroom sign-up code', 'Finish creating your Headroom account with this code.', { resends: (p.resends || 0) + 1 });
      }
      return { ok: true };
    },

    'POST /api/account/reset': async (req) => {
      const body = await readJson(req);
      const account = store.accountByEmail(body.email);
      const key = `reset:${account?.id || normalizeEmail(body.email)}`;
      const problem = await passwordProblem(body.password, normalizeEmail(body.email).split('@')[0]);
      if (problem) fail(400, 'weak-password', { message: problem });
      takeCode(req, key, body.code);
      if (!account) fail(400, 'bad-code');
      account.password = await hashPassword(body.password);
      const n = signOutViewers(account.id);
      store.save();
      audit(`password reset by email for ${account.email}; ${n} sign-in(s) ended`);
      send(account.email, 'Your Headroom password was changed', `Your password was reset${n ? ` and ${n} browser(s) or phone(s) were signed out` : ''}.\n\nIf this wasn't you, reset it again right away with "Forgot password?".\n\n${site()}`);
      return { ok: true };
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
      const problem = await passwordProblem(body.password, account.email.split('@')[0]);
      if (problem) fail(400, 'weak-password', { message: problem });
      account.password = await hashPassword(body.password);
      const n = signOutViewers(account.id, dev.id);
      store.save();
      audit(`${account.email} changed their password; ${n} other sign-in(s) ended`);
      send(account.email, 'Your Headroom password was changed', `Your password was changed${n ? ` and ${n} other browser(s) or phone(s) were signed out` : ''}.\n\nIf this wasn't you, reset it right away with "Forgot password?".\n\n${site()}`);
      return { ok: true, signedOut: n };
    },

    // Changing the email: a code to the new address proves it; the old address is told.
    'POST /api/account/email': async (req) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      await confirmPassword(req, account, body.password);
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) fail(400, 'bad-email', { message: 'Enter a valid email address.' });
      if (store.accountByEmail(email)) fail(409, 'exists', { message: 'That email already has an account.' });
      throttle(req, ...mailKeys(req, email));
      limiter.note(...mailKeys(req, email));
      startCode(`email:${account.id}`, email, 'Confirm your new Headroom email', 'Use this code to make this your Headroom account\'s email.', { email });
      return { ok: true };
    },

    'POST /api/account/email/verify': async (req) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      const p = takeCode(req, `email:${account.id}`, body.code);
      if (store.accountByEmail(p.email)) fail(409, 'exists', { message: 'That email already has an account.' });
      const old = account.email;
      account.email = p.email;
      store.save();
      audit(`${old} changed their email to ${p.email}`);
      send(old, 'Your Headroom email was changed', `Your Headroom account now uses ${p.email}.\n\nIf this wasn't you, contact the operator of ${site()} right away.\n\n${site()}`);
      return { ok: true, email: account.email };
    },

    'POST /api/account/delete': async (req) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      await confirmPassword(req, account, body.password);
      for (const d of store.data.devices.filter(d => d.accountId === account.id)) removeDevice(d);
      store.data.computers = store.data.computers.filter(c => c.accountId !== account.id);
      store.data.accounts = store.data.accounts.filter(a => a.id !== account.id);
      store.save();
      audit(`account deleted: ${account.email}`);
      send(account.email, 'Your Headroom account was deleted', `Your Headroom account and its list of devices were deleted.\n\n${site()}`);
      return { ok: true };
    },

    'POST /api/account/totp/setup': (req) => {
      const { account } = authenticate(req, 'viewer');
      const secret = totpSecret();
      pendingTotp.set(account.id, secret);
      return { secret, uri: `otpauth://totp/Headroom:${encodeURIComponent(account.email)}?secret=${secret}&issuer=Headroom&digits=6&period=30` };
    },

    'POST /api/account/totp/enable': async (req) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      const secret = pendingTotp.get(account.id);
      if (!secret) fail(400, 'Start setup first.');
      if (!totpVerify({ totpSecret: secret }, body.code)) fail(400, 'bad-totp', { message: 'That code didn\'t match. Check the time on your phone and try the next code.' });
      pendingTotp.delete(account.id);
      Object.assign(account, { totpSecret: secret, totpEnabled: true, totpLastStep: Math.floor(Date.now() / 30000) });
      store.save();
      audit(`${account.email} turned on two-factor sign-in`);
      return { ok: true };
    },

    'POST /api/account/totp/disable': async (req) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      await confirmPassword(req, account, body.password);
      Object.assign(account, { totpSecret: null, totpEnabled: false });
      store.save();
      audit(`${account.email} turned off two-factor sign-in`);
      send(account.email, 'Two-factor sign-in was turned off', `Two-factor sign-in was turned off for your Headroom account.\n\nIf this wasn't you, change your password right away.\n\n${site()}`);
      return { ok: true };
    },

    // Devices check in: publish how to reach them, learn which sign-ins may connect.
    'POST /api/computer/heartbeat': async (req) => {
      const { dev, account } = authenticate(req, 'computer');
      const b = await readJson(req, 256 * 1024);
      let c = store.computer(dev.id);
      if (!c) { c = { id: dev.id, accountId: account.id }; store.data.computers.push(c); }
      const changedName = str(b.name, 128) && str(b.name, 128) !== c.name;
      Object.assign(c, {
        hostId: str(b.hostId, 64), name: str(b.name, 128) || c.name || dev.name, os: str(b.os, 16), osVersion: str(b.osVersion, 32),
        version: str(b.version, 32), urls: Array.isArray(b.urls) ? b.urls.filter(u => /^https:\/\//.test(u)).slice(0, 16).map(u => str(u, 300)) : [],
        spki: str(b.spki, 64) || null, fingerprint: str(b.fingerprint, 64) || null, ca: str(b.ca, 8192) || null, lastSeen: new Date(now()).toISOString(),
      });
      if (changedName) dev.name = c.name;
      store.touch();
      const devices = store.data.devices
        .filter(d => d.accountId === account.id && d.kind === 'viewer')
        .map(d => ({ id: d.id, name: d.name, tokenHash: sha256Hex(computerToken(store, d, c)), viewOnly: !!d.viewOnly }));
      return { computerId: c.id, account: { id: account.id, email: account.email }, devices, interval: HEARTBEAT_S };
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
      audit(`${d.kind === 'computer' ? 'device' : 'sign-in'} '${d.name}' removed from ${account.email}`);
      return { ok: true };
    }],
    [/^POST \/api\/account\/devices\/([\w-]+)$/, async (req, id) => {
      const { account } = authenticate(req, 'viewer');
      const body = await readJson(req);
      const d = store.device(id);
      if (!d || d.accountId !== account.id) fail(404, 'not found');
      if (typeof body.viewOnly === 'boolean') d.viewOnly = body.viewOnly;
      store.save();
      return { ok: true };
    }],
  ];
  if (DEV_MAIL) {
    routes['GET /api/dev/mail'] = req => devMailbox.get(normalizeEmail(new URL(req.url, 'http://x').searchParams.get('to'))) || fail(404, 'none');
  }

  // ----------------------------------------------------------------------------------------------- relay

  /**
   * The device behind /r/<relay id>/… (account devices, and guest sessions once accepted) or /c/<guest code
   * slot>/… (a guest code before it's accepted: only its name and the session), or an error to answer with.
   */
  function relayTarget(req, url) {
    let m = /^\/r\/([\w-]{9,24})(\/.*)?$/.exec(url.pathname);
    if (m) {
      const [, relayId, rest = '/'] = m;
      if (!RELAY) return { error: [404, 'relay-off'] };
      if (!RELAYED_PATHS.test(rest)) return { error: [403, 'not-relayed', 'Only sessions and file transfers go through the relay.'] };
      if (!relay.online(relayId)) return { error: [503, 'offline', 'That device isn\'t connected right now.'] };
      return { relayId, path: rest + url.search };
    }
    m = /^\/c\/(\d{4})(\/.*)?$/.exec(url.pathname);
    if (!m) return null;
    const [, slot, rest = '/'] = m;
    if (!RELAY) return { error: [404, 'relay-off'] };
    if (!GUEST_PATHS.test(rest)) return { error: [403, 'not-relayed'] };
    const key = 'guest-from:' + clientIp(req);
    const retry = limiter.retryAfter(key);
    if (retry) return { error: [429, 'rate-limited', `Too many attempts. Try again in ${retry} s.`] };
    const relayId = relay.slotTarget(slot);
    if (!relayId) {
      limiter.fail(key); // finding valid codes by trying is throttled (per address, and overall)
      return { error: [404, 'bad-code', 'That code isn\'t valid. Check it, or ask for a new one.'] };
    }
    return { relayId, path: rest + url.search, guest: true };
  }

  const countryOf = req => { const c = TRUST_PROXY ? str(req.headers['cf-ipcountry'], 8) : ''; return c && c !== 'XX' && c !== 'T1' ? c : ''; };

  /**
   * Request headers as the device should see them: hop-by-hop ones dropped, the viewer's address and country added,
   * and whether they came with a guest code (any X-Headroom-* the viewer sent is dropped first).
   */
  function forwardHeaders(req, ip, guest) {
    const out = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || lk.startsWith('x-headroom-')) continue;
      out[k] = req.rawHeaders[i + 1];
    }
    out['X-Headroom-Client'] = ip;
    const country = countryOf(req);
    if (country) out['X-Headroom-Country'] = country;
    if (guest) out['X-Headroom-Guest'] = '1';
    return out;
  }

  async function proxyRequest(req, res, target) {
    const ip = clientIp(req);
    let tunnel;
    try {
      tunnel = await relay.openTunnel(target.relayId, { ip, country: countryOf(req), guest: !!target.guest });
    } catch (e) {
      const body = JSON.stringify({ error: e.status === 504 ? 'timeout' : 'offline', message: e.message });
      res.writeHead(e.status || 502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      return;
    }
    const preq = http.request({
      createConnection: () => tunnel, setHost: false, // no agent: then Node uses createConnection
      method: req.method, path: target.path, headers: { Host: 'relay', ...forwardHeaders(req, ip, target.guest), Connection: 'close' },
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

  /** HTTP upgrades: devices' control and tunnel connections, and viewers' WebSockets to /r/… and /c/…. */
  async function upgrade(req, socket, head) {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url, 'http://x');
    const proto = String(req.headers.upgrade || '').toLowerCase();
    try {
      if (url.pathname === '/api/relay/control') {
        if (!RELAY) return rawResponse(socket, 404, 'Not Found', {}, '{"error":"relay-off"}');
        if (relay.hosts.size >= MAX_HOSTS) return rawResponse(socket, 503, 'Busy', {}, '{"error":"busy"}');
        const ip = clientIp(req);
        if (!req.headers.authorization) {
          // A device that isn't signed in to an account: reachable only with a guest code. A fresh, unguessable
          // relay id each time; a few per network address.
          if (relay.guestHostsFrom(ip) >= GUEST_HOSTS_PER_ADDRESS) return rawResponse(socket, 429, 'Too Many', {}, '{"error":"rate-limited"}');
          // They can't take the room account devices need.
          if (relay.anonymous() >= Math.floor(MAX_HOSTS * 0.6)) return rawResponse(socket, 503, 'Busy', {}, '{"error":"busy"}');
          const link = acceptWebSocket(req, socket, head);
          if (link) relay.attach(randomId(12), null, str(req.headers['x-headroom-name'], 64) || 'Device', link, ip);
          return;
        }
        const { dev, account } = authenticate(req, 'computer');
        let c = store.computer(dev.id);
        if (!c) { c = { id: dev.id, accountId: account.id, name: dev.name }; store.data.computers.push(c); }
        c.hostId ||= str(req.headers['x-headroom-host-id'], 64) || undefined;
        if (!c.relayId) {
          // Kept if the device leaves the account and signs in again.
          const key = c.hostId && `${account.id}:${c.hostId}`;
          const known = key && store.data.relayIds?.[key];
          const taken = id => store.data.computers.some(x => x !== c && x.relayId === id);
          c.relayId = known && !taken(known) ? known : newRelayId(taken);
          if (key) (store.data.relayIds ||= {})[key] = c.relayId;
          store.save();
        }
        const link = acceptWebSocket(req, socket, head);
        if (link) relay.attach(c.relayId, c.id, c.name || dev.name, link, ip);
        return;
      }
      const tm = /^\/api\/relay\/tunnel\/([\w-]{20,40})$/.exec(url.pathname);
      if (tm) return relay.acceptTunnel(tm[1], req, socket, head);
      const target = relayTarget(req, url);
      if (target && proto === 'websocket') {
        if (target.error) return rawResponse(socket, target.error[0], 'Error', {}, JSON.stringify({ error: target.error[1], message: target.error[2] }));
        const ip = clientIp(req);
        const tunnel = await relay.openTunnel(target.relayId, { ip, country: countryOf(req), guest: !!target.guest }).catch(e => { rawResponse(socket, e.status || 502, 'Unavailable'); return null; });
        if (!tunnel) return;
        const lines = [`GET ${target.path} HTTP/1.1`, 'Host: relay', 'Connection: Upgrade', 'Upgrade: websocket'];
        for (const [k, v] of Object.entries(forwardHeaders(req, ip, target.guest))) lines.push(`${k}: ${v}`);
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
      // The web app runs only its own scripts (plus Cloudflare Turnstile on sign-up); it connects to devices
      // anywhere (directly or through this relay).
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' https: wss: http: ws:; " +
        "frame-src https://challenges.cloudflare.com; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; " +
        "form-action 'self'; frame-ancestors 'none'",
    };
    if (req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').startsWith('https'))) {
      headers['Strict-Transport-Security'] = 'max-age=31536000';
    }
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const target = relayTarget(req, url);
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
      // Bearer tokens, no cookies: any origin may call the API (the Viewer app is served from its own origin).
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
  handle.limiter = limiter;
  return handle;
}

/** Sends an email through Resend (or, unconfigured, writes it to the log so a local test can read the code). */
export async function sendMail(to, subject, text) {
  if (!RESEND_API_KEY || !EMAIL_FROM) {
    if (!DEV_MAIL) log(`email not configured (RESEND_API_KEY, EMAIL_FROM); would send to ${to}: ${subject}\n${text}`);
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text }),
  });
  if (!r.ok) throw new Error(`Resend answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

// An existing hash to verify against when the email has no account, so timing doesn't reveal accounts.
let DUMMY_PASSWORD = null;
const dummyReady = hashPassword(crypto.randomBytes(16).toString('hex')).then(h => { DUMMY_PASSWORD = h; });

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

/** A new password: typed twice at a terminal, so a typo can't lock anyone out (null when they differ); piped in once. */
async function askNewPassword(prompt) {
  const pw = await ask(prompt, true);
  if (!process.stdin.isTTY) return pw;
  return await ask('Type it again: ', true) === pw ? pw : null;
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
  const changes = ['add-user', 'reset-password', 'reset-2fa', 'disable-user', 'enable-user', 'delete-user'];
  // A running server would overwrite changes made here with its in-memory copy: refuse instead.
  if (changes.includes(cmd) && runningServer()) {
    console.log('The account server is running on this data directory. Stop it first (e.g. sudo systemctl stop headroom-accounts),');
    console.log('run this again, then start it.');
    return 1;
  }
  const store = new Store(DATA_DIR);
  const email = normalizeEmail(args[0]);
  const account = email && store.accountByEmail(email);
  if (changes.includes(cmd) && cmd !== 'add-user' && !account) { console.log(email ? 'No account with that email.' : `usage: ${cmd} <email>`); return 1; }
  const viewers = () => store.data.devices.filter(d => d.accountId === account.id && d.kind === 'viewer');
  switch (cmd) {
    case 'add-user': {
      if (!validEmail(email)) { console.log('usage: add-user <email>'); return 1; }
      if (account) { console.log('That email already has an account.'); return 1; }
      const pw = await askNewPassword(`Password (${MIN_PASSWORD}+ characters): `);
      if (pw === null) { console.log('The passwords don\'t match. Nothing changed.'); return 1; }
      const problem = await passwordProblem(pw, email.split('@')[0]);
      if (problem) { console.log(problem); return 1; }
      store.data.accounts.push({ id: randomId(), email, password: await hashPassword(pw), created: new Date().toISOString(), totpEnabled: false });
      store.save();
      audit(`account created from the command line: ${email}`);
      console.log(`Created ${email}.`);
      return 0;
    }
    case 'list-users':
      for (const a of store.data.accounts) {
        const devs = store.data.devices.filter(d => d.accountId === a.id);
        const n = devs.filter(d => d.kind === 'computer').length;
        console.log(`${a.email.padEnd(40)} ${n} device(s), ${devs.length - n} sign-in(s)${a.totpEnabled ? ', 2FA on' : ''}${a.disabled ? ', DISABLED' : ''}`);
      }
      return 0;
    case 'reset-password': {
      const pw = await askNewPassword(`New password (${MIN_PASSWORD}+ characters): `);
      if (pw === null) { console.log('The passwords don\'t match. Nothing changed.'); return 1; }
      const problem = await passwordProblem(pw, email.split('@')[0]);
      if (problem) { console.log(problem); return 1; }
      account.password = await hashPassword(pw);
      const out = viewers();
      store.data.devices = store.data.devices.filter(d => !out.includes(d));
      store.save();
      audit(`password of ${email} reset from the command line; ${out.length} sign-in(s) ended`);
      console.log(`Password changed; ${out.length} signed-in browser(s)/phone(s) must sign in again.`);
      return 0;
    }
    case 'reset-2fa':
      Object.assign(account, { totpSecret: null, totpEnabled: false });
      store.save();
      audit(`two-factor sign-in of ${email} turned off from the command line`);
      console.log('Two-factor sign-in turned off.');
      return 0;
    case 'disable-user': {
      account.disabled = true;
      const out = viewers();
      store.data.devices = store.data.devices.filter(d => !out.includes(d));
      store.save();
      audit(`${email} disabled from the command line`);
      console.log(`Disabled: it can't sign in, its devices can't be reached, and ${out.length} sign-in(s) ended. Undo with enable-user.`);
      return 0;
    }
    case 'enable-user':
      account.disabled = false;
      store.save();
      audit(`${email} enabled from the command line`);
      console.log('Enabled.');
      return 0;
    case 'delete-user':
      store.data.devices = store.data.devices.filter(d => d.accountId !== account.id);
      store.data.computers = store.data.computers.filter(c => c.accountId !== account.id);
      store.data.accounts = store.data.accounts.filter(a => a.id !== account.id);
      store.save();
      audit(`${email} deleted from the command line`);
      console.log('Deleted, with its devices and sign-ins.');
      return 0;
    default:
      console.log('commands: list-users | add-user <email> | reset-password <email> | reset-2fa <email> | disable-user <email> | enable-user <email> | delete-user <email>');
      return cmd ? 1 : 0;
  }
}

// ------------------------------------------------------------------------------------------------- main

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd) process.exit(await cli(cmd, args));
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
    log(`sign-up: ${SIGNUP}; email: ${RESEND_API_KEY && EMAIL_FROM ? `Resend, from ${EMAIL_FROM}` : DEV_MAIL ? 'testing mailbox (DEV_MAIL=1)' : 'NOT CONFIGURED (set RESEND_API_KEY and EMAIL_FROM): codes are only written to this log'}`);
    log(`human check: ${TURNSTILE_SECRET && TURNSTILE_SITEKEY ? 'Cloudflare Turnstile' : 'off (set TURNSTILE_SITEKEY and TURNSTILE_SECRET)'}`);
    // Only worth saying when it's reachable directly: on loopback it sits behind a tunnel or proxy that adds HTTPS.
    if (!tls && !['127.0.0.1', 'localhost', '::1'].includes(BIND)) log('serving plain HTTP: put it behind HTTPS (a reverse proxy, or TLS_CERT/TLS_KEY) before using it beyond this machine');
    log(`relay: ${RELAY ? 'on' : 'off'}`);
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
