// Touch gestures (iPhone / iPad / Android): the same as Microsoft Remote Desktop's.
//
// Trackpad mode (Remote Desktop's "mouse pointer" mode: the finger moves the pointer):
//   slide                                      move the pointer (gently accelerated)
//   tap / tap tap / tap tap tap                left-click / double-click / triple-click
//   ... then touch and drag                    a drag with that click: in text, by character / word / paragraph
//                                              (the first is Remote Desktop's "double-tap and hold, then drag";
//                                              hold, then drag is the same)
//   two-finger tap, or tap and hold            right-click
//   two-finger tap, then touch and drag        right-click drag ("double-tap and hold with two fingers, then drag")
//   two-finger slide (held first or not)       mouse wheel, with momentum
//   pinch                                      zoom the view (it follows the pointer)
//   three-finger slide / tap                   pan the view / keyboard
//
// Touch mode (Remote Desktop's "direct touch": click where you touch):
//   tap  left-click there     tap and hold  right-click     drag  left-click drag (pans the view instead when
//   zoomed in); the tap-and-hold-then-drag gestures above work too, where the fingers are.
//
// A tap's click goes out the moment the finger lifts: nothing waits to see what comes next. So in "double-tap and
// hold, then drag" the drag's press comes right after a click on the same spot, which the computer would count as
// a double click (a window zooms instead of following): the press starts a few points along the drag instead.
// Taps the computer counts as a double or triple click (by its own rule: see MULTI_CLICK_MS) keep the button down
// for TAP_AGAIN_MS: a touch by then that drags carries that press on, so tap tap, then drag selects word by word and
// tap tap tap, then drag paragraph by paragraph, as with a mouse.
import * as P from '../protocol.js';

const SLOP = 9;              // px before a touch counts as movement
const TAP_MS = 280;
const HOLD_MS = 450;
// A touch this soon after a tap carries it on: dragging makes it a click-drag, or after taps the computer counted
// as a double or triple click, a double- or triple-click drag. (150 ms was too quick for real double taps.)
const TAP_AGAIN_MS = 350;
// The computer counts a click this soon after the last one, and this near it, as that one's double (then triple)
// click: Macs and Windows do by default (the Mac host counts within 5 points; Windows, a few pixels). Touch mode makes
// a tap this soon after another, and within DOUBLE_TAP_PX of it, land where that one did, as a finger never lands on
// the same spot twice.
const MULTI_CLICK_MS = 500, MULTI_CLICK_PT = 5;
const DOUBLE_TAP_PX = 36;
// A drag's press this soon after a click of the same button, and nearer to it than this many of the computer's
// points, starts that far from it instead (see the top): past a Mac's 5 points and Windows' 2 pixels for a double-click.
const CLICK_APART_MS = 1000, CLICK_APART_PT = 6;
const SCROLL_K = 2.2;        // wheel units per CSS px of finger travel
// Trackpad mode: how far the pointer moves for a finger movement on screen. Gentle acceleration: slow movements
// already go 1.5× as far (fine aim shouldn't crawl), quick ones up to 2.6× (to cross the screen), ramping between
// 0.2 and 1.4 px/ms of finger speed. (The "Pointer speed" setting multiplies both.)
const ACCEL_MIN = 1.5, ACCEL_MAX = 2.6, ACCEL_FROM = 0.2, ACCEL_TO = 1.4;

export class TouchInput {
  /** @param {object} ctx { conn, viewport, cursor, layer, mods, ripple(x,y,kind), toggleKeyboard(), prefs(), screenScale(), onPress() } */
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = 'trackpad';
    this.touches = new Map();
    this.g = null;                   // current gesture state
    this.lastTap = null;             // { t, x, y }: when and where (on the screen here) the last tap was
    this.lastTap2 = null;            // the same for the last two-finger tap
    this.held = null;                // a double tap's click, its release waiting TAP_AGAIN_MS: { tx, ty, timer }
    this.lastPress = null;           // the last press sent: { b (button), t, nx, ny, n (its click count) }
    this.cursor = { nx: 0.5, ny: 0.5 };
    this.cursorLocalAt = 0;
    this.buttonDown = false;         // the left button
    this.rightDown = false;
    this.inertia = 0;
    this.h = {
      down: e => this._down(e), move: e => this._move(e), up: e => this._up(e), cancel: e => this._cancel(e),
      touchstart: e => { if (e.target === this.ctx.layer) e.preventDefault(); },
    };
  }

  setMode(mode) {
    if (this.mode !== mode) this.releaseAll();
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
    this.releaseAll();
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
    return this.buttonDown || this.rightDown || (this.g && this.g.kind !== 'pinch' && this.g.kind !== 'scroll' && this.g.kind !== 'pan3')
      || performance.now() - this.cursorLocalAt < 700;
  }

  // ------------------------------------------------------------------ helpers

  _send(buf) { if (this.ctx.inputAllowed()) this.ctx.conn.sendBinary(buf); }

  _moveTo(nx, ny) {
    this.cursor = { nx: Math.min(1, Math.max(0, nx)), ny: Math.min(1, Math.max(0, ny)) };
    this.cursorLocalAt = performance.now();
    this._send(P.mouseAbs(this.cursor.nx, this.cursor.ny));
    const v = this.ctx.viewport;
    this.ctx.cursor.setPosition(this.cursor.nx * v.srcW, this.cursor.ny * v.srcH, this.ctx.cursor.visible);
    if (this.mode === 'trackpad') v.follow(this.cursor.nx, this.cursor.ny, 56);
  }

  _button(b, down) {
    if (down) { this.ctx.mods?.pressForClick(); this.ctx.onPress?.(); }
    this._send(P.mouseButton(b, down));
    if (b === 0) this.buttonDown = down;
    if (b === 2) this.rightDown = down;
    if (down) {
      const now = performance.now();
      this.lastPress = { b, t: now, nx: this.cursor.nx, ny: this.cursor.ny, n: b === 0 ? this._clickCount(now) : 1 };
    }
    if (!down) this.ctx.mods?.releaseAfterClick();
  }

  /** What the computer will count a left press now, at the pointer, as: 1, or 2 and 3 for a double and triple click. */
  _clickCount(now) {
    const p = this.lastPress, v = this.ctx.viewport;
    if (!p || p.b !== 0 || now - p.t > MULTI_CLICK_MS || !v.srcW) return 1;
    const r = MULTI_CLICK_PT * Math.max(1, this.ctx.screenScale?.() || 1); // in the computer's pixels
    const d = Math.hypot((this.cursor.nx - p.nx) * v.srcW, (this.cursor.ny - p.ny) * v.srcH);
    return d < r ? Math.min(3, p.n + 1) : 1;
  }

  /**
   * Presses button b to start a drag that heads (dx, dy). A click of it went out right here a moment ago? The
   * computer would count this press as its double-click, so the pointer first moves along the drag until it's
   * CLICK_APART_PT from that click (as the drag would take it there anyway).
   */
  _pressToDrag(now, dx, dy, b = 0) {
    const p = this.lastPress, v = this.ctx.viewport, len = Math.hypot(dx, dy);
    if (p && p.b === b && v.srcW && len && now - p.t < CLICK_APART_MS) {
      const r = CLICK_APART_PT * Math.max(1, this.ctx.screenScale?.() || 1); // in the computer's pixels
      const ox = (this.cursor.nx - p.nx) * v.srcW, oy = (this.cursor.ny - p.ny) * v.srcH;
      if (Math.hypot(ox, oy) < r) {
        // How far along (ux, uy) from here the pointer is r from the click: |o + s·u| = r.
        const ux = dx / len, uy = dy / len, ou = ox * ux + oy * uy;
        const s = Math.sqrt(ou * ou - (ox * ox + oy * oy - r * r)) - ou;
        this._moveTo(this.cursor.nx + ux * s / v.srcW, this.cursor.ny + uy * s / v.srcH);
      }
    }
    this._button(b, true);
  }

  _click(b, x, y, kind) {
    this._button(b, true);
    this._button(b, false);
    this.ctx.ripple(x, y, kind);
  }

  /**
   * A tap's left click (shown at x, y; the finger was at tx, ty). One the computer will count as a double or triple
   * click keeps the button down for TAP_AGAIN_MS (see _holdClick); any other goes out whole, at once.
   */
  _tapClick(now, x, y, tx, ty) {
    if (this._clickCount(now) > 1) this._holdClick(x, y, tx, ty);
    else this._click(0, x, y, 'left');
  }

  /**
   * A left click whose release waits TAP_AGAIN_MS: a touch near (tx, ty) by then that drags carries the press on,
   * so the computer sees a double- or triple-click drag.
   */
  _holdClick(x, y, tx, ty) {
    this._button(0, true);
    this.ctx.ripple(x, y, 'left');
    this.held = { tx, ty, timer: setTimeout(() => this._letGo(), TAP_AGAIN_MS) };
  }

  /** The held click's release goes out now. */
  _letGo() {
    const h = this.held;
    if (!h) return;
    clearTimeout(h.timer);
    this.held = null;
    if (this.buttonDown) this._button(0, false);
  }

  /** Trackpad mode: the pointer follows a finger movement (dx, dy), gently accelerated (see ACCEL_*). */
  _glide(g, now, dx, dy) {
    const v = this.ctx.viewport;
    const dt = Math.max(1, now - (g.lastMoveT || now - 16));
    // Speed smoothed over the last few events: one jittery sample doesn't make the pointer surge or stall.
    const speed = Math.hypot(dx, dy) / dt;                 // px/ms
    g.speed = g.speed == null ? speed : g.speed * 0.6 + speed * 0.4;
    const ramp = Math.min(1, Math.max(0, (g.speed - ACCEL_FROM) / (ACCEL_TO - ACCEL_FROM)));
    const accel = ACCEL_MIN + (ACCEL_MAX - ACCEL_MIN) * ramp;
    const k = (this.ctx.prefs().pointerSpeed || 1) * accel / (v.encW * v.scale);
    this._moveTo(this.cursor.nx + dx * k, this.cursor.ny + dy * k);
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
      // Right after a tap, a touch near it carries the tap on (see TAP_AGAIN_MS). After a double tap its click is
      // still down: this touch decides whether it drags on (a double-click drag) or lets go.
      const near = this.mode === 'trackpad' ? 120 : DOUBLE_TAP_PX;
      let holding = false;
      if (this.held) {
        if (Math.hypot(e.clientX - this.held.tx, e.clientY - this.held.ty) < near) { clearTimeout(this.held.timer); holding = true; }
        else this._letGo();
      }
      const armedDrag = holding || (!!this.lastTap && now - this.lastTap.t < TAP_AGAIN_MS
        && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < near);
      this.g = { kind: 'pending', fingers: 1, start: now, armedDrag, holding, moved: false, holdFired: false, lastX: e.clientX, lastY: e.clientY };
      this.g.holdTimer = setTimeout(() => this._hold(), HOLD_MS);
    } else if (this.g) {
      clearTimeout(this.g.holdTimer);
      this._letGo(); // a double tap, then two fingers: the double click was all
      if (this.g.kind === 'drag' || this.g.kind === 'holddrag') {
        // A second finger during a drag: finish the drag first.
        if (this.buttonDown) this._button(0, false);
      }
      this.g.fingers = Math.max(this.g.fingers, this.touches.size);
      const c = this._centroid();
      if (this.g.kind !== 'pinch' && this.g.kind !== 'scroll' && this.g.kind !== 'pan3' && this.g.kind !== 'rightdrag') {
        if (this.g.kind !== 'multi-pending') {
          // Where the fingers came down; two of them again right after a two-finger tap: moving them is a
          // right-click drag.
          const l = this.lastTap2;
          this.g.ox = c.x; this.g.oy = c.y;
          this.g.armedRight = !!l && this.g.start - l.t < TAP_AGAIN_MS
            && Math.hypot(c.x - l.x, c.y - l.y) < (this.mode === 'trackpad' ? 120 : DOUBLE_TAP_PX * 2);
        }
        this.g.kind = 'multi-pending';
      }
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

    if (g.kind === 'rightdrag') {
      // The pointer follows the fingers (however many are still down), with the right button held.
      const c = this._centroid();
      const dx = c.x - g.cx, dy = c.y - g.cy;
      g.cx = c.x; g.cy = c.y;
      if (this.mode === 'trackpad') this._glide(g, now, dx, dy);
      else { const r = v.toRemote(c.x, c.y); this._moveTo(r.nx, r.ny); }
      g.lastMoveT = now;
      return;
    }

    if (this.touches.size === 1 && (g.kind === 'pending' || g.kind === 'move' || g.kind === 'drag' || g.kind === 'holddrag' || g.kind === 'pan')) {
      const dx = t.x - px, dy = t.y - py;
      if (g.kind === 'pending') {
        if (Math.hypot(t.x - t.sx, t.y - t.sy) < SLOP) return;
        clearTimeout(g.holdTimer);
        g.moved = true;
        if (g.holdFired || g.armedDrag) {
          g.kind = 'holddrag'; // hold, then drag; or double-tap (triple-tap) and hold, then drag
          if (this.mode === 'touch') { const r = v.toRemote(t.sx, t.sy); this._moveTo(r.nx, r.ny); }
          // After a double tap its click is still down: dragging that on is the double-click drag.
          if (g.holding) this.held = null;
          else this._pressToDrag(now, t.x - t.sx, t.y - t.sy);
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
      if (this.mode === 'trackpad') this._glide(g, now, dx, dy);
      else { const r = v.toRemote(t.x, t.y); this._moveTo(r.nx, r.ny); }
      g.lastMoveT = now;
      return;
    }

    if (this.touches.size >= 2 && !g.multiFrame) {
      g.multiFrame = requestAnimationFrame(() => {
        g.multiFrame = 0;
        if (g === this.g && this.touches.size >= 2) this._multiMove(g);
      });
    }
  }

  _multiMove(g) {
    const now = performance.now(), v = this.ctx.viewport;
    const c = this._centroid(), spread = this._spread();
    const dcx = c.x - g.cx, dcy = c.y - g.cy;
    if (g.kind === 'multi-pending') {
      // Each finger reports on its own, so halfway through a frame one finger has moved and the other not yet:
      // the centre seems to shift by half a pinch. Decide only once one kind of movement clearly leads.
      const moved = Math.hypot(dcx, dcy);
      const pinchDelta = Math.abs(spread - g.spread0);
      if (this.touches.size === 2 && pinchDelta > Math.max(6, Math.min(18, g.spread0 * 0.1)) && pinchDelta > moved) g.kind = 'pinch';
      else if (moved > SLOP * 2 && moved > pinchDelta * 1.2) g.kind = this.touches.size >= 3 ? 'pan3' : g.armedRight ? 'rightdrag' : 'scroll';
      else return;
      g.pinchSpread = g.spread0; g.pinchX = g.cx; g.pinchY = g.cy; // what the picture shows so far
      if (g.kind === 'scroll' && this.mode === 'touch') {
        const r = v.toRemote(g.cx, g.cy);
        this._moveTo(r.nx, r.ny);
      }
      if (g.kind === 'rightdrag') {
        // Two-finger double-tap and hold, then drag: the right button goes down where the pointer is (touch
        // mode: where the fingers came down), a few points along the drag from the right-click just before.
        if (this.mode === 'touch') { const r = v.toRemote(g.cx, g.cy); this._moveTo(r.nx, r.ny); }
        this._pressToDrag(now, dcx, dcy, 2);
        g.cx = c.x; g.cy = c.y; g.lastMoveT = now;
        return;
      }
    }
    if (g.kind === 'pinch') {
      this._applyPinch(g);
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

  _applyPinch(g) {
    const c = this._centroid(), spread = this._spread();
    const factor = g.pinchSpread > 0 && spread > 0 ? spread / g.pinchSpread : 1;
    this.ctx.pinch(factor, c.x, c.y, 'touch', c.x - g.pinchX, c.y - g.pinchY);
    g.pinchSpread = spread; g.pinchX = c.x; g.pinchY = c.y;
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
    const g = this.g;
    if (g?.multiFrame && this.touches.size >= 2) {
      cancelAnimationFrame(g.multiFrame);
      g.multiFrame = 0;
      this._multiMove(g);
    }
    this.touches.delete(e.pointerId);
    if (g?.kind === 'pinch' && this.touches.size < 2) this.ctx.endPinch();
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
          // A tap, then a hold that never dragged: the tap's click was all (a double tap's: it lets go now).
          this._letGo();
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
        if (dur > TAP_MS + 200 || (g.armedDrag && dur > TAP_MS)) {
          // A tap, then a touch held a moment that never dragged: the tap's click was all, not a slow double click.
          this._letGo();
          this.lastTap = null;
          return;
        }
        // A tap: a click (a double or triple click holds its press a moment: see _tapClick).
        this._letGo();
        this.lastTap2 = null;
        if (this.mode === 'trackpad') {
          const p = this._cursorClient();
          this._tapClick(now, p.x, p.y, t.sx, t.sy);
          this.lastTap = { t: now, x: t.sx, y: t.sy };
        } else {
          // Direct: a second tap near the first reuses its position so double-clicks register.
          let x = t.sx, y = t.sy;
          if (this.lastTap && now - this.lastTap.t < MULTI_CLICK_MS && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < DOUBLE_TAP_PX) {
            x = this.lastTap.x; y = this.lastTap.y;
          }
          const r = this.ctx.viewport.toRemote(x, y);
          this._moveTo(r.nx, r.ny);
          this._tapClick(now, x, y, x, y);
          this.lastTap = { t: now, x, y };
        }
        return;
      }
      case 'multi-pending':
        if (dur < TAP_MS + 150) {
          if (g.fingers === 2) {
            // The right-click goes where the fingers came down (touch mode), between them.
            const c = { x: g.ox, y: g.oy };
            if (this.mode === 'touch') { const r = this.ctx.viewport.toRemote(c.x, c.y); this._moveTo(r.nx, r.ny); }
            const p = this.mode === 'trackpad' ? this._cursorClient() : c;
            this._click(2, p.x, p.y, 'right');
            this.lastTap = null;
            this.lastTap2 = { t: now, x: c.x, y: c.y }; // two fingers again right after: a right-click drag
            return;
          } else if (g.fingers >= 3) {
            this.ctx.toggleKeyboard();
          }
        }
        this.lastTap = null;
        this.lastTap2 = null;
        return;
      case 'drag':
      case 'holddrag':
        if (this.buttonDown) this._button(0, false);
        this.lastTap = null;
        return;
      case 'rightdrag':
        if (this.rightDown) this._button(2, false);
        this.lastTap2 = null;
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
    if (this.touches.has(e.pointerId)) this.releaseAll();
  }

  releaseAll() {
    if (this.g?.kind === 'pinch') this.ctx.endPinch(true);
    if (this.g) {
      clearTimeout(this.g.holdTimer);
      if (this.g.multiFrame) cancelAnimationFrame(this.g.multiFrame);
    }
    this.g = this.lastTap = this.lastTap2 = this.lastPress = null;
    this.scrollAccX = this.scrollAccY = 0;
    if (this.held) { clearTimeout(this.held.timer); this.held = null; }
    if (this.buttonDown) this._button(0, false);
    if (this.rightDown) this._button(2, false);
    this.touches.clear();
    this._stopInertia();
  }
}
