#!/usr/bin/env node
// Measures what a viewer of a Headroom host gets, as a guest through its relay (like tools/protocol-check.mjs, and
// run on the host the same way): frames per second, bitrate, the host's target bitrate and frame RTT,
// capture-to-arrival latency, resolution, and how hard the encoder compressed (each frame's average QP from
// ffmpeg's QP tables: lower is sharper).
//
//   node tools/stream-check.mjs [--url=http://127.0.0.1:7080] [--seconds=20] [--ack-delay=0] [--ack-jitter=0]
//                               [--link-kbps=0] [--max-width=0] [--max-kbps=0] [--min-target-kbps=0] [--out=stream-check.h264] [--quiet]
//
// --ack-delay / --ack-jitter (ms) hold each frame's ack back, and --link-kbps adds its transmission time on a link
// that fast, as a longer network path would (the jitter is seeded: every run sees the same delays).
// --min-target-kbps: fail (exit 1) if the host's bitrate target drops below this after the first 3 s. On an 80 ms
// path a stream that sends little (a mostly still screen) once looked congested and fell to its floor; CI checks it.
// HEADROOM_TEST_PATTERN_STYLE=desktop on the host gives a page of text that scrolls: like a real desktop.
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const arg = (name, def) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const base = arg('url', 'http://127.0.0.1:7080').replace(/\/$/, '');
const seconds = Number(arg('seconds', '20'));
const ackDelay = Number(arg('ack-delay', '0')), ackJitter = Number(arg('ack-jitter', '0'));
// --link-kbps: a frame's ack also waits its transmission time on a link that fast (bigger frames, later acks).
const linkKbps = Number(arg('link-kbps', '0'));
const maxWidth = Number(arg('max-width', '0'));
const maxKbps = Number(arg('max-kbps', '0')) || undefined; // the viewer's bitrate cap (Settings → quality)
const outFile = arg('out', 'stream-check.h264');
const minTarget = Number(arg('min-target-kbps', '0'));
const quiet = process.argv.includes('--quiet');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Seeded jitter, so every run sees the same delays.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const json = async (url, opts = {}) => {
  const r = await fetch(url.startsWith('http') ? url : base + url, { ...opts, headers: { 'Content-Type': 'application/json' } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

// ------------------------------------------------------------------ a guest code, accepted by "the person here"
let st;
for (let i = 0; i < 30; i++) { st = (await json('/api/admin/status')).body; if (st.relay?.state === 'online') break; await sleep(1000); }
if (st.relay?.state !== 'online') { console.error('host not connected to its relay:', st.relay); process.exit(2); }
const made = (await json('/api/admin/support/code', { method: 'POST' })).body;
const code = made.code, relay = new URL(made.link).origin;
const guestWs = `${relay.replace(/^http/, 'ws')}/c/${code.slice(0, 4)}/ws`;
const welcome0 = await new Promise(resolve => {
  const ws = new WebSocket(guestWs);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', support: { code, name: 'stream-check' }, client: { name: 'stream-check', platform: 'node' } }));
  ws.onmessage = ev => { if (typeof ev.data === 'string') { const m = JSON.parse(ev.data); if (m.t === 'welcome' || m.t === 'error') { ws.close(); resolve(m); } } };
  (async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const r = (await json('/api/admin/status')).body.support?.requests?.find(q => q.name === 'stream-check');
      if (r) { await json(`/api/admin/support/requests/${r.id}`, { method: 'POST', body: JSON.stringify({ accept: true, viewOnly: true, files: false, clipboard: false }) }); return; }
    }
  })();
});
if (welcome0.t !== 'welcome') { console.error('not accepted:', welcome0); process.exit(2); }

// ------------------------------------------------------------------ the session
const ws = new WebSocket(`${(relay + welcome0.relayPath).replace(/^http/, 'ws')}/ws`);
ws.binaryType = 'arraybuffer';
const frames = [], stats = [], configs = [];
let assembly = null, sps = null, pps = null, offsetUs = null, bestRtt = Infinity, t0 = 0, pingId = 0;
const chunks = [];
const startCode = Buffer.from([0, 0, 0, 1]);
const toAnnexB = avcc => { const out = []; for (let i = 0; i + 4 <= avcc.length;) { const n = avcc.readUInt32BE(i); out.push(startCode, avcc.subarray(i + 4, i + 4 + n)); i += 4 + n; } return Buffer.concat(out); };
const parseAvcC = b64 => {
  const d = Buffer.from(b64, 'base64'); const spsLen = d.readUInt16BE(6); const p0 = 8 + spsLen + 1;
  return { sps: d.subarray(8, 8 + spsLen), pps: d.subarray(p0 + 2, p0 + 2 + d.readUInt16BE(p0)) };
};

ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: welcome0.resumeToken, client: { name: 'stream-check', platform: 'node' } }));
ws.onmessage = ev => {
  const now = performance.now();
  if (typeof ev.data === 'string') {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      t0 = now;
      ws.send(JSON.stringify({ t: 'start', monitor: m.monitors[0]?.id, maxFps: 60, maxBitrateKbps: maxKbps, maxWidth, maxHeight: maxWidth ? Math.round(maxWidth * 0.75) : 0, audio: false }));
    } else if (m.t === 'video-config') { configs.push(m); ({ sps, pps } = parseAvcC(m.description)); }
    else if (m.t === 'stats') stats.push({ at: (now - t0) / 1000, ...m });
    else if (m.t === 'pong') {
      // Host clock vs ours, from the fastest round trip seen: captureUs becomes a time on our clock.
      const rtt = now - m.ts;
      if (rtt < bestRtt) { bestRtt = rtt; offsetUs = m.host - (m.ts + rtt / 2) * 1000; }
    }
    return;
  }
  const v = new DataView(ev.data);
  if (v.getUint8(0) !== 0x01) return;
  const flags = v.getUint8(1), frameId = v.getUint32(4, true), total = v.getInt32(8, true), offset = v.getInt32(12, true);
  const captureUs = Number(v.getBigInt64(16, true)), encodeMs = v.getUint16(24, true) / 10;
  if (flags & 2) assembly = { frameId, buf: new Uint8Array(total), key: !!(flags & 1), captureUs, encodeMs };
  if (!assembly || assembly.frameId !== frameId) return;
  assembly.buf.set(new Uint8Array(ev.data, 28), offset);
  if (flags & 4) {
    const a = assembly; assembly = null;
    const delay = ackDelay + (ackJitter ? rand() * ackJitter : 0) + (linkKbps ? a.buf.length * 8 / linkKbps : 0);
    const ack = () => { const b = new ArrayBuffer(5); const av = new DataView(b); av.setUint8(0, 0x15); av.setUint32(1, a.frameId, true); if (ws.readyState === 1) ws.send(b); };
    if (delay > 0) setTimeout(ack, delay); else ack();
    frames.push({ at: now, bytes: a.buf.length, key: a.key, captureUs: a.captureUs, encodeMs: a.encodeMs });
    if (sps) chunks.push(...(a.key ? [startCode, sps, startCode, pps] : []), toAnnexB(Buffer.from(a.buf)));
  }
};
const pinger = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', id: ++pingId, ts: performance.now() })); }, 250);
await sleep(seconds * 1000 + 1500);
clearInterval(pinger);
ws.close();
await json('/api/admin/sessions/disconnect-all', { method: 'POST' });

// ------------------------------------------------------------------ report
const lat = f => offsetUs == null ? NaN : f.at - (f.captureUs - offsetUs) / 1000;
const rows = [];
for (let s = 1; s <= seconds; s++) {
  const inSec = frames.filter(f => (f.at - t0) / 1000 >= s - 1 && (f.at - t0) / 1000 < s);
  const host = stats.findLast(x => x.at <= s + 0.5) || {};
  rows.push({ s, fps: inSec.length, kbps: Math.round(inSec.reduce((n, f) => n + f.bytes, 0) * 8 / 1000), target: host.targetKbps,
    rtt: host.frameRttMs, minRtt: host.minRttMs, enc: host.encodeMs, lat50: Math.round(pct(inSec.map(lat), 50)), lat95: Math.round(pct(inSec.map(lat), 95)) });
}
if (!quiet) {
  console.log(' sec  fps   kbps  target   rtt/min    enc   latency p50/p95');
  for (const r of rows) console.log(`${String(r.s).padStart(4)} ${String(r.fps).padStart(4)} ${String(r.kbps).padStart(6)} ${String(r.target ?? '-').padStart(7)} ${String(r.rtt ?? '-').padStart(6)}/${String(r.minRtt ?? '-').padEnd(5)} ${String(r.enc ?? '-').padStart(5)}  ${r.lat50}/${r.lat95} ms`);
}
writeFileSync(outFile, Buffer.concat(chunks));
// Each frame's average QP, from ffmpeg's per-macroblock QP tables (-debug qp): lower is sharper. The frames in the
// file are in arrival order, so frame i is frames[i].
const frameQp = [];
{
  // Without ffmpeg there's no QP (NaN): the rest still counts.
  const r = spawnSync('ffmpeg', ['-hide_banner', '-debug', 'qp', '-i', outFile, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 30 }).stderr || '';
  let sum = 0, n = 0;
  for (const line of r.split('\n')) {
    if (line.includes('New frame')) { if (n) frameQp.push(sum / n); sum = 0; n = 0; continue; }
    const m = line.match(/^\[h264 @ [^\]]+\]\s+\d+ (\d{4,})\s*$/);
    if (m) for (let i = 0; i + 2 <= m[1].length; i += 2) { sum += Number(m[1].slice(i, i + 2)); n++; }
  }
  if (n) frameQp.push(sum / n);
}
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
frames.forEach((f, i) => { f.qp = frameQp[i]; });
const qpKey = avg(frames.filter(f => f.key && f.qp != null).map(f => f.qp));
const qpAll = avg(frames.filter(f => f.qp != null).map(f => f.qp));
// Still frames ("refinement": sent ~70 ms apart once the screen stops) vs moving ones (16-30 ms apart).
const gaps = frames.map((f, i) => (i ? f.at - frames[i - 1].at : 0));
const qpStill = avg(frames.filter((f, i) => !f.key && gaps[i] > 55 && f.qp != null).map(f => f.qp));
const qpMoving = avg(frames.filter((f, i) => !f.key && gaps[i] > 0 && gaps[i] <= 40 && f.qp != null).map(f => f.qp));
const qp = qpAll;
const steady = rows.slice(2);
const cfg = configs.at(-1) || {};
const summary = {
  resolution: `${cfg.width}x${cfg.height} (screen ${cfg.sourceWidth}x${cfg.sourceHeight})`, encoder: cfg.encoder,
  fps: +(steady.reduce((n, r) => n + r.fps, 0) / steady.length).toFixed(1),
  kbps: Math.round(steady.reduce((n, r) => n + r.kbps, 0) / steady.length),
  targetKbps: Math.round(steady.reduce((n, r) => n + (r.target || 0), 0) / steady.length),
  latencyP50: Math.round(pct(frames.slice(30).map(lat), 50)), latencyP95: Math.round(pct(frames.slice(30).map(lat), 95)),
  qp: { all: +qp.toFixed(1), key: +qpKey.toFixed(1), moving: +qpMoving.toFixed(1), still: +qpStill.toFixed(1) },
  kbOutKey: Math.round(avg(frames.filter(f => f.key).map(f => f.bytes)) / 1024), frames: frames.length, keyframes: frames.filter(f => f.key).length, pingMs: +bestRtt.toFixed(1),
};
console.log('SUMMARY ' + JSON.stringify(summary));
const lowest = Math.min(...rows.slice(3).map(r => r.target).filter(Number.isFinite));
if (minTarget && !(lowest >= minTarget)) {
  console.log(`FAIL the host's bitrate target fell to ${lowest} kbps (under ${minTarget})`);
  process.exit(1);
}
