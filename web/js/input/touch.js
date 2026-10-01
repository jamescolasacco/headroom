// Touch gestures (iPhone / iPad / Android).
//
// Trackpad mode (laptop-trackpad semantics, cursor moves relative to your finger):
//   1-finger slide   move cursor (accelerated)        tap           left click at cursor
//   tap, touch+drag  left-drag                         hold+release  right click
//   hold, then drag  left-drag                         2-finger tap  right click
//   2-finger slide   scroll (with inertia)             pinch         zoom view (cursor-follow)
//   3-finger slide   pan view                          3-finger tap  keyboard
//
// Touch mode (direct, click where you touch):
//   tap  click there       hold+release  right click      drag  left-drag (pans instead when zoomed)
//   tap, touch+drag  left-drag (even when zoomed)        2-finger slide scroll, pinch zoom, 3-finger tap keyboard
import * as P from '../protocol.js';

const SLOP = 9;              // px before a touch counts as movement
const TAP_MS = 280;
const HOLD_MS = 450;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 36;
const SCROLL_K = 2.2;        // wheel units per CSS px of finger travel

export class TouchInput {
  /** @param {object} ctx { conn, viewport, cursor, layer, mods, ripple(x,y,kind), toggleKeyboard(), prefs() } */
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = 'trackpad';
    this.touches = new Map();
    this.g = null;                   // current gesture state
    this.lastTap = null;             // { t, x, y, nx, ny }
    this.cursor = { nx: 0.5, ny: 0.5 };
    this.cursorLocalAt = 0;
    this.buttonDown = false;
    this.inertia = 0;
    this.h = {
      down: e => this._down(e), move: e => this._move(e), up: e => this._up(e), cancel: e => this._cancel(e),
      touchstart: e => { if (e.target === this.ctx.layer) e.preventDefault(); },
    };
  }

  setMode(mode) {
    this.mode = mode;
    this.ctx.cursor.setMode('overlay');
  }

  attach() {
    const l = this.ctx.layer;
    l.addEventListener('pointerdown', this.h.down);
    l.addEventListener('pointermove', this.h.move);
    l.addEventListener('pointerup', this.h.up);
    l.addEventListener('pointercancel', this.h.cancel);
    // Kills iOS double-tap zoom, the magnifier loupe and synthetic mouse events on the canvas.
    l.addEventListener('touchstart', this.h.touchstart, { passive: false });
  }

  detach() {
    const l = this.ctx.layer;
    l.removeEventListener('pointerdown', this.h.down);
    l.removeEventListener('pointermove', this.h.move);
    l.removeEventListener('pointerup', this.h.up);
    l.removeEventListener('pointercancel', this.h.cancel);
    l.removeEventListener('touchstart', this.h.touchstart);
    this._release();
  }

  /** Remote cursor moved by the host (e.g. an app warped it): adopt it unless we moved recently. */
  remoteCursor(nx, ny) {
    if (performance.now() - this.cursorLocalAt > 400 && !this.buttonDown) this.cursor = { nx, ny };
  }

  // ------------------------------------------------------------------ helpers

  _send(buf) { this.ctx.conn.sendBinary(buf); }

  _moveTo(nx, ny) {
    this.cursor = { nx: Math.min(1, Math.max(0, nx)), ny: Math.min(1, Math.max(0, ny)) };
    this.cursorLocalAt = performance.now();
    this._send(P.mouseAbs(this.cursor.nx, this.cursor.ny));
    const v = this.ctx.viewport;
    this.ctx.cursor.setPosition(this.cursor.nx * v.srcW, this.cursor.ny * v.srcH, this.ctx.cursor.visible);
    if (this.mode === 'trackpad') v.follow(this.cursor.nx, this.cursor.ny, 56);
  }

  _button(b, down) {
    if (down) this.ctx.mods?.pressForClick();
    this._send(P.mouseButton(b, down));
    if (b === 0) this.buttonDown = down;
    if (!down) this.ctx.mods?.releaseAfterClick();
  }

  _click(b, x, y, kind) {
    this._button(b, true);
    this._button(b, false);
    this.ctx.ripple(x, y, kind);
  }

  _cursorClient() {
    const p = this.ctx.viewport.fromRemote(this.cursor.nx, this.cursor.ny);
    return p;
  }

  _centroid() {
    let x = 0, y = 0;
    for (const t of this.touches.values()) { x += t.x; y += t.y; }
    const n = Math.max(1, this.touches.size);
    return { x: x / n, y: y / n };
  }

  _spread() {
    const pts = [...this.touches.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  _stopInertia() {
    if (this.inertia) cancelAnimationFrame(this.inertia);
    this.inertia = 0;
  }

  // ------------------------------------------------------------------ pointer events

  _down(e) {
    if (e.pointerType !== 'touch') return;
    e.preventDefault();
    this.ctx.onUserGesture?.(e);
    this._stopInertia();
    try { this.ctx.layer.setPointerCapture(e.pointerId); } catch { }
    const now = performance.now();
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: now });

    if (this.touches.size === 1) {
      // Seed the trackpad cursor from the host's real position.
      if (this.mode === 'trackpad' && now - this.cursorLocalAt > 400 && !this.buttonDown) {
        const n = this.ctx.cursor.normalized;
        if (n.nx || n.ny) this.cursor = n;
      }
      const armedDrag = this.lastTap && now - this.lastTap.t < DOUBLE_TAP_MS &&
        Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < (this.mode === 'trackpad' ? 120 : DOUBLE_TAP_PX);
      this.g = { kind: 'pending', fingers: 1, start: now, armedDrag, moved: false, holdFired: false, lastX: e.clientX, lastY: e.clientY };
      this.g.holdTimer = setTimeout(() => this._hold(), HOLD_MS);
    } else if (this.g) {
      clearTimeout(this.g.holdTimer);
      if (this.g.kind === 'drag' || this.g.kind === 'holddrag') {
        // A second finger during a drag: finish the drag first.
        if (this.buttonDown) this._button(0, false);
      }
      this.g.fingers = Math.max(this.g.fingers, this.touches.size);
      if (this.g.kind !== 'pinch' && this.g.kind !== 'scroll' && this.g.kind !== 'pan3') this.g.kind = 'multi-pending';
      const c = this._centroid();
      this.g.cx = c.x; this.g.cy = c.y; this.g.spread0 = this._spread(); this.g.spread = this.g.spread0;
      this.g.vx = 0; this.g.vy = 0; this.g.lastMoveT = now;
    }
  }

  _hold() {
    const g = this.g;
    if (!g || g.kind !== 'pending' || g.moved || this.touches.size !== 1) return;
    g.holdFired = true;
    const t = [...this.touches.values()][0];
    this.ctx.ripple(t.x, t.y, 'hold');
    navigator.vibrate?.(8);
  }

  _move(e) {
    if (e.pointerType !== 'touch') return;
    const t = this.touches.get(e.pointerId);
    if (!t || !this.g) return;
    e.preventDefault();
    const now = performance.now();
    const px = t.x, py = t.y;
    t.x = e.clientX; t.y = e.clientY;
    const g = this.g;
    const v = this.ctx.viewport;

    if (this.touches.size === 1 && (g.kind === 'pending' || g.kind === 'move' || g.kind === 'drag' || g.kind === 'holddrag' || g.kind === 'pan')) {
      const dx = t.x - px, dy = t.y - py;
      if (g.kind === 'pending') {
        if (Math.hypot(t.x - t.sx, t.y - t.sy) < SLOP) return;
        clearTimeout(g.holdTimer);
        g.moved = true;
        if (g.holdFired || g.armedDrag) {
          g.kind = 'holddrag';
          if (this.mode === 'touch') { const r = v.toRemote(t.sx, t.sy); this._moveTo(r.nx, r.ny); }
          this._button(0, true);
        } else if (this.mode === 'trackpad') {
          g.kind = 'move';
        } else if (v.zoomed) {
          g.kind = 'pan';
        } else {
          g.kind = 'drag';
          const r = v.toRemote(t.sx, t.sy);
          this._moveTo(r.nx, r.ny);
          this._button(0, true);
        }
      }
      if (g.kind === 'pan') { v.panBy(dx, dy); return; }
      if (this.mode === 'trackpad') {
        const dt = Math.max(1, now - (g.lastMoveT || now - 16));
        const speed = Math.hypot(dx, dy) / dt;                 // px/ms
        const accel = 1 + Math.min(2.4, Math.max(0, (speed - 0.25) * 1.6));
        const k = (this.ctx.prefs().pointerSpeed || 1) * accel / (v.encW * v.scale);
        this._moveTo(this.cursor.nx + dx * k, this.cursor.ny + dy * k);
      } else {
        const r = v.toRemote(t.x, t.y);
        this._moveTo(r.nx, r.ny);
      }
      g.lastMoveT = now;
      return;
    }

    if (this.touches.size >= 2) {
      const c = this._centroid();
      const spread = this._spread();
      const dcx = c.x - g.cx, dcy = c.y - g.cy;
      const dt = Math.max(1, now - g.lastMoveT);
      if (g.kind === 'multi-pending') {
        const moved = Math.hypot(dcx, dcy);
        const pinchDelta = Math.abs(spread - g.spread0);
        if (this.touches.size === 2 && pinchDelta > 28 && pinchDelta > moved) g.kind = 'pinch';
        else if (moved > SLOP) g.kind = this.touches.size >= 3 ? 'pan3' : 'scroll';
        else return;
      }
      if (g.kind === 'pinch' && this.touches.size >= 2) {
        if (g.spread > 0 && spread > 0) v.zoomAt(spread / g.spread, c.x, c.y);
        v.panBy(dcx, dcy);
        g.spread = spread;
      } else if (g.kind === 'pan3') {
        v.panBy(dcx, dcy);
      } else if (g.kind === 'scroll') {
        this._scroll(dcx, dcy);
        // Velocity over a ~80 ms window of centroid samples: each finger reports separately (often
        // <1 ms apart), so per-event deltas would give absurd speeds and a huge fling.
        (g.samples ||= []).push({ t: now, x: c.x, y: c.y });
        while (g.samples.length > 2 && now - g.samples[1].t > 80) g.samples.shift();
        const s0 = g.samples[0];
        const span = now - s0.t;
        if (span >= 16) { g.vx = (c.x - s0.x) / span; g.vy = (c.y - s0.y) / span; }
      }
      g.cx = c.x; g.cy = c.y; g.lastMoveT = now;
    }
  }

  _scroll(dx, dy) {
    const natural = this.ctx.prefs().naturalScroll !== false;
    const s = natural ? 1 : -1;
    // A zoomed-out phone view shows the desktop small, so a finger-length swipe should cover more;
    // sqrt keeps it from becoming twitchy.
    const k = SCROLL_K * Math.min(3, Math.max(1, Math.sqrt(1 / Math.max(0.05, this.ctx.viewport.scale))));
    this.scrollAccX = (this.scrollAccX || 0) + -dx * k * s;
    this.scrollAccY = (this.scrollAccY || 0) + dy * k * s;
    const sx = Math.trunc(this.scrollAccX), sy = Math.trunc(this.scrollAccY);
    if (!sx && !sy) return;
    this.scrollAccX -= sx; this.scrollAccY -= sy;
    this._send(P.wheel(sx, sy));
  }

  _up(e) {
    if (e.pointerType !== 'touch') return;
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    this.touches.delete(e.pointerId);
    const g = this.g;
    if (!g) return;
    if (this.touches.size > 0) {
      // Fingers lifting one by one: recompute the reference for the remaining ones.
      const c = this._centroid();
      g.cx = c.x; g.cy = c.y; g.spread0 = g.spread = this._spread();
      return;
    }
    clearTimeout(g.holdTimer);
    const now = performance.now();
    const dur = now - g.start;
    this.g = null;

    switch (g.kind) {
      case 'pending': {
        if (g.holdFired) {
          // Hold + release without moving = right click.
          const p = this.mode === 'trackpad' ? this._cursorClient() : { x: t.sx, y: t.sy };
          if (this.mode === 'touch') { const r = this.ctx.viewport.toRemote(t.sx, t.sy); this._moveTo(r.nx, r.ny); }
          this._click(2, p.x, p.y, 'right');
          this.lastTap = null;
          return;
        }
        if (dur > TAP_MS + 200) return;
        if (this.mode === 'trackpad') {
          const p = this._cursorClient();
          this._click(0, p.x, p.y, 'left');
          this.lastTap = { t: now, x: t.sx, y: t.sy };
        } else {
          // Direct: a second tap near the first reuses its position so double-clicks register.
          let x = t.sx, y = t.sy;
          if (this.lastTap && now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < DOUBLE_TAP_PX) {
            x = this.lastTap.x; y = this.lastTap.y;
          }
          const r = this.ctx.viewport.toRemote(x, y);
          this._moveTo(r.nx, r.ny);
          this._click(0, x, y, 'left');
          this.lastTap = { t: now, x, y };
        }
        return;
      }
      case 'multi-pending':
        if (dur < TAP_MS + 150) {
          if (g.fingers === 2) {
            const c = { x: g.cx, y: g.cy };
            if (this.mode === 'touch') { const r = this.ctx.viewport.toRemote(c.x, c.y); this._moveTo(r.nx, r.ny); }
            const p = this.mode === 'trackpad' ? this._cursorClient() : c;
            this._click(2, p.x, p.y, 'right');
          } else if (g.fingers >= 3) {
            this.ctx.toggleKeyboard();
          }
        }
        this.lastTap = null;
        return;
      case 'drag':
      case 'holddrag':
        if (this.buttonDown) this._button(0, false);
        this.lastTap = null;
        return;
      case 'scroll': {
        // Only fling if the fingers were still moving when lifted.
        const fresh = g.samples?.length && now - g.samples[g.samples.length - 1].t < 60;
        if (fresh) this._startInertia(Math.max(-4, Math.min(4, g.vx || 0)), Math.max(-4, Math.min(4, g.vy || 0)));
        return;
      }
      default:
        return;
    }
  }

  _startInertia(vx, vy) {
    if (Math.hypot(vx, vy) < 0.15) return;
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(48, now - last);
      last = now;
      const decay = Math.pow(0.94, dt / 16);
      vx *= decay; vy *= decay;
      this._scroll(vx * dt, vy * dt);
      if (Math.hypot(vx, vy) > 0.02) this.inertia = requestAnimationFrame(step);
      else this.inertia = 0;
    };
    this.inertia = requestAnimationFrame(step);
  }

  _cancel(e) {
    if (e.pointerType !== 'touch') return;
    this.touches.delete(e.pointerId);
    if (this.touches.size === 0) {
      if (this.g) clearTimeout(this.g.holdTimer);
      this.g = null;
      this._release();
    }
  }

  _release() {
    if (this.buttonDown) this._button(0, false);
    this.touches.clear();
    this._stopInertia();
  }
}
