// Mouse / trackpad / pen (desktop browsers, and iPad with a pointing device).
import * as P from '../protocol.js';

const WHEEL_PER_PIXEL = 120 / 100;   // ~100 px of pixel-mode scrolling = one wheel notch
const WHEEL_PER_LINE = 40;           // 3 lines = one notch

export class MouseInput {
  /** @param {object} ctx { conn, viewport, cursor, layer, mods, keyboard, onUserGesture } */
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = false;
    this.buttons = new Set();
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
      leave: e => this._leave(e),
    };
  }

  attach() {
    const l = this.ctx.layer;
    l.addEventListener('pointermove', this.h.move);
    l.addEventListener('pointerdown', this.h.down);
    l.addEventListener('pointerup', this.h.up);
    l.addEventListener('pointercancel', this.h.up);
    l.addEventListener('pointerleave', this.h.leave);
    l.addEventListener('wheel', this.h.wheel, { passive: false });
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
    l.removeEventListener('pointerleave', this.h.leave);
    l.removeEventListener('wheel', this.h.wheel);
    l.removeEventListener('contextmenu', this.h.ctx);
    document.removeEventListener('pointerlockchange', this.h.lockChange);
    this.releaseAll();
    this.enabled = false;
  }

  _isMouse(e) { return e.pointerType === 'mouse' || e.pointerType === 'pen' || e.pointerType === ''; }

  // ------------------------------------------------------------------ movement

  _move(e) {
    if (!this._isMouse(e) || !this.ctx.inputAllowed()) return;
    if (e.pointerType === 'pen' && e.buttons === 0 && !this.buttons.size) { /* hover: still move */ }
    if (this.relative) {
      this.relAccX += e.movementX; this.relAccY += e.movementY;
      this._scheduleMove();
      return;
    }
    const { nx, ny } = this.ctx.viewport.toRemote(e.clientX, e.clientY);
    this.pendingMove = { nx, ny };
    this.ctx.cursor.setMode('css');
    this._scheduleMove();
  }

  /** Coalesce to ~250 Hz (gaming mice report 1000 Hz) and skip when the socket is backed up. */
  _scheduleMove() {
    if (this.moveTimer) return;
    const now = performance.now();
    const wait = Math.max(0, 4 - (now - this.lastMoveSent));
    this.moveTimer = setTimeout(() => {
      this.moveTimer = 0;
      if (this.ctx.conn.buffered > 256 * 1024) { this._scheduleMove(); return; }
      this.lastMoveSent = performance.now();
      if (this.relative) {
        const dx = Math.round(this.relAccX), dy = Math.round(this.relAccY);
        this.relAccX -= dx; this.relAccY -= dy;
        if (dx || dy) this.ctx.conn.sendBinary(P.mouseRel(dx, dy));
      } else if (this.pendingMove) {
        this.ctx.conn.sendBinary(P.mouseAbs(this.pendingMove.nx, this.pendingMove.ny));
        this.pendingMove = null;
      }
    }, wait);
  }

  _flushMove() {
    if (this.moveTimer) { clearTimeout(this.moveTimer); this.moveTimer = 0; }
    if (this.relative) {
      const dx = Math.round(this.relAccX), dy = Math.round(this.relAccY);
      this.relAccX = 0; this.relAccY = 0;
      if (dx || dy) this.ctx.conn.sendBinary(P.mouseRel(dx, dy));
    } else if (this.pendingMove) {
      this.ctx.conn.sendBinary(P.mouseAbs(this.pendingMove.nx, this.pendingMove.ny));
      this.pendingMove = null;
    }
    this.lastMoveSent = performance.now();
  }

  // ------------------------------------------------------------------ buttons

  _down(e) {
    if (!this._isMouse(e)) return;
    this.ctx.onUserGesture?.(e);
    this.ctx.sink?.focus({ preventScroll: true });
    if (!this.ctx.inputAllowed()) return;
    e.preventDefault();
    try { this.ctx.layer.setPointerCapture(e.pointerId); } catch { }
    if (!this.relative) {
      const { nx, ny } = this.ctx.viewport.toRemote(e.clientX, e.clientY);
      this.pendingMove = { nx, ny };
    }
    this._flushMove(); // position first, then the click lands exactly there
    const b = e.pointerType === 'pen' && e.button === 5 ? 2 : e.button; // pen eraser/barrel -> right
    if (b < 0 || b > 4) return;
    this.ctx.keyboard?.prepareClick();
    this.ctx.mods?.pressForClick();
    this.buttons.add(b);
    this.ctx.conn.sendBinary(P.mouseButton(b, true));
  }

  _up(e) {
    if (!this._isMouse(e)) return;
    const b = e.pointerType === 'pen' && e.button === 5 ? 2 : e.button;
    if (e.type === 'pointercancel') { this.releaseAll(); return; }
    if (!this.buttons.has(b)) return;
    e.preventDefault();
    this._flushMove();
    this.buttons.delete(b);
    this.ctx.conn.sendBinary(P.mouseButton(b, false));
    this.ctx.mods?.releaseAfterClick();
  }

  _leave(e) {
    // Leaving the window while dragging keeps capture; nothing to do. Restore OS cursor otherwise.
    if (!this.buttons.size && this._isMouse(e)) { /* keep remote shape */ }
  }

  releaseAll() {
    for (const b of this.buttons) this.ctx.conn.sendBinary(P.mouseButton(b, false));
    this.buttons.clear();
  }

  // ------------------------------------------------------------------ wheel

  _wheel(e) {
    if (!this.ctx.inputAllowed()) return;
    e.preventDefault();
    let dx = e.deltaX, dy = e.deltaY;
    const k = e.deltaMode === 1 ? WHEEL_PER_LINE : e.deltaMode === 2 ? 120 * 3 : WHEEL_PER_PIXEL;
    // Browser: +deltaY = content moves up (scroll down). Windows: +wheel = scroll up.
    this.wheelAccY += -dy * k;
    this.wheelAccX += dx * k;
    // Trackpad pinch arrives as ctrl+wheel without a real Ctrl key: send Ctrl so apps zoom.
    const syntheticCtrl = e.ctrlKey && !this.ctx.keyboard?.down.has('ControlLeft') && !this.ctx.keyboard?.down.has('ControlRight');
    const sx = Math.trunc(this.wheelAccX), sy = Math.trunc(this.wheelAccY);
    if (!sx && !sy) return;
    this.wheelAccX -= sx; this.wheelAccY -= sy;
    if (!this.relative) {
      const { nx, ny } = this.ctx.viewport.toRemote(e.clientX, e.clientY);
      this.pendingMove = { nx, ny };
      this._flushMove();
    }
    if (syntheticCtrl) this.ctx.conn.sendBinary(P.key('ControlLeft', true));
    this.ctx.conn.sendBinary(P.wheel(sx, sy));
    if (syntheticCtrl) this.ctx.conn.sendBinary(P.key('ControlLeft', false));
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
    this.relative = document.pointerLockElement === this.ctx.layer;
    this.ctx.cursor.setMode(this.relative ? 'overlay' : 'css');
    this.ctx.onRelativeChange?.(this.relative);
  }
}
