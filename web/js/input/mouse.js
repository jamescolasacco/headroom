// Mouse / trackpad / pen (desktop browsers, and iPad with a pointing device).
import * as P from '../protocol.js';

const WHEEL_PER_PIXEL = 120 / 100;   // ~100 px of pixel-mode scrolling = one wheel notch
const WHEEL_PER_LINE = 40;           // 3 lines = one notch

// A 15% change in finger spacing is one zoom step in an application with discrete wheel zoom.
const ZOOM_STEP = Math.log(1.15);
const BUTTON_MASK = [1, 4, 2, 8, 16];

export class MouseInput {
  /** @param {object} ctx { conn, viewport, cursor, layer, mods, keyboard, onUserGesture } */
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = false;
    this.buttons = new Set();
    this.pointerId = null;
    this.zoomRemainder = 0;
    this.lastPinch = -Infinity;
    this.gestureScale = null;
    this.nativePinch = null;
    this.touchScale = 1;
    this.contactsDown = false;
    this.pinchTimer = 0;
    this.wheelAccX = 0;
    this.wheelAccY = 0;
    this.lastMoveSent = 0;
    this.pendingMove = null;
    this.moveTimer = 0;
    this.relative = false;            // pointer-lock mode
    this.relAccX = 0; this.relAccY = 0;
    this.h = {
      move: e => this._move(e), down: e => this._down(e), up: e => this._up(e),
      wheel: e => this._wheel(e), ctx: e => e.preventDefault(), lockChange: () => this._lockChange(),
      lost: e => { if (this.pointerId === e.pointerId) this.releaseAll(); },
      blur: () => this.releaseAll(),
      gestureStart: e => this._gestureStart(e), gestureChange: e => this._gestureChange(e),
      gestureEnd: e => { if (this.gestureScale !== null) { this._gestureChange(e); this.endPinch(); } this.gestureScale = null; },
      aux: e => { if (e.button > 0) e.preventDefault(); },
      // A pinch (Ctrl+wheel) anywhere else in the session — the toolbar, the overlay, a toast, the screen's opening
      // transition — must not zoom the page: it stays zoomed, and Auto resolution then lowers the stream to match.
      pageZoom: e => { if (e.ctrlKey && !e.defaultPrevented) e.preventDefault(); },
    };
  }

  attach() {
    const l = this.ctx.layer;
    l.addEventListener('pointermove', this.h.move);
    l.addEventListener('pointerdown', this.h.down);
    l.addEventListener('pointerup', this.h.up);
    l.addEventListener('pointercancel', this.h.up);
    l.addEventListener('lostpointercapture', this.h.lost);
    l.addEventListener('auxclick', this.h.aux);
    l.addEventListener('gesturestart', this.h.gestureStart, { passive: false });
    l.addEventListener('gesturechange', this.h.gestureChange, { passive: false });
    l.addEventListener('gestureend', this.h.gestureEnd, { passive: false });
    window.addEventListener('blur', this.h.blur);
    l.addEventListener('wheel', this.h.wheel, { passive: false });
    window.addEventListener('wheel', this.h.pageZoom, { passive: false });
    l.addEventListener('contextmenu', this.h.ctx);
    document.addEventListener('pointerlockchange', this.h.lockChange);
    this.enabled = true;
  }

  detach() {
    const l = this.ctx.layer;
    l.removeEventListener('pointermove', this.h.move);
    l.removeEventListener('pointerdown', this.h.down);
    l.removeEventListener('pointerup', this.h.up);
    l.removeEventListener('pointercancel', this.h.up);
    l.removeEventListener('lostpointercapture', this.h.lost);
    l.removeEventListener('auxclick', this.h.aux);
    l.removeEventListener('gesturestart', this.h.gestureStart, { passive: false });
    l.removeEventListener('gesturechange', this.h.gestureChange, { passive: false });
    l.removeEventListener('gestureend', this.h.gestureEnd, { passive: false });
    window.removeEventListener('blur', this.h.blur);
    l.removeEventListener('wheel', this.h.wheel);
    window.removeEventListener('wheel', this.h.pageZoom, { passive: false });
    l.removeEventListener('contextmenu', this.h.ctx);
    document.removeEventListener('pointerlockchange', this.h.lockChange);
    this.releaseAll();
    this.enabled = false;
  }

  _isMouse(e) { return e.pointerType === 'mouse' || e.pointerType === 'pen' || e.pointerType === ''; }

  // ------------------------------------------------------------------ movement

  _move(e) {
    if (!this._isMouse(e) || !this.ctx.inputAllowed()) return;
    if (this.pointerId !== null && this.pointerId !== e.pointerId) return;
    if (this.relative) {
      this.relAccX += e.movementX; this.relAccY += e.movementY;
    } else {
      this.pendingMove = this.ctx.viewport.toRemote(e.clientX, e.clientY);
      this.ctx.cursor.setMode('css');
    }
    // Pointer Events report intermediate presses and releases in a mouse chord as moves.
    if (this.pointerId === e.pointerId && Number.isInteger(e.buttons)) {
      this._syncButtons(e);
    }
    this._scheduleMove();
  }

  /** Coalesce to ~250 Hz (gaming mice report 1000 Hz) and skip when the socket is backed up. */
  _scheduleMove() {
    if (this.moveTimer) return;
    const now = performance.now();
    const wait = this.ctx.conn.buffered > 256 * 1024 ? 16 : Math.max(0, 4 - (now - this.lastMoveSent));
    this.moveTimer = setTimeout(() => {
      this.moveTimer = 0;
      if (!this.ctx.inputAllowed()) { this.releaseAll(); return; }
      if (this.ctx.conn.buffered > 256 * 1024) { this._scheduleMove(); return; }
      this._flushMove();
    }, wait);
  }

  _flushMove() {
    if (this.moveTimer) { clearTimeout(this.moveTimer); this.moveTimer = 0; }
    if (this.relative) {
      let dx = Math.round(this.relAccX), dy = Math.round(this.relAccY);
      this.relAccX -= dx; this.relAccY -= dy;
      // Long backlogs can exceed one signed 16-bit packet. Preserve the total and direction.
      const parts = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 32767);
      for (let left = parts; left > 0; left--) {
        const x = Math.round(dx / left), y = Math.round(dy / left);
        this.ctx.conn.sendBinary(P.mouseRel(x, y));
        dx -= x; dy -= y;
      }
    } else if (this.pendingMove) {
      this.ctx.conn.sendBinary(P.mouseAbs(this.pendingMove.nx, this.pendingMove.ny));
      this.pendingMove = null;
    }
    this.lastMoveSent = performance.now();
  }

  // ------------------------------------------------------------------ buttons

  _down(e) {
    if (e.pointerType === 'touch') this.gestureScale = null;
    if (!this._isMouse(e)) return;
    this.ctx.onUserGesture?.(e);
    this.ctx.sink?.focus({ preventScroll: true });
    if (!this.ctx.inputAllowed() || (this.pointerId !== null && this.pointerId !== e.pointerId)) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    try { this.ctx.layer.setPointerCapture(e.pointerId); } catch { }
    if (!this.relative) this.pendingMove = this.ctx.viewport.toRemote(e.clientX, e.clientY);
    this._syncButtons(e);
  }

  _up(e) {
    if (!this._isMouse(e) || this.pointerId !== e.pointerId) return;
    if (e.type === 'pointercancel') { this.releaseAll(); return; }
    e.preventDefault();
    if (!this.relative) this.pendingMove = this.ctx.viewport.toRemote(e.clientX, e.clientY);
    this._syncButtons(e);
    if (!this.buttons.size) this.pointerId = null;
  }

  _syncButtons(e) {
    for (let b = 0; b < BUTTON_MASK.length; b++) {
      const down = !!(e.buttons & BUTTON_MASK[b]) || (b === 2 && e.pointerType === 'pen' && !!(e.buttons & 32));
      if (down === this.buttons.has(b)) continue;
      this._flushMove();
      if (down) {
        this.ctx.keyboard?.prepareClick();
        this.ctx.mods?.pressForClick();
        this.ctx.onPress?.();
        this.buttons.add(b);
      } else {
        this.buttons.delete(b);
      }
      this.ctx.conn.sendBinary(P.mouseButton(b, down));
      if (!down && this.buttons.size === 0) this.ctx.mods?.releaseAfterClick();
    }
  }

  releaseAll() {
    this.endPinch(true);
    clearTimeout(this.moveTimer);
    this.moveTimer = 0;
    this.pendingMove = null;
    this.relAccX = this.relAccY = this.wheelAccX = this.wheelAccY = 0;
    this.gestureScale = this.nativePinch = null;
    this.zoomRemainder = 0;
    this.lastPinch = -Infinity;
    this.pointerId = null;
    for (const b of this.buttons) this.ctx.conn.sendBinary(P.mouseButton(b, false));
    if (this.buttons.size) this.ctx.mods?.releaseAfterClick();
    this.buttons.clear();
  }

  // ------------------------------------------------------------------ wheel and magnification

  _wheel(e) {
    e.preventDefault();
    // Read deltaMode first: browsers may change the units they return on first access.
    const mode = e.deltaMode;
    if (e.ctrlKey && !this.ctx.keyboard?.physicalControls.size && mode === 0) {
      if (this.gestureScale === null && this.nativePinch === null && !this.ctx.touchActive?.()) {
        this.pinch(Math.exp(-e.deltaY / 100), e.clientX, e.clientY);
      }
      return;
    }
    if (!this.ctx.inputAllowed()) return;
    const k = mode === 1 ? WHEEL_PER_LINE : mode === 2 ? 360 : WHEEL_PER_PIXEL;
    this.wheelAccY -= e.deltaY * k;
    this.wheelAccX += e.deltaX * k;
    const sx = Math.trunc(this.wheelAccX), sy = Math.trunc(this.wheelAccY);
    if (!sx && !sy) return;
    this.wheelAccX -= sx; this.wheelAccY -= sy;
    this.ctx.keyboard?.prepareClick();
    this._sendWheel(sx, sy, e.clientX, e.clientY, e.ctrlKey && !this.ctx.keyboard?.physicalControls.size);
  }

  _sendWheel(dx, dy, x, y, ctrl, count = 1) {
    if (!this.relative) this.pendingMove = this.ctx.viewport.toRemote(x, y);
    this._flushMove();
    const press = ctrl && !this.ctx.keyboard?.down.has('ControlLeft') && !this.ctx.keyboard?.down.has('ControlRight');
    if (press) this.ctx.conn.sendBinary(P.key('ControlLeft', true));
    for (let i = 0; i < count; i++) this.ctx.conn.sendBinary(P.wheel(dx, dy));
    if (press) this.ctx.conn.sendBinary(P.key('ControlLeft', false));
  }

  _gestureStart(e) {
    if (this.ctx.touchActive?.() || this.nativePinch !== null) return;
    e.preventDefault();
    this.endPinch(true);
    this.gestureScale = 1;
    this._gestureChange(e);
  }

  _gestureChange(e) {
    if (this.gestureScale === null || this.ctx.touchActive?.()) return;
    e.preventDefault();
    if (!Number.isFinite(e.scale) || e.scale <= 0) return;
    this.pinch(e.scale / this.gestureScale, e.clientX, e.clientY);
    this.gestureScale = e.scale;
  }

  nativeMagnify(m) {
    const x = m.x * window.innerWidth, y = m.y * window.innerHeight;
    if (m.phase === 'begin' || this.nativePinch === null) {
      this.endPinch(true);
      this.nativePinch = this.ctx.layer.contains(document.elementFromPoint(x, y));
    }
    if (this.nativePinch && m.phase !== 'cancel') this.pinch(m.factor, x, y);
    if (m.phase === 'end' || m.phase === 'cancel') {
      this.endPinch(m.phase === 'cancel');
      this.nativePinch = null;
    }
  }

  pinch(factor, x, y, source = 'trackpad', dx = 0, dy = 0) {
    if (!(factor > 0) || ![factor, x, y].every(Number.isFinite)) return;
    const target = this.ctx.pinchTarget(source);
    if (!this.ctx.inputAllowed() || target === 'viewer') {
      const r = this.ctx.layer.getBoundingClientRect();
      this.ctx.viewport.pinch(factor, x - r.left, y - r.top, dx, dy);
      return;
    }
    if (target === 'touch') {
      this.touchScale = Math.min(12, Math.max(0.05, this.touchScale * factor));
      if (source === 'trackpad' && this.gestureScale === null && this.nativePinch === null) {
        clearTimeout(this.pinchTimer);
        this.pinchTimer = setTimeout(() => this.endPinch(), 250);
      }
      if (!this.contactsDown && Math.abs(Math.log(this.touchScale)) < 0.025) return;
      const { nx, ny } = this.ctx.viewport.toRemote(x, y);
      if (!this.contactsDown) {
        this.ctx.conn.sendBinary(P.touchPinch(0, nx, ny, 1));
        this.contactsDown = true;
      }
      this.ctx.conn.sendBinary(P.touchPinch(1, nx, ny, this.touchScale));
      return;
    }
    const now = performance.now();
    if (source === 'trackpad' && this.gestureScale === null && this.nativePinch === null && now - this.lastPinch > 300) this.zoomRemainder = 0;
    this.lastPinch = now;
    this.zoomRemainder += Math.log(factor) / ZOOM_STEP;
    // Logarithms of successive scale ratios can leave an exact return step a few ulps short.
    const steps = Math.trunc(this.zoomRemainder + Math.sign(this.zoomRemainder) * 1e-10);
    if (!steps) return;
    this.zoomRemainder -= steps;
    const count = Math.min(16, Math.abs(steps));
    if (this.ctx.keyboard?.macHost) {
      if (!this.relative) this.pendingMove = this.ctx.viewport.toRemote(x, y);
      this._flushMove();
      for (let i = 0; i < count; i++) this.ctx.keyboard.chord(['MetaLeft', steps > 0 ? 'Equal' : 'Minus']);
    } else {
      this._sendWheel(0, 120 * Math.sign(steps), x, y, true, count);
    }
  }

  endPinch(cancel = false) {
    clearTimeout(this.pinchTimer);
    if (this.contactsDown) this.ctx.conn.sendBinary(P.touchPinch(cancel ? 3 : 2));
    this.contactsDown = false;
    this.touchScale = 1;
    this.zoomRemainder = 0;
  }

  // ------------------------------------------------------------------ pointer lock (relative / games)

  async setRelative(on) {
    const l = this.ctx.layer;
    if (on) {
      try {
        // unadjustedMovement = raw deltas (no OS acceleration) where supported.
        await l.requestPointerLock({ unadjustedMovement: true });
      } catch {
        try { await l.requestPointerLock(); } catch (e) { console.warn('pointer lock failed', e); return false; }
      }
      return true;
    }
    if (document.pointerLockElement) document.exitPointerLock();
    return true;
  }

  _lockChange() {
    this.releaseAll();
    this.relative = document.pointerLockElement === this.ctx.layer;
    this.ctx.cursor.setMode(this.relative ? 'overlay' : 'css');
    this.ctx.onRelativeChange?.(this.relative);
  }
}
