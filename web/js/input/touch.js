// Touch gestures (iPhone / iPad / Android).
//
// Trackpad mode (laptop-trackpad semantics, cursor moves relative to your finger):
//   1-finger slide   move cursor (gently accelerated)   tap           left click at cursor
//   tap, touch+drag  left-drag (one press)             tap tap       double click
//   hold, then drag  left-drag                         hold+release  right click
//   2-finger slide   scroll (with inertia)             2-finger tap  right click
//   pinch            zoom view (cursor-follow)         3-finger slide pan view, 3-finger tap keyboard
//
// Touch mode (direct, click where you touch):
//   tap  click there       hold+release  right click      drag  left-drag (pans instead when zoomed)
//   tap, touch+drag  left-drag (even when zoomed)        2-finger slide scroll, pinch zoom, 3-finger tap keyboard
//
// Tap, then touch and drag: one press-and-drag, as on a laptop's trackpad. A click and then a press on the same
// spot would be a double-click to the computer (a file opens instead of moving, a window zooms instead of
// following), so a tap's click waits TAP_DRAG_MS (trackpad mode; direct mode while zoomed), and a second touch near
// it that drags takes its place. When the click has already gone out (a slower second touch, or a hold first), the
// drag's press starts a few points along the drag from it, past where the computer would count a double click.
// A quick second tap is a double click; a second touch held a moment that never drags adds nothing.
import * as P from '../protocol.js';

const SLOP = 9;              // px before a touch counts as movement
const TAP_MS = 280;
const HOLD_MS = 450;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 36;
const TAP_DRAG_MS = 250;     // how long a tap's click waits for a second touch that drags (see the top)
const DRAG_AFTER_TAP_MS = 350; // trackpad mode: a second touch this soon after a tap can still make it a drag
// A drag's press this soon after a left click, and nearer to it than this many of the computer's points, starts
// that far from it instead (see the top): past a Mac's 5 points and Windows' 2 pixels for a double-click.
const CLICK_APART_MS = 1000, CLICK_APART_PT = 6;
const SCROLL_K = 2.2;        // wheel units per CSS px of finger travel
// Trackpad mode: how far the pointer moves for a finger movement on screen. Gentle acceleration: slow movements
// already go 1.5× as far (fine aim shouldn't crawl), quick ones up to 2.6× (to cross the screen), ramping between
// 0.2 and 1.4 px/ms of finger speed. (The "Pointer speed" setting multiplies both.)
const ACCEL_MIN = 1.5, ACCEL_MAX = 2.6, ACCEL_FROM = 0.2, ACCEL_TO = 1.4;

export class TouchInput {
  /** @param {object} ctx { conn, viewport, cursor, layer, mods, ripple(x,y,kind), toggleKeyboard(), prefs(), screenScale() } */
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = 'trackpad';
    this.touches = new Map();
    this.g = null;                   // current gesture state
    this.lastTap = null;             // { t, x, y, nx, ny }
    this.pending = null;             // a tap's click, waiting TAP_DRAG_MS: { tx, ty (where the finger was), timer }
    this.lastPress = null;           // the last left press sent: { t, nx, ny }
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
    if (!this.drivingCursor()) this.cursor = { nx, ny };
  }

  /**
   * A finger is moving the pointer (or just did): this side knows where it is. The computer's reports of its
   * position arrive a round trip late, so drawing them now would pull the pointer back: it jitters.
   */
  drivingCursor() {
    return this.buttonDown || (this.g && this.g.kind !== 'pinch' && this.g.kind !== 'scroll' && this.g.kind !== 'pan3')
      || performance.now() - this.cursorLocalAt < 700;
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
    if (b === 0 && down) this.lastPress = { t: performance.now(), nx: this.cursor.nx, ny: this.cursor.ny };
    if (!down) this.ctx.mods?.releaseAfterClick();
  }

  /**
   * Presses the left button to start a drag that heads (dx, dy). A click went out right here a moment ago? The
   * computer would count this press as its double-click, so the pointer first moves along the drag until it's
   * CLICK_APART_PT from that click (as the drag would take it there anyway).
   */
  _pressToDrag(now, dx, dy) {
    const p = this.lastPress, v = this.ctx.viewport, len = Math.hypot(dx, dy);
    if (p && v.srcW && len && now - p.t < CLICK_APART_MS) {
      const r = CLICK_APART_PT * Math.max(1, this.ctx.screenScale?.() || 1); // in the computer's pixels
      const ox = (this.cursor.nx - p.nx) * v.srcW, oy = (this.cursor.ny - p.ny) * v.srcH;
      if (Math.hypot(ox, oy) < r) {
        // How far along (ux, uy) from here the pointer is r from the click: |o + s·u| = r.
        const ux = dx / len, uy = dy / len, ou = ox * ux + oy * uy;
        const s = Math.sqrt(ou * ou - (ox * ox + oy * oy - r * r)) - ou;
        this._moveTo(this.cursor.nx + ux * s / v.srcW, this.cursor.ny + uy * s / v.srcH);
      }
    }
    this._button(0, true);
  }

  _click(b, x, y, kind) {
    this._button(b, true);
    this._button(b, false);
    this.ctx.ripple(x, y, kind);
  }

  /** A left click, shown now (x, y) but sent TAP_DRAG_MS later unless a second touch (tx, ty) turns it into a drag. */
  _deferClick(x, y, tx, ty) {
    this.ctx.ripple(x, y, 'left');
    this.pending = { tx, ty, timer: setTimeout(() => this._flushClick(), TAP_DRAG_MS) };
  }

  /** The waiting click goes out now (it was a click after all). */
  _flushClick() {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    this._button(0, true);
    this._button(0, false);
  }

  /** The waiting click never happens: it became the start of a drag. */
  _dropClick() {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
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
      // Right after a tap: this touch decides what the tap was (a drag starts here, or a double click), so its
      // click keeps waiting; a touch somewhere else means it was just a click.
      let armedDrag = false;
      const near = this.mode === 'trackpad' ? 120 : DOUBLE_TAP_PX;
      if (this.pending) {
        const p = this.pending;
        if (Math.hypot(e.clientX - p.tx, e.clientY - p.ty) < near) {
          clearTimeout(p.timer);
          armedDrag = true;
        } else this._flushClick();
      } else if (this.lastTap && now - this.lastTap.t < (this.mode === 'trackpad' ? DRAG_AFTER_TAP_MS : DOUBLE_TAP_MS)) {
        // The tap's click already went out: a drag from here is still a drag (see _pressToDrag).
        armedDrag = Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < near;
      }
      this.g = { kind: 'pending', fingers: 1, start: now, armedDrag, moved: false, holdFired: false, lastX: e.clientX, lastY: e.clientY };
      this.g.holdTimer = setTimeout(() => this._hold(), HOLD_MS);
    } else if (this.g) {
      clearTimeout(this.g.holdTimer);
      this._flushClick(); // a tap, then two fingers: the tap was a click
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
          this._dropClick(); // tap, then touch and drag: one press-and-drag, not a click and a double-click
          g.kind = 'holddrag';
          if (this.mode === 'touch') { const r = v.toRemote(t.sx, t.sy); this._moveTo(r.nx, r.ny); }
          this._pressToDrag(now, t.x - t.sx, t.y - t.sy);
        } else if (this.mode === 'trackpad') {
          g.kind = 'move';
        } else if (v.zoomed) {
          g.kind = 'pan';
        } else {
          g.kind = 'drag';
          const r = v.toRemote(t.sx, t.sy);
          this._moveTo(r.nx, r.ny);
          this._pressToDrag(now, t.x - t.sx, t.y - t.sy);
        }
      }
      if (g.kind === 'pan') { v.panBy(dx, dy); return; }
      if (this.mode === 'trackpad') {
        const dt = Math.max(1, now - (g.lastMoveT || now - 16));
        // Speed smoothed over the last few events: one jittery sample doesn't make the pointer surge or stall.
        const speed = Math.hypot(dx, dy) / dt;                 // px/ms
        g.speed = g.speed == null ? speed : g.speed * 0.6 + speed * 0.4;
        const ramp = Math.min(1, Math.max(0, (g.speed - ACCEL_FROM) / (ACCEL_TO - ACCEL_FROM)));
        const accel = ACCEL_MIN + (ACCEL_MAX - ACCEL_MIN) * ramp;
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
        // Each finger reports on its own, so halfway through a frame one finger has moved and the other not yet:
        // the centre seems to shift by half a pinch. Decide only once one kind of movement clearly leads.
        const moved = Math.hypot(dcx, dcy);
        const pinchDelta = Math.abs(spread - g.spread0);
        if (this.touches.size === 2 && pinchDelta > 24 && pinchDelta > moved) g.kind = 'pinch';
        else if (moved > SLOP * 2 && moved > pinchDelta * 1.2) g.kind = this.touches.size >= 3 ? 'pan3' : 'scroll';
        else return;
        g.pinchSpread = g.spread0; g.pinchX = g.cx; g.pinchY = g.cy; // what the picture shows so far
      }
      if (g.kind === 'pinch' && this.touches.size >= 2) {
        // Once per frame, with every finger's latest position: zoom around their centre and follow it.
        if (!g.pinchFrame) {
          g.pinchFrame = requestAnimationFrame(() => {
            g.pinchFrame = 0;
            if (this.g !== g || this.touches.size < 2) return;
            const cc = this._centroid(), sp = this._spread();
            const r = this.ctx.layer.getBoundingClientRect();
            v.pinch(g.pinchSpread > 0 && sp > 0 ? sp / g.pinchSpread : 1, cc.x - r.left, cc.y - r.top, cc.x - g.pinchX, cc.y - g.pinchY);
            g.pinchSpread = sp; g.pinchX = cc.x; g.pinchY = cc.y;
          });
        }
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
      g.pinchSpread = g.spread; g.pinchX = c.x; g.pinchY = c.y;
      return;
    }
    clearTimeout(g.holdTimer);
    const now = performance.now();
    const dur = now - g.start;
    this.g = null;

    switch (g.kind) {
      case 'pending': {
        if (g.holdFired && g.armedDrag) {
          // A tap, then a hold that never dragged: just the tap's click.
          this._flushClick();
          this.lastTap = null;
          return;
        }
        if (g.holdFired) {
          // Hold + release without moving = right click.
          const p = this.mode === 'trackpad' ? this._cursorClient() : { x: t.sx, y: t.sy };
          if (this.mode === 'touch') { const r = this.ctx.viewport.toRemote(t.sx, t.sy); this._moveTo(r.nx, r.ny); }
          this._click(2, p.x, p.y, 'right');
          this.lastTap = null;
          return;
        }
        if (dur > TAP_MS + 200) { this._flushClick(); return; }
        if (g.armedDrag && dur > TAP_MS) {
          // A tap, then a touch held a moment that never dragged: just the tap's click, not a slow double click.
          this._flushClick();
          this.lastTap = null;
          return;
        }
        if (this.mode === 'trackpad') {
          const p = this._cursorClient();
          if (g.armedDrag && this.pending) {
            // Tap, tap: the first click now, then this one, so the computer sees a double click.
            this._flushClick();
            this._click(0, p.x, p.y, 'left');
            this.lastTap = null;
            return;
          }
          this._deferClick(p.x, p.y, t.sx, t.sy);
          this.lastTap = { t: now, x: t.sx, y: t.sy };
        } else {
          // Direct: a second tap near the first reuses its position so double-clicks register.
          let x = t.sx, y = t.sy;
          if (this.lastTap && now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < DOUBLE_TAP_PX) {
            x = this.lastTap.x; y = this.lastTap.y;
          }
          if (g.armedDrag && this.pending) {
            // Zoomed in, tap, tap: the first click now, then this one (the pointer is still where the first went).
            this._flushClick();
            this._click(0, x, y, 'left');
            this.lastTap = { t: now, x, y };
            return;
          }
          const r = this.ctx.viewport.toRemote(x, y);
          this._moveTo(r.nx, r.ny);
          // Zoomed in, a plain drag pans, so a tap's click waits for a possible tap-and-drag; otherwise it's instant.
          if (this.ctx.viewport.zoomed) this._deferClick(x, y, x, y);
          else this._click(0, x, y, 'left');
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
      this._flushClick(); // the system took the touch over: an earlier tap was still a click
      this._release();
    }
  }

  _release() {
    this._dropClick();
    if (this.buttonDown) this._button(0, false);
    this.touches.clear();
    this._stopInertia();
  }
}
