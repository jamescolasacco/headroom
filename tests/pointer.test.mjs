import assert from 'node:assert/strict';
import test from 'node:test';
import { MouseInput } from '../web/js/input/mouse.js';
import { TouchInput } from '../web/js/input/touch.js';

function decode(buf) {
  const v = new DataView(buf);
  switch (v.getUint8(0)) {
    case 0x10: return ['at', ...[1, 5].map(i => Math.round(v.getFloat32(i, true) * 1000))];
    case 0x11: return ['by', v.getInt16(1, true), v.getInt16(3, true)];
    case 0x12: return ['button', v.getUint8(1), v.getUint8(2)];
    case 0x13: return ['wheel', v.getInt16(1, true), v.getInt16(3, true)];
    case 0x14: return ['key', new TextDecoder().decode(buf.slice(3)), v.getUint8(1)];
    case 0x16: return ['touch', v.getUint8(1), ...[2, 6, 10].map(i => Number(v.getFloat32(i, true).toFixed(3)))];
    default: assert.fail('Unknown packet');
  }
}

function fixture(t) {
  const layer = new EventTarget(), packets = [], local = [];
  globalThis.window = Object.assign(new EventTarget(), { innerWidth: 1000, innerHeight: 1000 });
  globalThis.document = Object.assign(new EventTarget(), { elementFromPoint: () => layer });
  let nextFrame = 0;
  const frames = new Map();
  globalThis.requestAnimationFrame = cb => { frames.set(++nextFrame, cb); return nextFrame; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb()); };
  const state = { allowed: true, target: 'remote' };
  layer.contains = target => target === layer;
  layer.getBoundingClientRect = () => ({ left: 0, top: 0 });
  layer.setPointerCapture = () => {};
  const ctx = {
    layer, conn: { sendBinary: data => packets.push(decode(data)) },
    viewport: { toRemote: (x, y) => ({ nx: x / 1000, ny: y / 1000 }), srcW: 1000, srcH: 1000, scale: 1,
      pinch: (...args) => local.push(args), fromRemote: (x, y) => ({ x: x * 1000, y: y * 1000 }), follow() {} },
    keyboard: { down: new Set(), physicalControls: new Set(), prepareClick() {} },
    cursor: { setMode() {}, setPosition() {}, normalized: { nx: 0.5, ny: 0.5 } },
    inputAllowed: () => state.allowed, pinchTarget: () => state.target, prefs: () => ({}),
    ripple() {}, toggleKeyboard() {},
  };
  const mouse = new MouseInput(ctx);
  const touch = new TouchInput({ ...ctx, pinch: (...args) => mouse.pinch(...args), endPinch: v => mouse.endPinch(v) });
  ctx.touchActive = () => touch.touches.size > 0;
  mouse.attach(); touch.attach();
  t.after(() => { mouse.detach(); touch.detach(); });
  const fire = (type, props = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      clientX: 250, clientY: 320, button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse',
      movementX: 0, movementY: 0, deltaMode: 0, deltaX: 0, deltaY: 0, ...props,
    });
    layer.dispatchEvent(event);
    return event;
  };
  return { mouse, touch, ctx, state, packets, local, fire, frame };
}

const ctrl = down => ['key', 'ControlLeft', down];
const zoom = (sign = 1) => ['wheel', 0, 120 * sign];

test('Safari scale is cumulative; rotation and repeat end frames must not generate duplicate zoom', t => {
  const { fire, packets } = fixture(t);
  fire('gesturestart', { scale: 1 });
  for (let i = 1; i <= 40; i++) fire('gesturechange', { scale: 1 + i / 100 });
  fire('wheel', { ctrlKey: true, deltaY: -40 }); // duplicate delivery during a WebKit gesture
  fire('gestureend', { scale: 1.4 });
  assert.deepEqual(packets, [['at', 250, 320], ctrl(1), zoom(), ctrl(0), ['at', 250, 320], ctrl(1), zoom(), ctrl(0)]);
});

test('Chromium pinch sends complete wheel notches in both directions with no stuck Ctrl', t => {
  const { fire, packets } = fixture(t);
  for (let i = 0; i < 15; i++) assert.ok(fire('wheel', { ctrlKey: true, deltaY: -1 }).defaultPrevented);
  for (let i = 0; i < 17; i++) fire('wheel', { ctrlKey: true, deltaY: 1 });
  assert.deepEqual(packets, [['at', 250, 320], ctrl(1), zoom(), ctrl(0), ['at', 250, 320], ctrl(1), zoom(-1), ctrl(0)]);
});

test('physical Ctrl-wheel, smooth diagonal scrolling, line and page units stay distinct from pinch', t => {
  const { fire, packets, ctx } = fixture(t);
  ctx.keyboard.down.add('ControlRight'); ctx.keyboard.physicalControls.add('ControlRight');
  fire('wheel', { ctrlKey: true, deltaX: 10, deltaY: 20 });
  fire('wheel', { deltaMode: 1, deltaX: -3, deltaY: -3 });
  fire('wheel', { deltaMode: 2, deltaY: 1 });
  for (let i = 0; i < 10; i++) fire('wheel', { deltaX: 0.1 });
  assert.deepEqual(packets.filter(p => p[0] === 'wheel'), [['wheel', 12, -24], ['wheel', -120, 120], ['wheel', 0, -360], ['wheel', 1, 0]]);
  assert.ok(!packets.some(p => p[0] === 'key'));
});

test('native magnify stays on the remote surface and never sends input in view-only mode', t => {
  const { mouse, state, packets, local } = fixture(t);
  const m = (phase, factor) => mouse.nativeMagnify({ x: 0.25, y: 0.32, phase, factor });
  document.elementFromPoint = () => null;
  m('begin', 1); m('change', 1.4); m('end', 1);
  assert.equal(packets.length, 0);
  document.elementFromPoint = () => mouse.ctx.layer;
  m('begin', 1); m('change', 1.2); m('end', 1);
  assert.deepEqual(packets, [['at', 250, 320], ctrl(1), zoom(), ctrl(0)]);
  state.allowed = false;
  m('begin', 1); m('change', 1.2); m('end', 1);
  assert.equal(packets.length, 4);
  assert.ok(local.some(([s, x, y]) => s === 1.2 && x === 250 && y === 320));
});

test('native touch zoom sends begin/update/end; on blur it cancels both contacts', t => {
  const { fire, state, packets } = fixture(t);
  state.target = 'touch';
  fire('gesturestart', { scale: 1 }); fire('gesturechange', { scale: 1.4 }); fire('gestureend', { scale: 1.4 });
  assert.deepEqual(packets[0], ['touch', 0, 0.25, 0.32, 1]);
  assert.deepEqual(packets[1], ['touch', 1, 0.25, 0.32, 1.4]);
  assert.equal(packets.at(-1)[1], 2);
  packets.length = 0;
  fire('wheel', { ctrlKey: true, deltaY: -10 }); window.dispatchEvent(new Event('blur'));
  assert.deepEqual(packets.map(p => p[1]), [0, 1, 3]);
});

test('chorded side, middle and right buttons keep the current drag position and final release position', t => {
  const { fire, packets } = fixture(t);
  fire('pointerdown', { buttons: 1 });
  fire('pointermove', { buttons: 31, clientX: 420 });
  fire('pointermove', { buttons: 16, clientX: 510 });
  fire('pointerup', { buttons: 0, clientX: 820 });
  assert.deepEqual(packets.filter(p => p[0] === 'button').map(p => p.slice(1)),
    [[0,1],[1,1],[2,1],[3,1],[4,1],[0,0],[1,0],[2,0],[3,0],[4,0]]);
  assert.deepEqual(packets.slice(-2), [['at', 820, 320], ['button', 4, 0]]);
  assert.ok(fire('auxclick', { button: 3 }).defaultPrevented);
});

test('pen eraser maps to right click and unrelated touch cancellation cannot release it', t => {
  const { fire, packets } = fixture(t);
  fire('pointerdown', { pointerType: 'pen', buttons: 32, button: 5 });
  fire('pointercancel', { pointerType: 'touch', pointerId: 2 });
  assert.deepEqual(packets.at(-1), ['button', 2, 1]);
  fire('lostpointercapture', { pointerType: 'pen' });
  assert.deepEqual(packets.at(-1), ['button', 2, 0]);
});

test('buffered absolute or relative movement cannot leak past blur, detach or revoked input', async t => {
  const { mouse, ctx, packets, state, fire } = fixture(t);
  ctx.conn.buffered = 300000;
  fire('pointermove', { clientX: 900 }); window.dispatchEvent(new Event('blur'));
  mouse.relative = true;
  fire('pointermove', { movementX: 101, movementY: -20 }); state.allowed = false;
  await new Promise(r => setTimeout(r, 20));
  ctx.conn.buffered = 0; state.allowed = true;
  fire('pointermove', { movementX: 2, movementY: -3 }); mouse._flushMove();
  assert.deepEqual(packets, [['by', 2, -3]]);
});

test('touchscreen pinch uses both finger samples and flushes a quick pinch before lift', t => {
  const { fire, touch, state, packets, local } = fixture(t);
  state.target = 'viewer'; touch.setMode('touch');
  const finger = (type, id, x) => fire(type, { pointerType: 'touch', pointerId: id, clientX: x });
  finger('pointerdown', 1, 400); finger('pointerdown', 2, 500);
  fire('gesturestart', { scale: 1 }); fire('gesturechange', { scale: 1.4 });
  finger('pointermove', 1, 390); finger('pointermove', 2, 510);
  finger('pointerup', 1, 390); finger('pointerup', 2, 510);
  assert.deepEqual(local, [[1.2, 450, 320, 0, 0]]);
  assert.deepEqual(packets, []);
});

test('two fingers moving together scroll the window at the original centroid without zooming', t => {
  const { fire, touch, packets, local, frame } = fixture(t);
  touch.setMode('touch');
  const finger = (type, id, x) => fire(type, { pointerType: 'touch', pointerId: id, clientX: x });
  finger('pointerdown', 1, 400); finger('pointerdown', 2, 500);
  finger('pointermove', 1, 434); finger('pointermove', 2, 534); frame();
  assert.deepEqual(packets, [['at', 450, 320], ['wheel', -74, 0]]);
  assert.deepEqual(local, []);
});

test('captured pointer conserves fractional and large relative motion across flushes', t => {
  const { mouse, fire, packets } = fixture(t);
  mouse.relative = true;
  for (let i = 0; i < 8; i++) { fire('pointermove', { movementX: 0.25, movementY: -0.25 }); mouse._flushMove(); }
  fire('pointermove', { movementX: 80000, movementY: -90000 }); mouse._flushMove();
  assert.deepEqual(packets.reduce(([x, y], p) => [x + p[1], y + p[2]], [0, 0]), [80002, -90002]);
});

test('reversing incremental pinches to their starting scale restores the Windows zoom level', t => {
  const { fire, packets } = fixture(t);
  for (let peak = 116; peak <= 250; peak++) {
    packets.length = 0;
    fire('gesturestart', { scale: 1 });
    for (let step = 1; step <= 20; step++) fire('gesturechange', { scale: 1 + (peak / 100 - 1) * step / 20 });
    for (let step = 19; step >= 0; step--) fire('gesturechange', { scale: 1 + (peak / 100 - 1) * step / 20 });
    fire('gestureend', { scale: 1 });
    const wheels = packets.filter(p => p[0] === 'wheel');
    assert.ok(wheels.length >= 2, 'peak ' + peak);
    assert.equal(wheels.reduce((net, p) => net + p[2], 0), 0, 'peak ' + peak);
  }
});

test('the final touch sample can complete a pinch without a preceding pointermove', t => {
  const { fire, state, packets, local } = fixture(t);
  state.target = 'viewer';
  const finger = (type, id, x) => fire(type, { pointerType: 'touch', pointerId: id, clientX: x });
  finger('pointerdown', 1, 400); finger('pointerdown', 2, 500);
  finger('pointerup', 1, 375); finger('pointerup', 2, 525);
  assert.equal(local.length, 1);
  assert.equal(local[0][0], 1.25);
  assert.deepEqual(packets, []);
});

test('a remaining moving finger after a two-finger tap starts lifting cannot click', t => {
  const { fire, packets } = fixture(t);
  const finger = (type, id, x) => fire(type, { pointerType: 'touch', pointerId: id, clientX: x });
  finger('pointerdown', 1, 400); finger('pointerdown', 2, 500);
  finger('pointerup', 1, 400); finger('pointerup', 2, 525);
  assert.deepEqual(packets, []);
});

test('a pinch outside the remote screen (toolbar, overlay, the opening transition) never zooms the page', t => {
  const { packets } = fixture(t);
  const wheel = props => {
    const e = Object.assign(new Event('wheel', { cancelable: true }), { deltaMode: 0, deltaX: 0, deltaY: -10, ctrlKey: false, ...props });
    window.dispatchEvent(e);
    return e;
  };
  assert.ok(wheel({ ctrlKey: true }).defaultPrevented);
  assert.ok(!wheel({}).defaultPrevented, 'scrolling the page\'s own panels stays theirs');
  assert.deepEqual(packets, []);
});
