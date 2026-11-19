#!/usr/bin/env node
// Measures what a viewer of a Headroom host gets, as a guest through its relay (like tools/protocol-check.mjs, and
// run on the host the same way): frames per second, bitrate, the host's target bitrate and frame RTT,
// capture-to-arrival latency, resolution, and how hard the encoder compressed (each frame's average QP from
// ffmpeg's QP tables: lower is sharper).
//
//   node tools/stream-check.mjs [--url=http://127.0.0.1:7080] [--seconds=20] [--ack-delay=0] [--ack-jitter=0]
//                               [--link-kbps=0] [--max-width=0] [--max-kbps=0] [--max-fps=60] [--min-target-kbps=0] [--out=stream-check.h264]
//                               [--dump=<dir>] [--source=<dir>] [--frames=<file.json>] [--quiet]
//
// After the screen stops changing (the desktop test pattern scrolls for 2 s, then holds still for 2 s), the host
// encodes the still picture again to sharpen it (frames flagged "refine"): the report says how sharp the picture is
// 0.25, 0.5 and 1 s after it stopped (the QP of the newest frame by then), how sharp it ends up, and when.
// --dump writes the decoded picture at those moments, for one stop, as PNGs.
// --source=<dir>: where the host's test pattern wrote what it drew (HEADROOM_TEST_PATTERN_DUMP=<dir>): the decoded
// picture at each moment is scored against it (PSNR of the text, in dB: higher is closer; under ~30 looks smudged).
//
// --ack-delay / --ack-jitter (ms) hold each frame's ack back, as a longer network path would, and --link-kbps passes
// the frames through a link that fast, one after another: a frame counts as arrived (and is acked) once the ones
// before it and its own bytes have crossed (the jitter is seeded: every run sees the same delays).
// --min-target-kbps: fail (exit 1) if the host's bitrate target drops below this after the first 3 s. On an 80 ms
// path a stream that sends little (a mostly still screen) once looked congested and fell to its floor; CI checks it.
// HEADROOM_TEST_PATTERN_STYLE=desktop on the host gives a page of text that scrolls: like a real desktop.
import { writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const arg = (name, def) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const base = arg('url', 'http://127.0.0.1:7080').replace(/\/$/, '');
const seconds = Number(arg('seconds', '20'));
const ackDelay = Number(arg('ack-delay', '0')), ackJitter = Number(arg('ack-jitter', '0'));
// --link-kbps: frames cross a link that fast one after another (bigger frames and queues arrive later).
const linkKbps = Number(arg('link-kbps', '0'));
let linkFreeAt = 0;
const maxWidth = Number(arg('max-width', '0'));
const maxKbps = Number(arg('max-kbps', '0')) || undefined; // the viewer's bitrate cap (Settings → quality)
const maxFps = Number(arg('max-fps', '60'));
const outFile = arg('out', 'stream-check.h264');
const dumpDir = arg('dump', '');
const sourceDir = arg('source', '');
const framesFile = arg('frames', ''); // every frame's arrival, size, kind and capture time, as JSON (for digging in)
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
      ws.send(JSON.stringify({ t: 'start', monitor: m.monitors[0]?.id, maxFps, maxBitrateKbps: maxKbps, maxWidth, maxHeight: maxWidth ? Math.round(maxWidth * 0.75) : 0, audio: false }));
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
  if (flags & 2) assembly = { frameId, buf: new Uint8Array(total), key: !!(flags & 1), refine: !!(flags & 8), captureUs, encodeMs };
  if (!assembly || assembly.frameId !== frameId) return;
  assembly.buf.set(new Uint8Array(ev.data, 28), offset);
  if (flags & 4) {
    const a = assembly; assembly = null;
    let at = now;
    if (linkKbps) { at = Math.max(now, linkFreeAt) + a.buf.length * 8 / linkKbps; linkFreeAt = at; }
    const delay = at - now + ackDelay + (ackJitter ? rand() * ackJitter : 0);
    const ack = () => { const b = new ArrayBuffer(5); const av = new DataView(b); av.setUint8(0, 0x15); av.setUint32(1, a.frameId, true); if (ws.readyState === 1) ws.send(b); };
    if (delay > 0) setTimeout(ack, delay); else ack();
    frames.push({ at, bytes: a.buf.length, key: a.key, refine: a.refine, captureUs: a.captureUs, encodeMs: a.encodeMs });
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
if (framesFile) writeFileSync(framesFile, JSON.stringify(frames.map(f => ({ at: +(f.at - t0).toFixed(1), bytes: f.bytes, key: f.key, refine: f.refine, latency: +lat(f).toFixed(1) }))));
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
// Each stop: the last new picture, then the sharpening passes until the next new one. The QP "seen" at a moment is
// the newest frame's by then (what's on the screen). The first stop (the stream starting) is left out.
// Hosts before 0.4.10 didn't flag their sharpening passes: there, a frame taken 55-400 ms after the one before is one
// (they sent four, 70 ms apart; the first new picture after a still screen comes much later).
if (!frames.some(f => f.refine)) frames.forEach((f, i) => { const gap = i ? (f.captureUs - frames[i - 1].captureUs) / 1000 : 0; f.refine = !f.key && gap >= 55 && gap <= 400; });
const stops = [];
for (let i = 1; i < frames.length; i++) {
  if (!frames[i].refine || frames[i - 1].refine) continue;
  const stopAt = frames[i - 1].at;
  let j = i;
  while (j + 1 < frames.length && frames[j + 1].refine) j++;
  const seen = ms => { let k = i - 1; while (k < j && frames[k + 1].at <= stopAt + ms) k++; return frames[k].qp; };
  stops.push({ i, j, stopIndex: i - 1, at0: frames[i - 1].qp, at250: seen(250), at500: seen(500), at1000: seen(1000), final: frames[j].qp,
    settleMs: frames[j].at - stopAt, passes: j - i + 1, kb: frames.slice(i, j + 1).reduce((n, f) => n + f.bytes, 0) / 1024 });
}
// Only real stops count: the screen then held still at least 1.5 s (a pause in the middle of a scroll isn't one, and
// hosts before 0.4.10 can't be told apart from it otherwise). The first stop (the stream starting) is left out too.
const counted = stops.slice(1).filter(x => x.j + 1 >= frames.length || (frames[x.j + 1].captureUs - frames[x.stopIndex].captureUs) / 1000 >= 1500);
const cfg = configs.at(-1) || {};
// --source: what the viewer showed after each stop, scored against what the screen showed (the test pattern's own
// drawing): PSNR of the page of text in dB (higher is closer; under ~32 looks smudged, 40+ sharp). The clock starts
// when the host took the last new picture, so a frame still on its way counts as the old picture still showing.
let psnr = null;
if (sourceDir && counted.length && cfg.width && offsetUs != null) {
  const W = cfg.width, H = cfg.height, size = W * H;
  const sources = readdirSync(sourceDir).filter(f => /^still-\d+\.png$/.test(f)).map(f => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', `${sourceDir}/${f}`, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
    return r.stdout;
  }).filter(b => b && b.length === size);
  // Every frame from just before each stop to its last sharpening pass, decoded in one go (arrival order).
  const span = x => { const a = []; for (let n = Math.max(0, x.stopIndex - 3); n <= x.j; n++) a.push(n); return a; };
  const wanted = [...new Set(counted.flatMap(span))].sort((a, b) => a - b);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', outFile, '-vf', `select='${wanted.map(n => `eq(n\\,${n})`).join('+')}',scale=${W}:${H},format=gray`,
    '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 2 ** 32 });
  const decoded = new Map(wanted.map((n, i) => [n, r.stdout?.subarray(i * size, (i + 1) * size)]));
  // The page of text: the left 70% of the screen (the photo and the frame counter are to its right).
  const X1 = Math.floor(W * 0.7);
  const fit = (d, s, step) => { // least squares s ≈ a·d + b (the two pictures' levels can differ: video vs full range)
    let n = 0, sd = 0, ss = 0, sdd = 0, sds = 0;
    for (let y = 0; y < H; y += step) for (let x = 0; x < X1; x += step) { const i = y * W + x, a = d[i], b = s[i]; n++; sd += a; ss += b; sdd += a * a; sds += a * b; }
    const a = (n * sds - sd * ss) / Math.max(1, n * sdd - sd * sd), b = (ss - a * sd) / n;
    return { a, b };
  };
  const mse = (d, s, { a, b }, step) => {
    let n = 0, e = 0;
    for (let y = 0; y < H; y += step) for (let x = 0; x < X1; x += step) { const i = y * W + x, v = a * d[i] + b - s[i]; e += v * v; n++; }
    return e / n;
  };
  const MOMENTS = [250, 500, 1000, 2000];
  const scores = [];
  for (const x of counted) {
    const fin = decoded.get(x.j);
    if (!fin || fin.length !== size || !sources.length) continue;
    // Which still picture this stop showed: the one its final picture is closest to.
    let best = null;
    for (const s of sources) { const f = fit(fin, s, 4), e = mse(fin, s, f, 4); if (!best || e < best.e) best = { s, f, e }; }
    const cache = new Map();
    const db = n => {
      if (!cache.has(n)) { const d = decoded.get(n); cache.set(n, d && d.length === size ? 10 * Math.log10(255 * 255 / Math.max(1e-6, mse(d, best.s, best.f, 1))) : NaN); }
      return cache.get(n);
    };
    const t0 = (frames[x.stopIndex].captureUs - offsetUs) / 1000; // the screen stopped (on our clock)
    const shownAt = ms => { let k = -1; for (const n of span(x)) if (frames[n].at <= t0 + ms) k = n; return k; };
    const sc = { stop: db(x.stopIndex), final: db(x.j) };
    for (const ms of MOMENTS) { const k = shownAt(ms); sc[`at${ms}`] = k < 0 ? NaN : db(k); }
    // How long until what's shown came within 1 dB of how sharp it ended up, and until it reached 40 dB.
    const when = ok => { for (let n = x.stopIndex; n <= x.j; n++) if (ok(db(n))) return Math.max(0, frames[n].at - t0); return NaN; };
    sc.goodMs = when(v => v >= sc.final - 1);
    sc.sharpMs = when(v => v >= 40);
    scores.push(sc);
  }
  if (scores.length) {
    const m = key => +avg(scores.map(s => s[key]).filter(Number.isFinite)).toFixed(1);
    psnr = { stop: m('stop'), at250: m('at250'), at500: m('at500'), at1000: m('at1000'), at2000: m('at2000'), final: m('final'),
      goodMs: Math.round(m('goodMs')), sharpMs: Math.round(m('sharpMs')), sharpStops: `${scores.filter(s => Number.isFinite(s.sharpMs)).length}/${scores.length}`,
      worstAt500: +Math.min(...scores.map(s => Number.isFinite(s.at500) ? s.at500 : 0)).toFixed(1) };
  }
}
const mean = k => +avg(counted.map(x => x[k]).filter(Number.isFinite)).toFixed(1);
const afterStop = counted.length ? { stops: counted.length, settleMs: Math.round(mean('settleMs')), passes: mean('passes'), sharpenKB: Math.round(mean('kb')), psnr } : null;
if (dumpDir && counted.length) {
  // One stop's pictures: as it stopped, 0.5 s later and at the end (decoded by ffmpeg, frame numbers in arrival order).
  const x = counted[Math.floor(counted.length / 2)];
  const at = ms => { let k = x.stopIndex; while (k < x.j && frames[k + 1].at <= frames[x.stopIndex].at + ms) k++; return k; };
  const picks = { stop: x.stopIndex, 'after500ms': at(500), final: x.j };
  for (const [name, n] of Object.entries(picks)) {
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', outFile, '-vf', `select=eq(n\\,${n})`, '-vsync', '0', '-frames:v', '1', `${dumpDir}/${name}.png`]);
  }
}
const steady = rows.slice(2);
const summary = {
  resolution: `${cfg.width}x${cfg.height} (screen ${cfg.sourceWidth}x${cfg.sourceHeight})`, encoder: cfg.encoder,
  fps: +(steady.reduce((n, r) => n + r.fps, 0) / steady.length).toFixed(1),
  kbps: Math.round(steady.reduce((n, r) => n + r.kbps, 0) / steady.length),
  targetKbps: Math.round(steady.reduce((n, r) => n + (r.target || 0), 0) / steady.length),
  latencyP50: Math.round(pct(frames.slice(30).map(lat), 50)), latencyP95: Math.round(pct(frames.slice(30).map(lat), 95)),
  qp: { all: +qp.toFixed(1), key: +qpKey.toFixed(1), moving: +qpMoving.toFixed(1), still: +qpStill.toFixed(1) },
  kbOutKey: Math.round(avg(frames.filter(f => f.key).map(f => f.bytes)) / 1024), frames: frames.length, keyframes: frames.filter(f => f.key).length, pingMs: +bestRtt.toFixed(1),
  afterStop,
};
console.log('SUMMARY ' + JSON.stringify(summary));
const lowest = Math.min(...rows.slice(3).map(r => r.target).filter(Number.isFinite));
if (minTarget && !(lowest >= minTarget)) {
  console.log(`FAIL the host's bitrate target fell to ${lowest} kbps (under ${minTarget})`);
  process.exit(1);
}
