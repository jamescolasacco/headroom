#!/usr/bin/env node
// Headless Headroom viewer for testing a host end to end (any host: Windows or macOS), no browser needed.
// It pairs with a one-time code from the host's loopback admin API, opens the session WebSocket, streams
// video (acking every frame like the web client), exercises a keyframe request and a resolution change,
// writes the received H.264 as Annex B and checks it with ffprobe, then revokes its own pairing.
//
//   node tools/protocol-check.mjs [--url=http://127.0.0.1:7080] [--seconds=6] [--out=check.h264] [--keep]
//
// Run it on the host itself (the admin API is loopback-only). Over https, trust the host CA with
// NODE_EXTRA_CA_CERTS=<data>/certs/ca.crt.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const arg = (name, def) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const base = arg('url', 'http://127.0.0.1:7080').replace(/\/$/, '');
const seconds = Number(arg('seconds', '6'));
const outFile = arg('out', 'protocol-check.h264');
const keep = process.argv.includes('--keep');

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); console.log(`${cond ? '  ok ' : 'FAIL '} ${msg}`); };

async function json(path, opts = {}) {
  const r = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

// ---------------------------------------------------------------------------------------------- pairing
const info = await json('/api/info');
check(info.status === 200 && info.body.host?.id, `GET /api/info -> ${info.body.host?.name} (${info.body.host?.os} ${info.body.host?.osVersion}, v${info.body.host?.version})`);
const bad = await json('/api/pair', { method: 'POST', body: JSON.stringify({ code: 'WRONGCODE1', deviceName: 'x' }) });
check(bad.status === 401 && bad.body.error === 'bad-credentials', `bad pairing code rejected (${bad.status} ${bad.body.error})`);
const pc = await json('/api/admin/paircode', { method: 'POST' });
check(pc.status === 200 && /^[A-Z0-9]{10}$/.test(pc.body.code), 'admin: one-time pairing code issued');
const paired = await json('/api/pair', { method: 'POST', body: JSON.stringify({ code: pc.body.code, deviceName: 'protocol-check' }) });
check(paired.status === 200 && paired.body.token, 'POST /api/pair with the code returns a device token');
const reuse = await json('/api/pair', { method: 'POST', body: JSON.stringify({ code: pc.body.code, deviceName: 'again' }) });
check(reuse.status === 401, 'pairing codes are single-use');
const token = paired.body.token;
const me = await json('/api/me', { headers: { Authorization: `Bearer ${token}` } });
check(me.status === 200 && me.body.device?.name === 'protocol-check', 'GET /api/me accepts the bearer token');

// ---------------------------------------------------------------------------------------------- session
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const ws = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer';
const t0 = performance.now();
let welcome = null, configs = [], frames = [], keyFrames = 0, acked = 0, cursorPos = 0, cursorShapes = 0, statsMsgs = [], pongs = [], statuses = [];
let assembly = null;
const out = [];
let sps = null, pps = null;

function parseAvcC(b64) {
  const d = Buffer.from(b64, 'base64');
  const spsLen = d.readUInt16BE(6);
  const s = d.subarray(8, 8 + spsLen);
  const p0 = 8 + spsLen + 1;
  const ppsLen = d.readUInt16BE(p0);
  return { sps: s, pps: d.subarray(p0 + 2, p0 + 2 + ppsLen), profile: d[1], level: d[3] };
}

ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token, client: { name: 'protocol-check', platform: 'node', ua: `node ${process.version}` } }));
ws.onmessage = ev => {
  if (typeof ev.data === 'string') {
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'welcome':
        welcome = m;
        ws.send(JSON.stringify({ t: 'start', monitor: m.monitors[0]?.id, maxFps: 60, maxWidth: 0, maxHeight: 0, audio: false }));
        break;
      case 'video-config': {
        configs.push(m);
        const c = parseAvcC(m.description);
        sps = c.sps; pps = c.pps;
        break;
      }
      case 'pong': pongs.push(performance.now() - m.ts); break;
      case 'stats': statsMsgs.push(m); break;
      case 'status': statuses.push(m.capture + (m.detail ? ` (${m.detail})` : '')); break;
      case 'error': console.log('host error:', m); break;
    }
    return;
  }
  const v = new DataView(ev.data);
  const type = v.getUint8(0);
  if (type === 0x02) { cursorPos++; return; }
  if (type === 0x05) { cursorShapes++; return; }
  if (type !== 0x01) return;
  const flags = v.getUint8(1), epoch = v.getUint16(2, true), frameId = v.getUint32(4, true), total = v.getInt32(8, true), offset = v.getInt32(12, true);
  const payload = new Uint8Array(ev.data, 28);
  if (flags & 2) assembly = { frameId, epoch, buf: new Uint8Array(total), key: !!(flags & 1), got: 0 };
  if (!assembly || assembly.frameId !== frameId) return;
  assembly.buf.set(payload, offset);
  assembly.got += payload.length;
  if (flags & 4) {
    const ack = new ArrayBuffer(5); const av = new DataView(ack);
    av.setUint8(0, 0x15); av.setUint32(1, frameId, true);
    ws.send(ack); acked++;
    const a = assembly; assembly = null;
    frames.push({ id: a.frameId, epoch: a.epoch, key: a.key, size: a.buf.length, complete: a.got === a.buf.length });
    if (a.key) { keyFrames++; out.push(Buffer.from([0, 0, 0, 1]), sps, Buffer.from([0, 0, 0, 1]), pps); }
    for (let i = 0; i + 4 <= a.buf.length;) {
      const n = (a.buf[i] << 24 | a.buf[i + 1] << 16 | a.buf[i + 2] << 8 | a.buf[i + 3]) >>> 0;
      i += 4;
      out.push(Buffer.from([0, 0, 0, 1]), Buffer.from(a.buf.subarray(i, i + n)));
      i += n;
    }
  }
};
ws.onerror = e => console.log('websocket error:', e.message || e.type);
const closed = new Promise(r => { ws.onclose = e => { if (e.code !== 1000 && e.code !== 1005) console.log(`websocket closed: ${e.code} ${e.reason}`); r(); }; });
const pinger = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'ping', id: Math.random(), ts: performance.now() })), 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

await sleep(seconds * 500);
const before = frames.length;
ws.send(JSON.stringify({ t: 'keyframe' }));
await sleep(600);
const keyAfterRequest = frames.slice(before).some(f => f.key);
// Resolution change -> new epoch, new config, IDR first.
const epochBefore = configs.at(-1)?.epoch;
ws.send(JSON.stringify({ t: 'start', monitor: welcome?.monitors[0]?.id, maxFps: 30, maxWidth: 640, maxHeight: 640, audio: false }));
await sleep(seconds * 500);
clearInterval(pinger);
ws.close(1000, 'bye');
await Promise.race([closed, sleep(2000)]);
const elapsed = (performance.now() - t0) / 1000;

// ---------------------------------------------------------------------------------------------- report
check(!!welcome, `welcome: ${welcome?.monitors?.length} monitor(s), permissions ${JSON.stringify(welcome?.permissions)}`);
check(configs.length >= 1, `video-config received: ${configs.map(c => `${c.codec} ${c.width}x${c.height} epoch ${c.epoch} (${c.encoder}${c.hardware ? ', hw' : ''})`).join(' | ')}`);
check(frames.length > 0 && frames[0].key, `first frame is a keyframe; ${frames.length} frames (${keyFrames} key) in ${elapsed.toFixed(1)} s`);
check(frames.every(f => f.complete), 'every frame fully reassembled from fragments');
check(acked === frames.length, `acked every frame (${acked})`);
check(keyAfterRequest, 'a keyframe follows {"t":"keyframe"}');
const newCfg = configs.find(c => c.epoch !== epochBefore && c.width <= 640 && c.height <= 640);
check(!!newCfg, `resolution change starts a new epoch (${newCfg ? `${newCfg.width}x${newCfg.height}, epoch ${newCfg.epoch}` : 'none'})`);
const firstOfNewEpoch = newCfg && frames.find(f => f.epoch === newCfg.epoch);
check(!newCfg || firstOfNewEpoch?.key, 'first frame of the new epoch is an IDR');
check(pongs.length >= Math.floor(seconds) - 1, `pongs: ${pongs.length}, median RTT ${(pongs.sort((a, b) => a - b)[pongs.length >> 1] || 0).toFixed(1)} ms`);
check(statsMsgs.length >= 2, `stats messages: ${statsMsgs.length} (last: ${JSON.stringify(statsMsgs.at(-1))})`);
console.log(`       cursor: ${cursorPos} position, ${cursorShapes} shape messages; capture status: ${statuses.join(' -> ') || '(none)'}`);

writeFileSync(outFile, Buffer.concat(out));
try {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-count_frames', '-of', 'json', outFile], { encoding: 'utf8' }));
  const s = probe.streams[0];
  check(s.codec_name === 'h264', `ffprobe: ${s.codec_name} ${s.profile} level ${s.level}, ${s.width}x${s.height}, ${s.nb_read_frames} frames decoded`);
  check(s.has_b_frames === 0, `no reordering declared (has_b_frames=${s.has_b_frames})`);
  check(Number(s.nb_read_frames) === frames.length, `every received frame decodes (${s.nb_read_frames}/${frames.length})`);
  const errs = execFileSync('ffmpeg', ['-v', 'error', '-i', outFile, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  check(!errs.trim(), 'ffmpeg decodes the whole stream without errors');
  const trace = execFileSync('ffmpeg', ['-v', 'error', '-i', outFile, '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  void trace;
} catch (e) {
  console.log(`(ffprobe check skipped: ${e.message.split('\n')[0]})`);
}

if (!keep) {
  const st = await json('/api/admin/status');
  const dev = st.body.devices?.find(d => d.name === 'protocol-check' && d.id === paired.body.device.id);
  if (dev) await fetch(`${base}/api/admin/devices/${dev.id}`, { method: 'DELETE' });
}
console.log(problems.length ? `\n${problems.length} problem(s).` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
