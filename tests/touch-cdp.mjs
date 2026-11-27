// The real web client on an emulated phone (headless Chromium, touch events over CDP) joined as a guest to a scratch
// Mac engine whose input goes to the test-input recorder (HEADROOM_TEST_INPUT): every gesture is checked by what
// the engine would have posted to the app in front (click counts, buttons held, drags, scrolling, where), also when
// interrupted (focus lost, page hidden, touch cancelled, control turned off, the connection dropped, the phone turned).
//
//   node tests/touch-cdp.mjs [--chrome=<chrome-headless-shell>] [--engine=host-macos/.build/release/headroom]
//        [--acct=18782] [--https=17643] [--http=17280] [--dir=<scratch dir>] [--only=<scenario substring>|<another>]
//
// It starts its own account server (relay, which also serves web/) and engine on those ports and stops them at the end.
// Nothing leaves 127.0.0.1: the browser resolves no other host names, and every request it makes is checked.
// The engine runs the synthetic display (--test-pattern) and posts nothing to this Mac.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';

const root = resolve(new URL('..', import.meta.url).pathname);
const arg = (name, def) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const ports = { acct: +arg('acct', 18782), https: +arg('https', 17643), http: +arg('http', 17280) };
const chromePath = arg('chrome', join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell'));
const enginePath = resolve(root, arg('engine', 'host-macos/.build/release/headroom'));
const only = arg('only', '');
const acct = `http://127.0.0.1:${ports.acct}`, admin = `http://127.0.0.1:${ports.http}/api/admin`;
// The test display is the main display's area, in points (the recorder's coordinates); the stream is 1280 × 720 of it.
const bounds = (arg('bounds') || execFileSync('osascript', ['-l', 'JavaScript', '-e',
  'ObjC.import("CoreGraphics"); const b = $.CGDisplayBounds($.CGMainDisplayID()); [b.origin.x, b.origin.y, b.size.width, b.size.height].join()'], { encoding: 'utf8' }))
  .trim().split(',').map(Number);
const toPoints = (nx, ny) => ({ x: bounds[0] + nx * bounds[2], y: bounds[1] + ny * bounds[3] });

const procs = [];
const results = [];
let dir, chrome, ws, inputLog;

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

const json = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json' } });
  return r.json();
};

// ------------------------------------------------------------------------------------------- CDP

let cdpId = 0;
const pending = new Map(), requests = [];
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    pending.set(++cdpId, { resolve, reject, method });
    ws.send(JSON.stringify({ id: cdpId, method, params }));
  });
}
async function evaluate(expression) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}

// Fingers. CDP: touchStart and touchMove list every finger down (new ones press, moved ones move); touchEnd lists
// the fingers that lift (none: all of them); touchCancel cancels them all.
const down = new Map();
const point = (id, [x, y]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 });
async function touch(type, changes = {}) {
  for (const [id, p] of Object.entries(changes)) down.set(+id, p);
  await call('Input.dispatchTouchEvent', { type, touchPoints: [...down].map(([id, p]) => point(id, p)) });
}
async function liftAll() { down.clear(); await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
const finger = {
  down: (id, x, y) => touch('touchStart', { [id]: [x, y] }),
  move: (id, x, y) => touch('touchMove', { [id]: [x, y] }),
  up: async id => { const p = down.get(id); down.delete(id); await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [point(id, p)] }); },
  cancel: () => { down.clear(); return call('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); },
};
async function tap(x, y, hold = 70, id = 1) { await finger.down(id, x, y); await sleep(hold); await finger.up(id); }
async function slide(x, y, dx, dy, { steps = 12, dt = 16, pause = 0, keep = false, id = 1 } = {}) {
  await finger.down(id, x, y);
  if (pause) await sleep(pause);
  for (let i = 1; i <= steps; i++) { await sleep(dt); await finger.move(id, x + dx * i / steps, y + dy * i / steps); }
  if (!keep) await finger.up(id);
}
async function two(x, y, dx = 0, dy = 0, { steps = 10, dt = 16, keep = false, hold = 60, grow = 0 } = {}) {
  await touch('touchStart', { 1: [x - 40, y], 2: [x + 40, y] });
  if (!dx && !dy && !grow) { await sleep(hold); }
  for (let i = 1; i <= steps && (dx || dy || grow); i++) {
    await sleep(dt);
    const s = grow * i / steps / 2;
    await touch('touchMove', { 1: [x - 40 - s + dx * i / steps, y + dy * i / steps], 2: [x + 40 + s + dx * i / steps, y + dy * i / steps] });
  }
  if (!keep) await liftAll();
}

// ------------------------------------------------------------------------------------------- the recorder

let logOffset = 0;
async function events() {
  const text = await readFile(inputLog, 'utf8');
  const lines = text.slice(logOffset).split('\n').filter(Boolean).map(l => JSON.parse(l));
  return lines;
}
/** Waits until the engine has been quiet for a moment, then returns what it posted since the last mark. */
async function settle(ms = 250) {
  let last = -1, size = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(ms / 2);
    size = (await stat(inputLog)).size;
    if (size === last) break;
    last = size;
  }
  const ev = await events();
  const state = await json(`${admin}/test-input`);
  return { ev, state, mouse: ev.filter(e => e.kind === 'mouse'), presses: ev.filter(e => e.kind === 'mouse' && e.type === 'down').map(e => [e.button, e.clickState]) };
}
async function mark() {
  await settle(150);
  logOffset = (await stat(inputLog)).size;
  sent.length = 0;
  await evaluate('window.__sent.length = 0');
}

// Packets the page sent (decoded in the page): ['at', nx, ny], ['button', b, down], ['wheel', dx, dy]. On its own
// socket, or (Chromium: web/js/connection.js) handed to the socket's worker as {type: 'send', data}.
const sent = [];
const SEND_HOOK = `(() => {
  window.__sent = [];
  const note = data => {
    if (data instanceof ArrayBuffer && data.byteLength) {
      const v = new DataView(data), k = v.getUint8(0), t = performance.now();
      if (k === 0x10) window.__sent.push([t, 'at', v.getFloat32(1, true), v.getFloat32(5, true)]);
      else if (k === 0x12) window.__sent.push([t, 'button', v.getUint8(1), v.getUint8(2)]);
      else if (k === 0x13) window.__sent.push([t, 'wheel', v.getInt16(1, true), v.getInt16(3, true)]);
    }
  };
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) { note(data); return send.call(this, data); };
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, ...rest) { if (m && m.type === 'send') note(m.data); return post.call(this, m, ...rest); };
})();`;

// ------------------------------------------------------------------------------------------- scenarios

/** Where (in the test display's points) a point on the phone's screen is, by the picture's place on the page. */
async function remoteAt(x, y) {
  const r = await evaluate(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  return toPoints((x - r[0]) / r[2], (y - r[1]) / r[3]);
}
async function picture() {
  const r = await evaluate(`(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  return { ...r, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}
const setMode = mode => evaluate(`__headroomSession.setPref('inputMode', '${mode}'), __headroomSession.touch.mode`);
const near = (a, b, tol = 4) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

async function scenario(name, fn) {
  if (only && !only.split('|').some(o => name.includes(o))) return;
  await mark();
  try {
    await fn();
    results.push([name, 'ok']);
    console.log('  ok  ', name);
  } catch (e) {
    results.push([name, 'FAIL', e.message]);
    console.log('  FAIL', name, '\n       ', e.message.split('\n').join('\n        '));
  }
  // Whatever happened, no finger stays down and nothing stays pressed for the next one.
  if (down.size) await finger.cancel();
  await sleep(700);
}

async function heldNothing(what = '') {
  const { state } = await settle();
  assert.deepEqual(state.buttons, [], `${what} the engine still holds ${state.buttons}`);
}

async function joinAsGuest(name) {
  const made = await json(`${admin}/support/code`, { method: 'POST' });
  assert.match(made.code || '', /^\d{9}$/, 'a guest code: ' + JSON.stringify(made));
  await call('Page.navigate', { url: `${acct}/#code=${made.code}` });
  await until(() => evaluate(`!!document.querySelector('form.code-dialog input[name=name]')`), 'the code dialog');
  await evaluate(`(() => { const n = document.querySelector('form.code-dialog input[name=name]'); n.value = ${JSON.stringify(name)};
    n.closest('form').querySelector('button[type=submit]').click(); return true; })()`);
  const request = await until(async () => (await json(`${admin}/status`)).support?.requests?.find(r => r.name === name), 'the request to connect')
    .catch(async e => { throw new Error(`${e.message}; the page says: ${await evaluate(`document.querySelector('form.code-dialog')?.innerText || document.body.innerText.slice(0, 300)`)}`); });
  await json(`${admin}/support/requests/${request.id}`, { method: 'POST', body: JSON.stringify({ accept: true, viewOnly: false, files: false, clipboard: false }) });
  await until(() => evaluate(`!!(window.__headroomSession?.viewport?.encW && __headroomSession.permissions.input && __headroomSession.conn.isOpen)`), 'the session to stream', 20000);
  await sleep(500);
}

async function sessionId(name) {
  return (await json(`${admin}/status`)).sessions.find(s => s.device === name)?.id;
}

// ------------------------------------------------------------------------------------------- main

try {
  assert.ok(existsSync(chromePath), 'Chromium (chrome-headless-shell) at ' + chromePath);
  assert.ok(existsSync(enginePath), 'the engine at ' + enginePath);
  dir = arg('dir') || await mkdtemp(join(tmpdir(), 'headroom-touch-'));
  await mkdir(join(dir, 'host'), { recursive: true });
  await mkdir(join(dir, 'accounts'), { recursive: true });
  inputLog = join(dir, 'input.jsonl');
  await writeFile(join(dir, 'host', 'config.json'), JSON.stringify({ server: acct, port: ports.https, httpHelperPort: ports.http }));

  const acctProc = start('account server', process.execPath, ['account-server/server.mjs'], { PORT: String(ports.acct), BIND: '127.0.0.1', DATA_DIR: join(dir, 'accounts'), DEV_MAIL: '1', BREACH_CHECK: 'off' });
  await until(() => fetch(`${acct}/`).then(r => r.ok), 'the account server');
  const engine = start('engine', enginePath, ['run', `--data=${join(dir, 'host')}`, '--webroot=web', '--loopback', '--test-pattern=1280x720'],
    { HEADROOM_TEST_INPUT: inputLog });
  await until(async () => (await json(`${admin}/status`)).relay?.state === 'online', 'the engine on its relay', 30000);
  const st = await json(`${admin}/status`);
  assert.equal(st.testInput, inputLog, 'the engine records input instead of posting it');
  assert.equal(st.settings.server, acct, 'the engine uses the scratch account server');

  const profile = join(dir, 'chrome');
  chrome = start('chromium', chromePath, ['--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--autoplay-policy=user-gesture-required', 'about:blank']);
  const port = await until(async () => (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'Chromium');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await once(ws, 'open');
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
    if (msg.method === 'Network.webSocketCreated') requests.push(msg.params.url);
    if (msg.method === 'Runtime.exceptionThrown') console.log('   page exception:', msg.params.exceptionDetails?.exception?.description?.split('\n')[0]);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
  });
  await call('Network.enable');
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: SEND_HOOK });
  // A phone: Android Chrome (iOS WebKit can't be driven here), 390 × 844 in portrait, five touch points.
  await call('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l' });
  const portrait = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } };
  const landscape = { width: 844, height: 390, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } };
  await call('Emulation.setDeviceMetricsOverride', portrait);
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  await joinAsGuest('touch-cdp');
  console.log('joined:', JSON.stringify(await evaluate(`({ mode: __headroomSession.touch.mode, enc: [__headroomSession.viewport.encW, __headroomSession.viewport.encH], src: [__headroomSession.viewport.srcW, __headroomSession.viewport.srcH], scale: __headroomSession.viewport.scale })`)));
  let pic = await picture();

  // ------------------------------------------------------------------ trackpad mode
  await setMode('trackpad');

  await scenario('trackpad: tap, tap tap, tap tap tap click 1, 2, 3 at the pointer', async () => {
    for (const n of [1, 2, 3]) {
      await mark();
      for (let i = 0; i < n; i++) { if (i) await sleep(110); await tap(pic.cx + (i % 2 ? 3 : -3), pic.cy); }
      const { presses, state } = await settle(700);
      assert.deepEqual(presses, [['left', 1], ['left', 2], ['left', 3]].slice(0, n), `${n} taps`);
      assert.deepEqual(state.buttons, []);
      const shown = await evaluate(`__headroomSession.touch.cursor`), want = toPoints(shown.nx, shown.ny);
      const c = state.clicks.at(-1);
      assert.ok(near(c, want, 2), `clicked where the pointer is drawn: ${c.x},${c.y} vs ${want.x},${want.y}`);
      await sleep(600);
    }
  });

  await scenario('trackpad: tap(s), then touch and drag: a drag counting 1, 2, 3', async () => {
    for (const n of [1, 2, 3]) {
      await mark();
      for (let i = 0; i < n; i++) { if (i) await sleep(110); await tap(pic.cx, pic.cy); }
      await sleep(120);
      await slide(pic.cx, pic.cy, -60, 10);
      const { presses, mouse, state } = await settle(600);
      const drag = mouse.filter(e => e.type === 'down').at(-1);
      assert.equal(drag.clickState, n, `${n}: the drag's press counts ${n} (${JSON.stringify(presses)})`);
      assert.equal(presses.length, n === 1 ? 2 : n, JSON.stringify(presses));
      assert.ok(mouse.filter(e => e.type === 'dragged' && e.button === 'left').length >= 3, 'dragged with the left button down');
      assert.deepEqual(state.buttons, []);
      await sleep(600);
      await slide(pic.cx - 60, pic.cy + 10, 60, -10); // the pointer back, for the next one
      await sleep(600);
    }
  });

  await scenario('trackpad: hold then drag is a left drag; hold is a right-click; two-finger tap is a right-click', async () => {
    await slide(pic.cx, pic.cy, 50, 0, { pause: 520 });
    let r = await settle(500);
    assert.deepEqual(r.presses, [['left', 1]]);
    assert.ok(r.mouse.some(e => e.type === 'dragged'));
    await mark();
    await tap(pic.cx, pic.cy, 600);
    r = await settle(600);
    assert.deepEqual(r.presses, [['right', 1]]);
    await mark();
    await two(pic.cx, pic.cy);
    r = await settle(600);
    assert.deepEqual(r.presses, [['right', 1]]);
    assert.deepEqual(r.state.buttons, []);
  });

  await scenario('trackpad: two-finger tap, then two fingers drag: a right-click drag', async () => {
    await two(pic.cx, pic.cy);
    await sleep(120);
    await two(pic.cx, pic.cy, 50, 20);
    const r = await settle(500);
    assert.deepEqual(r.presses, [['right', 1], ['right', 1]]);
    assert.ok(r.mouse.filter(e => e.type === 'dragged' && e.button === 'right').length >= 3, 'moved with the right button down');
    assert.deepEqual(r.state.buttons, []);
  });

  await scenario('trackpad: two-finger scroll with momentum; a tap while it runs stops it and clicks', async () => {
    await two(pic.cx, pic.cy, 0, -120, { steps: 8 });
    await sleep(80);
    assert.ok(await evaluate('__headroomSession.touch.inertia'), 'momentum running when the tap lands');
    await tap(pic.cx, pic.cy);
    const r = await settle(800);
    assert.ok(r.state.scroll.dy < -200, `scrolled down (content follows the fingers up): ${r.state.scroll.dy}`);
    assert.deepEqual(r.presses, [['left', 1]], 'the tap that stopped it clicked too');
    assert.ok(!(await evaluate('__headroomSession.touch.inertia')), 'momentum stopped');
  });

  await scenario('three-finger tap opens and closes the keyboard; sends nothing', async () => {
    const tap3 = async () => {
      await touch('touchStart', { 1: [pic.cx - 60, pic.cy], 2: [pic.cx, pic.cy], 3: [pic.cx + 60, pic.cy] });
      await sleep(70);
      await liftAll();
      await sleep(400);
    };
    await tap3();
    assert.equal(await evaluate('__headroomSession.softkbd.open'), true, 'the keyboard opened');
    assert.equal(await evaluate(`document.activeElement === document.getElementById('kbd-sink')`), true, 'its field has focus');
    let r = await settle(300);
    assert.deepEqual(r.ev.filter(e => e.kind !== 'mouse' || e.type !== 'moved'), [], 'opening it sent nothing');
    // A tap on the picture while the keyboard is up clicks and keeps the keyboard up.
    await mark();
    await tap(pic.cx, pic.cy);
    r = await settle(600);
    assert.deepEqual(r.presses, [['left', 1]]);
    assert.equal(await evaluate('__headroomSession.softkbd.open'), true, 'still up after a tap on the picture');
    await mark();
    await tap3();
    assert.equal(await evaluate('__headroomSession.softkbd.open'), false, 'the keyboard closed');
    r = await settle(300);
    assert.deepEqual(r.ev.filter(e => e.kind !== 'mouse' || e.type !== 'moved'), [], 'closing it sent nothing');
  });

  await scenario('pinch zooms the picture (not the computer), and the view pans with three fingers', async () => {
    const zoom0 = await evaluate('__headroomSession.viewport.zoom');
    await two(pic.cx, pic.cy, 0, 0, { grow: 160, steps: 12 });
    await sleep(300);
    const zoom1 = await evaluate('__headroomSession.viewport.zoom');
    assert.ok(zoom1 > zoom0 * 1.5, `zoomed in: ${zoom0} -> ${zoom1}`);
    const r = await settle(300);
    assert.deepEqual(r.ev.filter(e => e.kind !== 'mouse' || e.type !== 'moved'), [], 'nothing reached the computer');
    const ox0 = await evaluate('__headroomSession.viewport.ox');
    await touch('touchStart', { 1: [pic.cx - 60, pic.cy], 2: [pic.cx, pic.cy], 3: [pic.cx + 60, pic.cy] });
    for (let i = 1; i <= 8; i++) { await sleep(16); await touch('touchMove', { 1: [pic.cx - 60 + 10 * i, pic.cy], 2: [pic.cx + 10 * i, pic.cy], 3: [pic.cx + 60 + 10 * i, pic.cy] }); }
    await liftAll();
    await sleep(200);
    const ox1 = await evaluate('__headroomSession.viewport.ox');
    assert.ok(ox1 > ox0 + 20, `panned right: ${ox0} -> ${ox1}`);
    await evaluate('__headroomSession.viewport.resetZoom()');
    await sleep(300);
    pic = await picture();
  });

  // ------------------------------------------------------------------ touch mode
  await setMode('touch');

  await scenario('touch mode: a tap clicks under the finger; tap tap double-clicks there; a drag drags from where it landed', async () => {
    const p = { x: pic.left + pic.width * 0.3, y: pic.top + pic.height * 0.4 };
    const want = await remoteAt(p.x, p.y);
    await tap(p.x, p.y);
    let r = await settle(600);
    assert.deepEqual(r.presses, [['left', 1]]);
    const c = r.state.clicks.at(-1);
    assert.ok(near(c, want), `clicked at ${c.x},${c.y}, the finger was at ${want.x},${want.y}`);
    await sleep(500);
    await mark();
    await tap(p.x, p.y); await sleep(110); await tap(p.x + 4, p.y - 3);
    r = await settle(700);
    assert.deepEqual(r.presses, [['left', 1], ['left', 2]]);
    // A drag within a second of that click would start a few points along (touch.js CLICK_APART_MS): settle() alone
    // can take 700 or 1050 ms, by when the double tap's held click is let go.
    await sleep(500);
    await mark();
    const to = { x: p.x + 70, y: p.y + 20 };
    await slide(p.x, p.y, to.x - p.x, to.y - p.y);
    r = await settle(500);
    const press = r.mouse.find(e => e.type === 'down'), release = r.mouse.find(e => e.type === 'up');
    assert.ok(near(press, want), `pressed at ${press.x},${press.y}`);
    assert.ok(near(release, await remoteAt(to.x, to.y)), `released at ${release.x},${release.y}`);
    assert.deepEqual(r.state.buttons, []);
  });

  await scenario('the phone turns: taps land under the finger in the new layout, and after turning back', async () => {
    for (const metrics of [landscape, portrait]) {
      await call('Emulation.setDeviceMetricsOverride', metrics);
      await sleep(900);
      pic = await picture();
      assert.ok(pic.width > 0 && pic.left >= -1 && pic.left + pic.width <= metrics.width + 1, 'the picture fits the new screen: ' + JSON.stringify(pic));
      await mark();
      const p = { x: pic.left + pic.width * 0.7, y: pic.top + pic.height * 0.6 };
      const want = await remoteAt(p.x, p.y);
      await tap(p.x, p.y);
      const r = await settle(600);
      assert.deepEqual(r.presses, [['left', 1]]);
      assert.ok(near(r.state.clicks.at(-1), want), `${metrics.screenOrientation.type}: clicked at ${r.state.clicks.at(-1).x},${r.state.clicks.at(-1).y}, the finger was at ${want.x},${want.y}`);
      await sleep(500);
    }
  });

  await scenario('the phone turns mid-drag: the button is let go or the drag follows the finger; nothing stays held', async () => {
    await finger.down(1, pic.cx, pic.cy);
    for (let i = 1; i <= 4; i++) { await sleep(16); await finger.move(1, pic.cx + 8 * i, pic.cy); }
    await call('Emulation.setDeviceMetricsOverride', landscape);
    await sleep(600);
    const p2 = await picture();
    await finger.move(1, p2.cx, p2.cy);
    await sleep(30);
    const want = await remoteAt(p2.cx, p2.cy);
    await finger.up(1);
    const r = await settle(600);
    assert.deepEqual(r.state.buttons, []);
    const release = r.mouse.filter(e => e.type === 'up').at(-1);
    assert.ok(release && near(release, want, 4), `let go under the finger: ${release?.x},${release?.y} vs ${want.x},${want.y}`);
    await call('Emulation.setDeviceMetricsOverride', portrait);
    await sleep(900);
    pic = await picture();
  });

  await scenario('with the keyboard up (less of the screen showing), taps land under the finger; closing it, too', async () => {
    const tap3 = async () => {
      // Near the top of what shows of the picture (the keys bar covers the bottom while the keyboard is up).
      const y = Math.max((await picture()).top, await evaluate(`document.getElementById('viewer').getBoundingClientRect().top`)) + 40;
      await touch('touchStart', { 1: [pic.cx - 60, y], 2: [pic.cx, y], 3: [pic.cx + 60, y] });
      await sleep(70);
      await liftAll();
      await sleep(300);
    };
    await tap3();
    assert.equal(await evaluate('__headroomSession.softkbd.open'), true);
    // The on-screen keyboard takes the bottom of the screen.
    await call('Emulation.setDeviceMetricsOverride', { ...portrait, height: 480 });
    await sleep(900);
    for (const metrics of [{ ...portrait, height: 480 }, portrait]) {
      if (metrics === portrait) { await tap3(); await call('Emulation.setDeviceMetricsOverride', portrait); await sleep(900); }
      const p0 = await picture();
      const view = await evaluate(`(() => { const r = document.getElementById('viewer').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
      const p = { x: p0.left + p0.width * 0.4, y: Math.max(p0.top, view.top) + 30 };
      await mark();
      const want = await remoteAt(p.x, p.y);
      await tap(p.x, p.y);
      const r = await settle(600);
      assert.deepEqual(r.presses, [['left', 1]], `height ${metrics.height}`);
      assert.ok(near(r.state.clicks.at(-1), want), `height ${metrics.height}: clicked at ${r.state.clicks.at(-1).x},${r.state.clicks.at(-1).y}, the finger was at ${want.x},${want.y}`);
      await sleep(500);
    }
    assert.equal(await evaluate('__headroomSession.softkbd.open'), false);
    pic = await picture();
  });

  await scenario('a pen and a mouse (Pencil, iPad trackpad) click where they point; fingers after a mouse draw the pointer again', async () => {
    const mouse = (type, x, y, pointerType, button = 'none') => call('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType });
    for (const pointerType of ['pen', 'mouse']) {
      await mark();
      const p = { x: pic.left + pic.width * (pointerType === 'pen' ? 0.25 : 0.75), y: pic.cy };
      const want = await remoteAt(p.x, p.y);
      await mouse('mouseMoved', p.x, p.y, pointerType);
      await sleep(30);
      await mouse('mousePressed', p.x, p.y, pointerType, 'left');
      await sleep(60);
      await mouse('mouseReleased', p.x, p.y, pointerType, 'left');
      const r = await settle(600);
      assert.deepEqual(r.presses, [['left', 1]], pointerType);
      assert.ok(near(r.state.clicks.at(-1), want), `${pointerType}: clicked at ${r.state.clicks.at(-1).x},${r.state.clicks.at(-1).y}, pointed at ${want.x},${want.y}`);
      assert.deepEqual(r.state.buttons, []);
      await sleep(600);
    }
    assert.equal(await evaluate('__headroomSession.cursor.mode'), 'css', 'with a mouse, this device\'s own pointer is the computer\'s');
    await mark();
    await tap(pic.cx, pic.cy);
    await settle(600);
    assert.equal(await evaluate('__headroomSession.cursor.mode'), 'overlay', 'with fingers, the pointer is drawn again');
  });

  const interruptions = {
    'window blur': () => evaluate(`window.dispatchEvent(new Event('blur')), true`),
    'page hidden': () => evaluate(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange')); return true; })()`),
    'touch cancelled': () => finger.cancel(),
    'control turned off': async () => {
      await json(`${admin}/sessions/${await sessionId('touch-cdp')}/rights`, { method: 'POST', body: JSON.stringify({ input: false }) });
      await until(() => evaluate('!__headroomSession.permissions.input'), 'view only');
    },
    'connection dropped': () => evaluate(`__headroomSession.conn.ws.close(), true`),
    'mode switched': () => evaluate(`__headroomSession.setPref('inputMode', 'trackpad'), true`),
  };
  const recover = {
    'page hidden': () => evaluate(`(() => { delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); return document.visibilityState; })()`),
    'control turned off': async () => {
      await json(`${admin}/sessions/${await sessionId('touch-cdp')}/rights`, { method: 'POST', body: JSON.stringify({ input: true }) });
      await until(() => evaluate('__headroomSession.permissions.input'), 'control back');
    },
    'connection dropped': () => until(() => evaluate('__headroomSession.conn.isOpen && !!__headroomSession.viewport.encW'), 'the session back', 20000),
    'mode switched': () => evaluate(`__headroomSession.setPref('inputMode', 'touch'), true`),
  };
  for (const [name, interrupt] of Object.entries(interruptions)) {
    await scenario(`touch mode: a drag interrupted (${name}) leaves nothing held; the lift does nothing; the next tap is one click`, async () => {
      await finger.down(1, pic.cx - 40, pic.cy);
      for (let i = 1; i <= 6; i++) { await sleep(16); await finger.move(1, pic.cx - 40 + 10 * i, pic.cy); }
      let r = await settle(200);
      assert.deepEqual(r.state.buttons, ['left'], 'dragging');
      await interrupt();
      r = await settle(500);
      assert.deepEqual(r.state.buttons, [], `let go when interrupted (${JSON.stringify(r.mouse.slice(-3))})`);
      await mark();
      if (down.size) {
        for (let i = 1; i <= 4; i++) { await sleep(16); await finger.move(1, pic.cx + 20 + 10 * i, pic.cy + 5 * i); }
        await finger.up(1);
      }
      r = await settle(400);
      assert.deepEqual(r.ev.filter(e => e.kind === 'mouse' && e.type !== 'moved'), [], 'the finger\'s later moves and lift reach nothing');
      await recover[name]?.();
      await sleep(700);
      await mark();
      await tap(pic.cx, pic.cy);
      r = await settle(600);
      assert.deepEqual(r.presses, [['left', 1]], 'the next tap is one click');
      assert.deepEqual(r.state.buttons, []);
    });
  }

  // The phone changes networks mid-drag: its old connection never closes (the host waits out 20 s of silence) and it
  // comes back on a new one with its resume key. Played here by a second connection with the page's own key.
  await scenario('back on a new connection while the old one still holds a drag: the drag is let go, new moves don\'t drag [needs the host fix]', async () => {
    await finger.down(1, pic.cx - 40, pic.cy);
    for (let i = 1; i <= 6; i++) { await sleep(16); await finger.move(1, pic.cx - 40 + 10 * i, pic.cy); }
    let r = await settle(200);
    assert.deepEqual(r.state.buttons, ['left'], 'dragging');
    const { token, url } = await evaluate(`({ token: __headroomSession.host.token, url: __headroomSession.conn._wsUrl() })`);
    const again = new WebSocket(url);
    again.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      again.onopen = () => again.send(JSON.stringify({ t: 'hello', token, client: { name: 'touch-cdp', platform: 'android' } }));
      again.onmessage = e => {
        if (typeof e.data !== 'string') return;
        const m = JSON.parse(e.data);
        if (m.t === 'welcome') again.send(JSON.stringify({ t: 'start', monitor: m.monitors[0]?.id, maxFps: 5, maxWidth: 640, maxHeight: 360, audio: false }));
        if (m.t === 'video-config') resolve();
        if (m.t === 'error') reject(new Error(m.message || m.code));
      };
      again.onclose = () => reject(new Error('the new connection closed'));
    });
    try {
      r = await settle(300);
      const held = r.state.buttons;
      await mark();
      const abs = (nx, ny) => { const b = new ArrayBuffer(9), v = new DataView(b); v.setUint8(0, 0x10); v.setFloat32(1, nx, true); v.setFloat32(5, ny, true); return b; };
      again.send(abs(0.7, 0.6)); again.send(abs(0.75, 0.62));
      r = await settle(300);
      assert.deepEqual(held, [], 'the old connection\'s drag was let go when the viewer came back');
      assert.ok(r.mouse.length && r.mouse.every(e => e.type === 'moved'), `the new connection's moves don't drag: ${JSON.stringify(r.mouse.map(e => e.type))}`);
    } finally {
      again.onclose = null;
      again.close();
      await finger.up(1);
    }
  });

  await scenario('leaving and joining again: one tap is one press and one release (no handlers left over)', async () => {
    for (let i = 0; i < 2; i++) {
      await evaluate('__headroomSession.stop(), true');
      await until(() => evaluate('!window.__headroomSession || __headroomSession.disposed'), 'the session to end');
      await sleep(800);
      await joinAsGuest('touch-cdp');
    }
    await setMode('touch');
    pic = await picture();
    await mark();
    await tap(pic.cx, pic.cy);
    const r = await settle(600);
    const buttons = await evaluate('window.__sent.filter(p => p[1] === "button").map(p => [p[2], p[3]])');
    assert.deepEqual(buttons, [[0, 1], [0, 0]], 'the page sent one press and one release');
    assert.deepEqual(r.presses, [['left', 1]]);
  });

  // Nothing went anywhere but this computer.
  const outside = requests.filter(u => !/^(https?|wss?):\/\/127\.0\.0\.1[:/]/.test(u) && !/^(data|blob|about|chrome):/.test(u));
  results.push(['every request stayed on 127.0.0.1', outside.length ? 'FAIL' : 'ok', outside.join(' ')]);
  console.log(outside.length ? '  FAIL' : '  ok  ', 'every request stayed on 127.0.0.1', outside.length ? outside : `(${requests.length} requests)`);
} catch (e) {
  results.push(['setup', 'FAIL', e.stack]);
  console.log('setup failed:', e.stack);
  for (const p of procs) if (p.log) console.log(`--- ${p.name} ---\n${p.log.slice(-3000)}`);
} finally {
  try { ws?.close(); } catch { }
  for (const p of procs.reverse()) { if (p.exitCode === null) { p.kill('SIGTERM'); await Promise.race([once(p, 'exit'), sleep(3000)]); if (p.exitCode === null) p.kill('SIGKILL'); } }
  if (!arg('dir') && dir) await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
const failed = results.filter(r => r[1] !== 'ok');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
