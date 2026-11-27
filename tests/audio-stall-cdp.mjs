// The real web client in headless Chromium, joined as a guest to a scratch Mac engine playing the test music
// (HEADROOM_TEST_AUDIO=music), with audio priority on: while the sound plays, the page's main thread is frozen for
// 300-500 ms at a time (a busy loop, as a sheet, layout or GC would), and the player's own numbers (the test hook
// globalThis.__headroomAudioTest) must show no dropout, nothing concealed, and every received frame played bit for bit
// (the worklet's rx / consumed / played hashes agree once the stream is stopped and the buffer has drained).
//
//   node tests/audio-stall-cdp.mjs [--quality=lossless|compressed] [--socket-worker=on|off|auto] [--stalls=300,400,500,500]
//        [--chrome=<chrome-headless-shell>] [--engine=host-macos/.build/release/headroom] [--acct=18783] [--https=17644]
//        [--http=17281] [--dir=<scratch dir>] [--expect=pass|dropouts]
//
// --socket-worker=off keeps the socket on the main thread (as WebKit does): there the same stalls are expected to cost
// dropouts (--expect=dropouts), which shows the check can see them. Nothing leaves 127.0.0.1.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';

const root = resolve(new URL('..', import.meta.url).pathname);
const arg = (name, def) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const ports = { acct: +arg('acct', 18783), https: +arg('https', 17644), http: +arg('http', 17281) };
const chromePath = arg('chrome', join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell'));
const enginePath = resolve(root, arg('engine', 'host-macos/.build/release/headroom'));
const quality = arg('quality', 'lossless');
const socketWorker = arg('socket-worker', 'auto');
const stalls = arg('stalls', '300,400,500,500').split(',').map(Number);
const expect = arg('expect', socketWorker === 'off' ? 'dropouts' : 'pass');
const acct = `http://127.0.0.1:${ports.acct}`, admin = `http://127.0.0.1:${ports.http}/api/admin`;

const procs = [];
let dir, ws;

function start(name, cmd, args, env) {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', d => { p.log += d; }); p.stderr.on('data', d => { p.log += d; });
  p.name = name;
  procs.push(p);
  return p;
}

async function until(read, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
    await sleep(100);
  }
}

const json = async (url, opts = {}) => (await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json' } })).json();

let cdpId = 0;
const pending = new Map();
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    pending.set(++cdpId, { resolve, reject, method });
    ws.send(JSON.stringify({ id: cdpId, method, params }));
  });
}
async function evaluate(expression, userGesture = false) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
  if (r.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
const audioState = () => evaluate('globalThis.__headroomAudioState || null');

async function joinAsGuest(name) {
  const made = await json(`${admin}/support/code`, { method: 'POST' });
  assert.match(made.code || '', /^\d{9}$/, 'a guest code: ' + JSON.stringify(made));
  await call('Page.navigate', { url: `${acct}/#code=${made.code}` });
  await until(() => evaluate(`!!document.querySelector('form.code-dialog input[name=name]')`), 'the code dialog');
  await evaluate(`(() => { const n = document.querySelector('form.code-dialog input[name=name]'); n.value = ${JSON.stringify(name)};
    n.closest('form').querySelector('button[type=submit]').click(); return true; })()`);
  const request = await until(async () => (await json(`${admin}/status`)).support?.requests?.find(r => r.name === name), 'the request to connect');
  await json(`${admin}/support/requests/${request.id}`, { method: 'POST', body: JSON.stringify({ accept: true, viewOnly: false, files: false, clipboard: false }) });
  await until(() => evaluate(`!!(window.__headroomSession?.viewport?.encW && __headroomSession.conn.isOpen)`), 'the session to stream', 20000);
}

const pick = s => s && {
  decoding: s.decoding, playing: s.playing, codec: s.codec, bufferedMs: s.bufferedMs, targetMs: s.targetMs, underruns: s.underruns,
  concealedMs: s.concealedMs, droppedMs: s.droppedMs, insertedMs: s.insertedMs, skippedMs: s.skippedMs, resampledMs: s.resampledMs,
  packets: s.packets, hashes: s.hashes,
};

let failed = false;
try {
  assert.ok(existsSync(chromePath), 'Chromium (chrome-headless-shell) at ' + chromePath);
  assert.ok(existsSync(enginePath), 'the engine at ' + enginePath);
  dir = arg('dir') || await mkdtemp(join(tmpdir(), 'headroom-stall-'));
  await mkdir(join(dir, 'host'), { recursive: true });
  await mkdir(join(dir, 'accounts'), { recursive: true });
  await writeFile(join(dir, 'host', 'config.json'), JSON.stringify({ server: acct, port: ports.https, httpHelperPort: ports.http }));
  start('account server', process.execPath, ['account-server/server.mjs'], { PORT: String(ports.acct), BIND: '127.0.0.1', DATA_DIR: join(dir, 'accounts'), DEV_MAIL: '1', BREACH_CHECK: 'off' });
  await until(() => fetch(`${acct}/`).then(r => r.ok), 'the account server');
  start('engine', enginePath, ['run', `--data=${join(dir, 'host')}`, '--webroot=web', '--loopback', '--test-pattern=1280x720'],
    { HEADROOM_TEST_AUDIO: 'music', HEADROOM_TEST_INPUT: join(dir, 'input.jsonl') });
  await until(async () => (await json(`${admin}/status`)).relay?.state === 'online', 'the engine on its relay', 30000);

  const profile = join(dir, 'chrome');
  // (--mute-audio: nothing comes out of this Mac's speakers; the worklet plays and hashes all the same.)
  start('chromium', chromePath, ['--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank']);
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'Chromium');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await once(ws, 'open');
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.exceptionThrown') console.log('   page exception:', msg.params.exceptionDetails?.exception?.description?.split('\n')[0]);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
  });
  await call('Runtime.enable');
  await call('Page.enable');
  const force = socketWorker === 'auto' ? '' : `globalThis.__headroomSocketWorker = ${socketWorker === 'on'};`;
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__headroomAudioTest = true; ${force}` });

  await joinAsGuest('audio-stall');
  const offMain = await evaluate('__headroomSession.conn.offMain');
  console.log(`joined: socket ${offMain ? 'in a worker' : 'on the main thread'}; ${quality}, audio priority on`);
  await evaluate(`__headroomSession.setPref('audioPriority', true), __headroomSession.setPref('audioQuality', ${JSON.stringify(quality)}), true`);
  await evaluate('__headroomSession.setAudio(true), true', true);
  const want = quality === 'lossless' ? 'pcm' : 'opus';
  await until(async () => { const s = await audioState(); return s?.playing && s.codec === want && s.packets > 300; }, `${want} playing`, 20000);
  // The playout's start-up seconds (a keyframe flooding the link at the start is forgiven): let them pass.
  await sleep(6000);
  const before = pick(await audioState());
  console.log('before the stalls:', JSON.stringify({ ...before, hashes: undefined }));

  const measured = [];
  for (const ms of stalls) {
    // The whole page is busy: no events, no timers, no socket messages on this thread for `ms`.
    const took = await evaluate(`(() => { const t0 = performance.now(); while (performance.now() - t0 < ${ms}) { } return Math.round(performance.now() - t0); })()`);
    measured.push(took);
    await sleep(2500);
  }
  const after = pick(await audioState());
  console.log(`main thread stalled ${measured.join(', ')} ms`);
  console.log('after the stalls: ', JSON.stringify({ ...after, hashes: undefined }));

  // Everything that has left the buffer so far, through every stall, played bit for bit: the worklet hashes each
  // frame as it leaves the buffer (consumed) and as it plays (played), in the same render quantum.
  const ha = after.hashes;
  const playedExactly = ha.consumed === ha.played && ha.consumedFrames === ha.playedFrames;
  // Then stop the stream (the player keeps playing what it holds) and let the buffer drain: everything received must
  // have left it (nothing dropped, skipped or lost inside sound). Stopping mid-music, the playout closes with its 4 ms
  // fade (192 frames, at most one underrun): the end of the stream, not part of the check.
  await evaluate(`__headroomSession.conn.sendJson({ t: 'audio', enabled: false }), true`);
  await until(async () => (await audioState())?.bufferedMs === 0, 'the buffer to drain', 10000);
  await sleep(1200);
  const end = pick(await audioState());
  const h = end.hashes;
  const allPlayed = h.rx === h.consumed && h.rxFrames === h.consumedFrames;
  console.log('drained:           ', JSON.stringify({ ...h, underruns: end.underruns }));

  const dropouts = after.underruns - before.underruns, concealed = after.concealedMs - before.concealedMs;
  const report = {
    socket: offMain ? 'worker' : 'main', decoding: after.decoding, quality, stalls: measured, dropoutsDuringStalls: dropouts,
    concealedMsDuringStalls: concealed, insideSound: { droppedMs: after.droppedMs, insertedMs: after.insertedMs, skippedMs: after.skippedMs },
    playedBitExactly: playedExactly, everyReceivedFramePlayed: allPlayed, framesReceived: h.rxFrames,
    closingFadeFrames: h.playedFrames - h.consumedFrames, closingUnderruns: end.underruns - after.underruns,
  };
  console.log(JSON.stringify(report));
  if (expect === 'pass') {
    assert.equal(dropouts, 0, 'no dropout during the stalls');
    assert.equal(concealed, 0, 'nothing concealed during the stalls');
    assert.ok(playedExactly, 'everything that left the buffer played bit for bit');
    assert.ok(allPlayed, 'every received frame left the buffer');
    assert.ok(report.closingFadeFrames <= 192 && report.closingUnderruns <= 1, 'only the closing fade after the stream stopped');
    assert.equal(after.decoding, 'socket-worker', 'the sound went from the socket\'s worker to the worklet');
    console.log('  ok   audio plays bit-exactly through main-thread stalls of', measured.join(', '), 'ms');
  } else {
    assert.ok(dropouts > 0 || concealed > 0, 'stalls on the main thread cost a dropout when the socket is there');
    console.log('  ok   with the socket on the main thread the same stalls cost', dropouts, 'dropout(s),', concealed, 'ms concealed');
  }
} catch (e) {
  failed = true;
  console.log('  FAIL', e.message);
  for (const p of procs) if (p.name !== 'chromium') console.log(`--- ${p.name} (last lines)\n${p.log.split('\n').slice(-15).join('\n')}`);
} finally {
  try { ws?.close(); } catch { }
  for (const p of procs.reverse()) { p.kill('SIGTERM'); }
  await sleep(500);
  if (!arg('dir') && dir) await rm(dir, { recursive: true, force: true }).catch(() => { });
}
process.exit(failed ? 1 : 0);
