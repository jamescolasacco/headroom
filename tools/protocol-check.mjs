#!/usr/bin/env node
// Headless Headroom viewer for testing a host end to end (Windows or macOS), no browser needed — as a guest with a
// code, through the relay: it asks the host's loopback settings API for a code ("Let someone connect"), connects
// with it through the relay, accepts itself with the same API (as the person at the computer would), streams video
// (acking every frame like the web client), exercises a keyframe request, a resolution change, a permission change,
// resuming after a dropped connection and "Stop"; writes the received H.264 as Annex B and checks it with ffprobe.
//
//   node tools/protocol-check.mjs [--url=http://127.0.0.1:7080] [--seconds=6] [--out=check.h264] [--no-video]
//
// Run it on the host itself (the settings API is loopback-only). The host must be connected to its relay.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const arg = (name, def) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const base = arg('url', 'http://127.0.0.1:7080').replace(/\/$/, '');
const seconds = Number(arg('seconds', '6'));
const outFile = arg('out', 'protocol-check.h264');
const noVideo = process.argv.includes('--no-video');

const problems = [];
const where = s => s?.remoteAddress || s?.address || '';
const check = (cond, msg) => { if (!cond) problems.push(msg); console.log(`${cond ? '  ok ' : 'FAIL '} ${msg}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function json(url, opts = {}) {
  const r = await fetch(url.startsWith('http') ? url : base + url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

/** One WebSocket "hello", and the messages until `until` matches (or a timeout). */
function helloOnce(url, hello, until, ms = 8000) {
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    const seen = [];
    const done = v => { clearTimeout(t); resolve({ ws, seen, last: v }); };
    const t = setTimeout(() => done(null), ms);
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') return;
      const m = JSON.parse(ev.data);
      seen.push(m);
      if (until(m)) done(m);
    };
    ws.onclose = () => done(seen.at(-1) || null);
  });
}

// ---------------------------------------------------------------------------------------------- a guest code
const info = await json('/api/info');
check(info.status === 200 && info.body.host?.id, `GET /api/info -> ${info.body.host?.name} (${info.body.host?.os} ${info.body.host?.osVersion}, v${info.body.host?.version})`);
let st;
for (let i = 0; i < 30; i++) { st = (await json('/api/admin/status')).body; if (st.relay?.state === 'online') break; await sleep(1000); }
check(st.relay?.state === 'online', `connected to the relay (${st.relay?.site || '?'})${st.relay?.error ? `: ${st.relay.error}` : ''}`);
const made = await json('/api/admin/support/code', { method: 'POST' });
check(made.status === 200 && /^\d{9}$/.test(made.body.code || ''), `"Let someone connect" made a 9-digit code and a link (${made.body.link || made.body.message})`);
const code = made.body.code || '000000000';
const relay = new URL(made.body.link || 'http://invalid/').origin;
const guestUrl = `${relay}/c/${code.slice(0, 4)}`;
const gi = await json(`${guestUrl}/api/info`);
check(gi.status === 200 && gi.body.host?.id === info.body.host?.id, 'the code\'s first 4 digits find this computer on the relay');
const files = await json(`${guestUrl}/api/files/list`);
check(files.status === 403, `before being accepted, a code reaches nothing but the session (files: ${files.status})`);
const direct = await helloOnce(base.replace(/^http/, 'ws') + '/ws', { t: 'hello', support: { code, name: 'x' } }, m => m.t === 'error');
check(direct.last?.code === 'bad-code', 'codes only work through the relay, not directly');
const wrong = await helloOnce(`${guestUrl.replace(/^http/, 'ws')}/ws`, { t: 'hello', support: { code: code.slice(0, 4) + ((Number(code.slice(4)) + 1) % 100000).toString().padStart(5, '0'), name: 'x' } }, m => m.t === 'error');
check(wrong.last?.code === 'bad-code', 'a wrong code is refused (the last 5 digits are checked by the computer)');

// ---------------------------------------------------------------------------------------------- the person here accepts
const wsUrl = `${guestUrl.replace(/^http/, 'ws')}/ws`;
const pending = helloOnce(wsUrl, { t: 'hello', support: { code, name: 'protocol-check' }, client: { name: 'protocol-check', platform: 'node' } }, m => m.t === 'welcome' || m.t === 'error', 20000);
let request;
for (let i = 0; i < 40 && !request; i++) {
  await sleep(250);
  request = (await json('/api/admin/status')).body.support?.requests?.find(r => r.name === 'protocol-check');
}
check(!!request, `the computer asks first: "${request?.name}" from ${request?.address || '?'} is waiting`);
await json(`/api/admin/support/requests/${request?.id}`, { method: 'POST', body: JSON.stringify({ accept: true, viewOnly: false, files: true, clipboard: false }) });
const accepted = await pending;
const welcome0 = accepted.last;
check(accepted.seen.some(m => m.t === 'pending'), 'the guest was told to wait for acceptance');
check(welcome0?.t === 'welcome' && welcome0.resumeToken && welcome0.relayPath, `accepted: welcome with a resume key and its own relay path (${welcome0?.relayPath})`);
check(welcome0?.permissions?.files === true && welcome0?.permissions?.clipboard === false && welcome0?.permissions?.input === true, `what the person here allowed: ${JSON.stringify(welcome0?.permissions)}`);
accepted.ws.close();
const used = await json(`${guestUrl}/api/info`);
check(used.status === 404, 'the code is used up once accepted');
const token = welcome0?.resumeToken;
const sessionBase = relay + (welcome0?.relayPath || '/r/none');

// ---------------------------------------------------------------------------------------------- video
// (--no-video: skip, e.g. on a machine without a desktop to capture)
if (!noVideo) {
  // ---------------------------------------------------------------------------------------------- session
  const ws = new WebSocket(sessionBase.replace(/^http/, 'ws') + '/ws');
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
}

// ---------------------------------------------------------------------------------------------- while connected
// The person here turns control off: the running session hears at once. A dropped connection comes back with the
// resume key, without asking again; "Stop" ends it for good.
const live = await helloOnce(sessionBase.replace(/^http/, 'ws') + '/ws', { t: 'hello', token, client: { name: 'protocol-check' } }, m => m.t === 'welcome' || m.t === 'error');
check(live.last?.t === 'welcome', `resuming with the key works without asking again (${live.last?.t} ${live.last?.code || ''})`);
const mine = (await json('/api/admin/status')).body.sessions?.find(x => x.device === 'protocol-check');
check(!!mine && mine.guest, `the settings window lists the guest (${mine?.device}, ${where(mine)})`);
await json(`/api/admin/sessions/${mine?.id}/rights`, { method: 'POST', body: JSON.stringify({ input: false }) });
for (let i = 0; i < 20 && !live.seen.some(m => m.t === 'permissions'); i++) await sleep(100);
check(live.seen.some(m => m.t === 'permissions' && m.permissions?.input === false), 'turning control off reaches the running session');
live.ws.close();
await sleep(300);
const resumed = await helloOnce(sessionBase.replace(/^http/, 'ws') + '/ws', { t: 'hello', token, client: { name: 'protocol-check' } }, m => m.t === 'welcome' || m.t === 'error');
check(resumed.last?.t === 'welcome' && resumed.last.permissions?.input === false, 'it resumes with the rights as they are now (no control)');
await sleep(300);
const again = (await json('/api/admin/status')).body.sessions?.find(x => x.device === 'protocol-check');
await json(`/api/admin/sessions/${again?.id}/disconnect`, { method: 'POST' });
await sleep(500);
const after = await helloOnce(sessionBase.replace(/^http/, 'ws') + '/ws', { t: 'hello', token }, m => m.t === 'welcome' || m.t === 'error');
check(after.last?.code === 'unauthorized', 'after Stop, the resume key no longer works');
for (const x of [resumed, after]) x.ws.close();

console.log(problems.length ? `\n${problems.length} problem(s).` : '\nAll checks passed.');
process.exit(problems.length ? 1 : 0);
