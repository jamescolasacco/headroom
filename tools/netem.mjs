#!/usr/bin/env node
// A slow, jittery, congested network between a viewer and the relay, for measurements (tools/audio-check.mjs starts
// it): a TCP proxy that keeps byte order. What the target (the relay, so the host) sends is released towards the
// client at the link's rate, each packet after the path's delay plus jitter (a byte never overtakes an earlier one),
// through a bottleneck buffer of `buf` ms: once that is full the proxy stops reading from the target, so the host
// feels real TCP backpressure. Optional stalls (the link carries nothing for a while, both ways) model a cellular
// network. What the client sends gets the base delay (and the stalls).
//
//   node tools/netem.mjs --listen=18801 --target=127.0.0.1:18800 [--profile=remote] [--rate-kbps=20000] [--delay=40]
//                        [--jitter=20] [--jitter-period=50] [--buf=150] [--stall=400] [--stall-every=20000] [--seed=1]
//
// Profiles (host -> client; custom flags override a profile's values):
//   lan        1 ms, no rate limit
//   wifi       3 ms ±15 ms, 100 Mb/s (buffer 100 ms)
//   remote     40 ms ±20 ms, 20 Mb/s, buffer 150 ms
//   cellular   70 ms ±40 ms, 8 Mb/s, buffer 400 ms, a 400 ms stall every 20 s (the first 20 s into each connection)
//   tight      20 ms ±5 ms, 4 Mb/s, buffer 200 ms
//   too-tight  20 ms ±5 ms, 2 Mb/s, buffer 200 ms (lossless sound alone needs 2.3 Mb/s)
//
// The model, per connection and direction (Link + Pipe below, no sockets, unit-tested in tests/audio-check.test.mjs):
// - Bytes are cut into packets of up to 1448 bytes. A packet starts transmitting when the link is free, takes
//   bytes·8/rate (stalls pause it), and arrives max(previous arrival, end of transmission + delay(t)).
// - delay(t) = max(0, base + J(t)); J goes in straight lines between values drawn uniformly from [-jitter, +jitter]
//   every jitter-period ms (seeded: every run sees the same path). Where J falls faster than time passes, packets
//   arrive bunched (they can't overtake), like Wi-Fi releasing a burst after a contention spell.
// - The bottleneck buffer holds the packets not yet transmitted: at most buf ms at the link rate. Bytes beyond that
//   wait unread (the target's socket, the relay and finally the host's channel fill up and stop it).
// Caveat: the kernel's socket buffers between the relay and this proxy (loopback, 128 KiB to a few MiB with
// auto-tuning) add room before the host is stopped, as a real relay's socket buffers do.
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export const PROFILES = {
  lan: { delayMs: 1 },
  wifi: { delayMs: 3, jitterMs: 15, rateKbps: 100_000, bufMs: 100 },
  remote: { delayMs: 40, jitterMs: 20, rateKbps: 20_000, bufMs: 150 },
  cellular: { delayMs: 70, jitterMs: 40, rateKbps: 8_000, bufMs: 400, stallMs: 400, stallEveryMs: 20_000 },
  tight: { delayMs: 20, jitterMs: 5, rateKbps: 4_000, bufMs: 200 },
  'too-tight': { delayMs: 20, jitterMs: 5, rateKbps: 2_000, bufMs: 200 },
};

export const LINK_DEFAULTS = { delayMs: 0, jitterMs: 0, jitterPeriodMs: 50, rateKbps: 0, bufMs: 100, stallMs: 0, stallEveryMs: 0, seed: 1, mtu: 1448 };

/** The profile's settings with custom overrides (undefined values don't override). */
export function linkOptions(profile, overrides = {}) {
  const base = profile ? PROFILES[profile] : {};
  if (profile && !base) throw new Error(`unknown profile "${profile}" (${Object.keys(PROFILES).join(', ')})`);
  const o = { ...LINK_DEFAULTS, ...base };
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined && v !== null && !Number.isNaN(v)) o[k] = v;
  return o;
}

/** The uplink (client -> host): the base delay and the same stalls, nothing else. */
export function uplinkOptions(o) {
  return { ...LINK_DEFAULTS, delayMs: o.delayMs, stallMs: o.stallMs, stallEveryMs: o.stallEveryMs, seed: o.seed + 7919, mtu: Infinity };
}

/** Small seeded PRNG (mulberry32): [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A FIFO with O(1) shift (an array with a moving head, compacted now and then). */
class Fifo {
  constructor() { this.a = []; this.h = 0; }
  get length() { return this.a.length - this.h; }
  push(x) { this.a.push(x); }
  peek() { return this.a[this.h]; }
  shift() {
    const x = this.a[this.h++];
    if (this.h > 1024 && this.h * 2 > this.a.length) { this.a = this.a.slice(this.h); this.h = 0; }
    return x;
  }
}

/**
 * One direction of one connection, as timing only (times in ms on any monotonic clock; t0 = when the connection
 * started, which is when the stall schedule and the jitter path start).
 */
export class Link {
  constructor(opts = {}, t0 = 0) {
    const o = { ...LINK_DEFAULTS, ...opts };
    this.o = o;
    this.t0 = t0;
    this.bytesPerMs = o.rateKbps > 0 ? o.rateKbps / 8 : Infinity; // 1 kbps = 1 bit per ms
    this.capacity = Number.isFinite(this.bytesPerMs) ? Math.max(Math.min(o.mtu, 65536), o.bufMs * this.bytesPerMs) : Infinity;
    this.rand = mulberry32(o.seed);
    this.targets = [];
    this.txFree = t0;
    this.lastDeliver = -Infinity;
    this.queue = new Fifo(); // packets not yet fully transmitted: { bytes, txEnd }
    this.queued = 0;
  }

  /** The jitter offset J(t), ms. */
  jitterAt(t) {
    const { jitterMs: j, jitterPeriodMs: p } = this.o;
    if (!(j > 0)) return 0;
    const x = Math.max(0, t - this.t0) / p;
    const m = Math.floor(x);
    while (this.targets.length < m + 2) this.targets.push((this.rand() * 2 - 1) * j);
    return this.targets[m] + (this.targets[m + 1] - this.targets[m]) * (x - m);
  }

  delayAt(t) { return Math.max(0, this.o.delayMs + this.jitterAt(t)); }

  /** If `t` is inside a stall: when it ends; otherwise null. Stalls start every stallEveryMs after t0 (not at t0). */
  stallEnd(t) {
    const { stallMs: s, stallEveryMs: e } = this.o;
    if (!(s > 0 && e > 0)) return null;
    const k = Math.floor((t - this.t0) / e);
    if (k < 1) return null;
    const end = this.t0 + k * e + s;
    return t < end ? end : null;
  }

  nextStallStart(t) {
    const { stallMs: s, stallEveryMs: e } = this.o;
    if (!(s > 0 && e > 0)) return Infinity;
    return this.t0 + (Math.max(0, Math.floor((t - this.t0) / e)) + 1) * e;
  }

  /** When `bytes` finish transmitting if they start at `t` (stalls pause the transmission). */
  txDone(t, bytes) {
    let need = Number.isFinite(this.bytesPerMs) ? bytes / this.bytesPerMs : 0;
    for (;;) {
      const s = this.stallEnd(t);
      if (s !== null) t = s;
      const next = this.nextStallStart(t);
      if (t + need <= next) return t + need;
      need -= next - t;
      t = next;
    }
  }

  /** Bytes in the bottleneck buffer at `now` (packets whose transmission hasn't ended). */
  queuedAt(now) {
    while (this.queue.length && this.queue.peek().txEnd <= now) this.queued -= this.queue.shift().bytes;
    return this.queued;
  }

  room(now) { return this.capacity - this.queuedAt(now); }

  /** When the buffer next has more room (the oldest queued packet is sent), or Infinity. */
  nextRoomAt(now) {
    this.queuedAt(now);
    return this.queue.length ? this.queue.peek().txEnd : Infinity;
  }

  /** Puts a packet on the link at `now`: when its transmission ends and when it arrives. */
  send(bytes, now) {
    const txStart = Math.max(now, this.txFree);
    const txEnd = this.txDone(txStart, bytes);
    this.txFree = txEnd;
    const deliverAt = Math.max(this.lastDeliver, txEnd + this.delayAt(txEnd));
    this.lastDeliver = deliverAt;
    if (txEnd > now) { this.queue.push({ bytes, txEnd }); this.queued += bytes; }
    return { txStart, txEnd, deliverAt };
  }
}

/**
 * One direction of one connection with its bytes: write() what the source sent, poll() for what has arrived at the
 * other end by now, whether the source must stay paused, and when to poll again.
 */
export class Pipe {
  constructor(link) {
    this.link = link;
    this.pending = []; // read from the source, not yet in the bottleneck buffer (waits: the source is paused)
    this.headOff = 0;
    this.pendingBytes = 0;
    this.flight = new Fifo(); // { buf, deliverAt, at }
    this.stats = { bytesIn: 0, bytesOut: 0, packets: 0, maxQueued: 0, maxPending: 0, holdMaxMs: 0, holdSumMs: 0, pausedMs: 0, pauses: 0 };
    this._pausedSince = null;
  }

  /** Bytes from the source at `now`. Returns true while the source should stop (bytes wait outside the buffer). */
  write(buf, now) {
    if (buf.length) { this.pending.push(buf); this.pendingBytes += buf.length; this.stats.bytesIn += buf.length; }
    this.stats.maxPending = Math.max(this.stats.maxPending, this.pendingBytes);
    this._admit(now);
    return this._paused(now);
  }

  _take(n) {
    const parts = [];
    let left = n;
    while (left > 0) {
      const h = this.pending[0];
      const k = Math.min(h.length - this.headOff, left);
      parts.push(h.subarray(this.headOff, this.headOff + k));
      this.headOff += k;
      left -= k;
      if (this.headOff === h.length) { this.pending.shift(); this.headOff = 0; }
    }
    this.pendingBytes -= n;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  _admit(now) {
    const L = this.link;
    const finite = Number.isFinite(L.bytesPerMs);
    while (this.pendingBytes > 0) {
      const n = finite ? Math.min(L.o.mtu, this.pendingBytes) : this.pendingBytes;
      if (L.room(now) < n) break;
      const buf = this._take(n);
      const { deliverAt } = L.send(n, now);
      this.flight.push({ buf, deliverAt, at: now });
      this.stats.packets++;
      this.stats.maxQueued = Math.max(this.stats.maxQueued, L.queued);
    }
  }

  _paused(now) {
    const p = this.pendingBytes > 0;
    if (p && this._pausedSince === null) { this._pausedSince = now; this.stats.pauses++; }
    if (!p && this._pausedSince !== null) { this.stats.pausedMs += now - this._pausedSince; this._pausedSince = null; }
    return p;
  }

  /** What has arrived by `now` (in order, or null), whether the source stays paused, and when to poll next. */
  poll(now) {
    this._admit(now);
    const out = [];
    while (this.flight.length && this.flight.peek().deliverAt <= now + 0.25) {
      const f = this.flight.shift();
      out.push(f.buf);
      const hold = f.deliverAt - f.at;
      this.stats.holdMaxMs = Math.max(this.stats.holdMaxMs, hold);
      this.stats.holdSumMs += hold * f.buf.length;
      this.stats.bytesOut += f.buf.length;
    }
    const paused = this._paused(now);
    const nextAt = Math.min(this.flight.length ? this.flight.peek().deliverAt : Infinity, paused ? this.link.nextRoomAt(now) : Infinity);
    return { out: out.length ? (out.length === 1 ? out[0] : Buffer.concat(out)) : null, paused, nextAt, idle: !this.flight.length && !this.pendingBytes };
  }
}

const nowMs = () => performance.now();

/**
 * The proxy: listens on `listen` (127.0.0.1), connects each client to target, and runs both directions through
 * Pipes. Returns { server, stats(), close() }.
 */
export function startProxy({ listen, targetHost = '127.0.0.1', targetPort, down, up = uplinkOptions(down), onError = () => { } }) {
  const conns = new Set();
  let n = 0;
  const totals = { connections: 0 };
  const server = net.createServer({ noDelay: true }, client => {
    const id = ++n;
    totals.connections++;
    const t0 = nowMs();
    const upstream = net.connect({ host: targetHost, port: targetPort, noDelay: true });
    client.setNoDelay(true);
    const c = { id, t0, client, upstream, down: new Pipe(new Link({ ...down, seed: (down.seed || 1) + id * 101 }, t0)), up: new Pipe(new Link({ ...up, seed: (up.seed || 1) + id * 101 }, t0)) };
    conns.add(c);
    const closeBoth = () => { client.destroy(); upstream.destroy(); };
    wire(upstream, client, c.down, closeBoth);
    wire(client, upstream, c.up, closeBoth);
    const done = () => { if (client.destroyed && upstream.destroyed) { c.closedAt = nowMs(); } };
    client.on('close', done);
    upstream.on('close', done);
    upstream.on('error', e => { onError(e); closeBoth(); });
    client.on('error', e => { onError(e); closeBoth(); });
  });

  function wire(src, dst, pipe, closeBoth) {
    let timer = null, ended = false;
    const run = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const t = nowMs();
      const r = pipe.poll(t);
      if (r.out && !dst.destroyed) dst.write(r.out);
      if (r.paused) { if (!src.isPaused()) src.pause(); } else if (src.isPaused() && !src.destroyed) src.resume();
      if (ended && r.idle) { if (!dst.destroyed) dst.end(); return; }
      if (r.nextAt < Infinity) timer = setTimeout(run, Math.max(0, r.nextAt - nowMs()));
    };
    src.on('data', d => { if (pipe.write(d, nowMs())) src.pause(); run(); });
    src.on('end', () => { ended = true; run(); });
    src.on('close', () => { ended = true; if (!pipe.flight.length && !pipe.pendingBytes) closeBoth(); else run(); });
  }

  const stats = () => {
    const sum = dir => {
      const s = { bytesIn: 0, bytesOut: 0, packets: 0, maxQueued: 0, maxPending: 0, holdMaxMs: 0, holdSumMs: 0, pausedMs: 0, pauses: 0 };
      for (const c of conns) {
        const p = c[dir].stats;
        for (const k of Object.keys(s)) s[k] = k.startsWith('max') || k === 'holdMaxMs' ? Math.max(s[k], p[k]) : s[k] + p[k];
        if (c[dir]._pausedSince !== null) s.pausedMs += nowMs() - c[dir]._pausedSince;
      }
      s.holdMeanMs = s.bytesOut ? +(s.holdSumMs / s.bytesOut).toFixed(2) : 0;
      delete s.holdSumMs;
      s.holdMaxMs = +s.holdMaxMs.toFixed(2);
      s.pausedMs = Math.round(s.pausedMs);
      return s;
    };
    return { ...totals, down: sum('down'), up: sum('up'), capacityBytes: Number.isFinite(new Link(down).capacity) ? Math.round(new Link(down).capacity) : null };
  };

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen, '127.0.0.1', () => resolve(server.address().port));
  });
  const close = () => new Promise(r => {
    for (const c of conns) { c.client.destroy(); c.upstream.destroy(); }
    server.close(() => r());
  });
  return { server, ready, stats, close };
}

// ------------------------------------------------------------------------------------------------ command line
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, def) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
  const num = name => { const v = arg(name); return v === undefined ? undefined : Number(v); };
  const [targetHost, targetPort] = (arg('target', '127.0.0.1:18800')).split(':');
  const down = linkOptions(arg('profile'), {
    rateKbps: num('rate-kbps'), delayMs: num('delay'), jitterMs: num('jitter'), jitterPeriodMs: num('jitter-period'),
    bufMs: num('buf'), stallMs: num('stall'), stallEveryMs: num('stall-every'), seed: num('seed'),
  });
  const p = startProxy({ listen: Number(arg('listen', '18801')), targetHost, targetPort: Number(targetPort), down });
  const port = await p.ready;
  const say = m => (process.send ? process.send(m) : console.log(JSON.stringify(m)));
  say({ t: 'ready', port, down, up: uplinkOptions(down) });
  process.on('message', m => {
    if (m?.t === 'stats') say({ t: 'stats', stats: p.stats() });
    if (m?.t === 'stop') p.close().then(() => process.exit(0));
  });
  process.on('disconnect', () => p.close().then(() => process.exit(0)));
  process.on('SIGTERM', () => p.close().then(() => process.exit(0)));
}
