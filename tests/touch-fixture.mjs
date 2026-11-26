// A phone's fingers on the session's input layer, on a fake clock, and the Mac host that receives the packets.
// Used by tests/touch-*.test.mjs: TouchInput (web/js/input/touch.js) runs unchanged; time, timers and animation
// frames are simulated so gestures replay at exact speeds, and macHost() counts clicks the way the Mac host's
// InputInjector does (same button, within 500 ms press to press, nearer than 5 points), so a test asserts what
// the computer ends up doing, not just which packets went out.
import { TouchInput } from '../web/js/input/touch.js';

/** Packet bytes -> [kind, ...values]: ['at', nx, ny], ['button', b, down], ['wheel', dx, dy], ['touch', phase, ...]. */
export function decode(buf) {
  const v = new DataView(buf);
  switch (v.getUint8(0)) {
    case 0x10: return ['at', v.getFloat32(1, true), v.getFloat32(5, true)];
    case 0x11: return ['by', v.getInt16(1, true), v.getInt16(3, true)];
    case 0x12: return ['button', v.getUint8(1), v.getUint8(2)];
    case 0x13: return ['wheel', v.getInt16(1, true), v.getInt16(3, true)];
    case 0x14: return ['key', new TextDecoder().decode(buf.slice(3)), v.getUint8(1)];
    case 0x16: return ['touch', v.getUint8(1), v.getFloat32(2, true), v.getFloat32(6, true), v.getFloat32(10, true)];
    default: throw new Error('Unknown packet ' + v.getUint8(0));
  }
}

/**
 * What the Mac host does with the packets ({ t, p } in the order sent), as host-macos InputInjector.swift does it:
 * positions in points (the screen is widthPt × heightPt), a press counted as the previous one's double (then
 * triple) click when it's the same button, within 500 ms and nearer than 5 points. Returns the events it posts
 * and what it still holds at the end.
 */
export function macHost(sent, { widthPt = 1280, heightPt = 720, doubleClickMs = 500 } = {}) {
  const events = [], held = new Set();
  let pos = null, click = { b: -1, n: 0, t: -Infinity, x: 0, y: 0 }, wheelY = 0, wheelX = 0;
  for (const { t, p } of sent) {
    if (p[0] === 'release') {
      // The host lets go of what this viewer held (its socket closed, or control was turned off): releaseAll.
      for (const b of held) events.push({ t, type: 'up', b, clickState: b === click.b ? click.n : 1, x: pos?.x ?? 0, y: pos?.y ?? 0 });
      held.clear();
    } else if (p[0] === 'at') {
      const x = Math.min(Math.max(p[1], 0), 0.99999) * widthPt, y = Math.min(Math.max(p[2], 0), 0.99999) * heightPt;
      if (pos && pos.x === x && pos.y === y) continue;
      pos = { x, y };
      events.push({ t, type: held.has(0) ? 'leftDragged' : held.has(2) ? 'rightDragged' : 'moved', x, y });
    } else if (p[0] === 'button') {
      const [, b, downByte] = p, down = !!downByte;
      if (down === held.has(b)) continue; // the injector ignores a press of a held button
      const at = pos || { x: 0, y: 0 };
      if (down) {
        const n = b === click.b && t - click.t <= doubleClickMs && Math.hypot(at.x - click.x, at.y - click.y) < 5 ? Math.min(click.n + 1, 3) : 1;
        click = { b, n, t, x: at.x, y: at.y };
        held.add(b);
      } else held.delete(b);
      events.push({ t, type: down ? 'down' : 'up', b, clickState: b === click.b ? click.n : 1, x: at.x, y: at.y });
    } else if (p[0] === 'wheel') {
      wheelX += p[1]; wheelY += p[2];
      events.push({ t, type: 'wheel', dx: p[1], dy: p[2] });
    }
  }
  const presses = events.filter(e => e.type === 'down');
  return {
    events, held: [...held], pos, wheel: { x: wheelX, y: wheelY },
    /** Each press as [button, clickState]: a double click is [[0, 1], [0, 2]]. */
    presses: presses.map(e => [e.b, e.clickState]),
    /** Moves made while a button was held: [button, count]. */
    drags: ['leftDragged', 'rightDragged'].map(k => events.filter(e => e.type === k).length),
  };
}

/**
 * A TouchInput on a fake phone screen: the remote screen (srcW × srcH pixels, screenScale pixels per point) is
 * drawn at `scale` CSS px per pixel with its top-left at (ox, oy). Returns helpers to put fingers down, move them
 * and lift them on a simulated clock (advance(ms) runs due timers and 16 ms animation frames in order).
 */
export function touchFixture(t, { mode = 'trackpad', srcW = 1280, srcH = 720, scale = 0.3, ox = 0, oy = 200, screenScale = 1, cursorAt = [0.5, 0.5] } = {}) {
  const clock = { now: 1000 };
  const timers = new Map(), frames = new Map();
  let nextId = 0;
  const saved = {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame,
    performance: Object.getOwnPropertyDescriptor(globalThis, 'performance'),
  };
  globalThis.setTimeout = (fn, ms = 0) => { timers.set(++nextId, { at: clock.now + Math.max(0, ms), fn }); return nextId; };
  globalThis.clearTimeout = id => { timers.delete(id); };
  globalThis.requestAnimationFrame = fn => { frames.set(++nextId, fn); return nextId; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  Object.defineProperty(globalThis, 'performance', { value: { now: () => clock.now }, configurable: true, writable: true });
  t.after(() => {
    globalThis.setTimeout = saved.setTimeout; globalThis.clearTimeout = saved.clearTimeout;
    globalThis.requestAnimationFrame = saved.requestAnimationFrame; globalThis.cancelAnimationFrame = saved.cancelAnimationFrame;
    Object.defineProperty(globalThis, 'performance', saved.performance);
  });

  /** Runs what's due up to clock.now + ms: timers when they fall due, animation frames every 16 ms. */
  const advance = (ms = 0) => {
    const end = clock.now + ms;
    for (;;) {
      let next = null;
      for (const [id, tm] of timers) if (tm.at <= end && (!next || tm.at < next[1].at || (tm.at === next[1].at && id < next[0]))) next = [id, tm];
      const frameAt = frames.size ? Math.ceil((clock.now + 0.001) / 16) * 16 : Infinity;
      if (frameAt <= end && (!next || frameAt <= next[1].at)) {
        clock.now = frameAt;
        const due = [...frames.values()]; frames.clear(); due.forEach(fn => fn());
        continue;
      }
      if (!next) break;
      clock.now = Math.max(clock.now, next[1].at);
      timers.delete(next[0]);
      next[1].fn();
    }
    clock.now = end;
  };
  /** Runs pending animation frames now (as the browser would before painting). */
  const frame = () => { const due = [...frames.values()]; frames.clear(); due.forEach(fn => fn()); };

  const layer = new EventTarget();
  layer.setPointerCapture = () => { };
  const state = { allowed: true };
  const sent = [], local = { pinch: [], endPinch: [], pan: [], keyboard: 0, ripples: [] };
  const viewport = {
    srcW, srcH, encW: srcW, encH: srcH, scale, ox, oy, zoomed: false,
    toRemote(x, y) {
      const nx = (x - this.ox) / (this.encW * this.scale), ny = (y - this.oy) / (this.encH * this.scale);
      return { nx: Math.min(1, Math.max(0, nx)), ny: Math.min(1, Math.max(0, ny)) };
    },
    fromRemote(nx, ny) { return { x: this.ox + nx * this.encW * this.scale, y: this.oy + ny * this.encH * this.scale }; },
    follow() { },
    panBy(dx, dy) { this.ox += dx; this.oy += dy; local.pan.push([dx, dy]); },
  };
  const cursor = {
    x: cursorAt[0] * srcW, y: cursorAt[1] * srcH, visible: true, mode: 'css',
    setMode(m) { this.mode = m; },
    setPosition(x, y) { this.x = x; this.y = y; },
    get normalized() { return { nx: this.x / srcW, ny: this.y / srcH }; },
  };
  const prefs = {};
  const ctx = {
    layer, viewport, cursor, prefs: () => prefs,
    conn: { sendBinary: buf => sent.push({ t: clock.now, p: decode(buf) }) },
    inputAllowed: () => state.allowed,
    ripple: (x, y, kind) => local.ripples.push(kind),
    toggleKeyboard: () => { local.keyboard++; },
    pinch: (...args) => local.pinch.push(args),
    endPinch: cancel => local.endPinch.push(!!cancel),
    screenScale: () => screenScale,
  };
  const touch = new TouchInput(ctx);
  touch.setMode(mode);
  touch.attach();
  t.after(() => touch.detach());

  const fire = (type, id, x, y) => {
    const e = Object.assign(new Event(type, { cancelable: true }), { pointerType: 'touch', pointerId: id, clientX: x, clientY: y });
    layer.dispatchEvent(e);
    return e;
  };
  const fingers = new Map();
  const down = (id, x, y) => { fingers.set(id, [x, y]); fire('pointerdown', id, x, y); };
  const move = (id, x, y) => { fingers.set(id, [x, y]); fire('pointermove', id, x, y); };
  const up = (id, x, y) => { const [fx, fy] = fingers.get(id) || [x, y]; fingers.delete(id); fire('pointerup', id, x ?? fx, y ?? fy); };
  const cancel = id => { const [x, y] = fingers.get(id) || [0, 0]; fingers.delete(id); fire('pointercancel', id, x, y); };

  /** One finger: down, `hold` ms, up (no movement). */
  const tap = (x, y, { id = 1, hold = 90 } = {}) => { down(id, x, y); advance(hold); up(id); };
  /** One finger from (x, y) by (dx, dy) in `steps` moves `dt` ms apart, `pause` ms after landing; lifts unless keep. */
  const slide = (x, y, dx, dy, { id = 1, steps = 10, dt = 16, pause = 0, keep = false } = {}) => {
    down(id, x, y); advance(pause);
    for (let i = 1; i <= steps; i++) { advance(dt); move(id, x + dx * i / steps, y + dy * i / steps); }
    if (!keep) up(id);
  };
  /** Two fingers 80 px apart around (x, y), moved together by (dx, dy) and spread by `grow` px. */
  const two = (x, y, dx = 0, dy = 0, { grow = 0, steps = 10, dt = 16, hold = 0, keep = false, ids = [1, 2] } = {}) => {
    down(ids[0], x - 40, y); down(ids[1], x + 40, y);
    advance(hold);
    for (let i = 1; i <= steps && (dx || dy || grow); i++) {
      advance(dt);
      const s = grow * i / steps / 2;
      move(ids[0], x - 40 - s + dx * i / steps, y + dy * i / steps);
      move(ids[1], x + 40 + s + dx * i / steps, y + dy * i / steps);
    }
    if (!keep) { advance(dx || dy || grow ? 0 : 60); up(ids[0]); up(ids[1]); }
  };
  const host = opts => macHost(sent, { widthPt: srcW / screenScale, heightPt: srcH / screenScale, ...opts });
  /** The host releases what this viewer holds by itself (socket closed, control turned off). */
  const hostReleases = () => sent.push({ t: clock.now, p: ['release'] });
  return { touch, ctx, viewport, cursor, prefs, state, sent, local, clock, advance, frame, down, move, up, cancel, tap, slide, two, host, hostReleases, fire, timers };
}
