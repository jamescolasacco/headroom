// Maps the remote desktop onto the window: fit / actual size / fill, plus pinch-zoom and pan.
// The stage element is sized in *encoded* pixels and transformed (GPU) — cheap at any zoom.
//
// The picture lives between `insetTop` (a pinned toolbar) and `insetBottom` (the extra-keys bar). While the
// on-screen keyboard is up the visible area shrinks, but the picture keeps its size and pans instead (so the
// part you're typing into stays readable); the session calls layout() when the visible area changes.

export class Viewport extends EventTarget {
  constructor(viewer, stage) {
    super();
    this.viewer = viewer;
    this.stage = stage;
    this.encW = 0; this.encH = 0;    // decoded frame size
    this.srcW = 0; this.srcH = 0;    // host monitor size (input coordinates)
    this.mode = 'fit';
    this.zoom = 1;                   // user zoom on top of the mode's base scale
    this.ox = 0; this.oy = 0;        // stage offset in viewer CSS px
    this.cw = 0; this.ch = 0;        // the picture's area (between the insets)
    this.insetTop = 0;               // a pinned toolbar
    this.insetBottom = 0;            // the extra-keys bar
    this.keyboard = false;           // the on-screen keyboard is up
    this.restW = 0; this.restH = 0;  // the picture's area the last time the keyboard was down
    this.base = 1;
  }

  get scale() { return this.base * this.zoom; }
  get zoomed() { return this.zoom > 1.01; }

  setSizes(encW, encH, srcW, srcH) {
    const changed = encW !== this.encW || encH !== this.encH;
    this.encW = encW; this.encH = encH; this.srcW = srcW || encW; this.srcH = srcH || encH;
    this.stage.style.width = `${encW}px`;
    this.stage.style.height = `${encH}px`;
    if (changed) { this.zoom = 1; }
    this.layout();
  }

  setMode(mode) {
    this.mode = mode;
    this.zoom = 1;
    this.layout();
  }

  setInsetBottom(px) {
    if (Math.abs(px - this.insetBottom) < 1) return;
    this.insetBottom = px;
    this.viewer.style.setProperty('--inset-bottom', `${px}px`);
    this.layout();
  }

  setInsetTop(px) {
    if (Math.abs(px - this.insetTop) < 1) return;
    this.insetTop = px;
    this.layout();
  }

  /** The on-screen keyboard came up or went away (set before the visible area changes). */
  setKeyboard(open) {
    if (open === this.keyboard) return;
    this.keyboard = open;
    this.layout();
  }

  layout(keepCenter = true) {
    if (!this.encW) return;
    const rect = this.viewer.getBoundingClientRect(); // the session follows the visible area (session.js)
    this.cw = rect.width;
    this.ch = Math.max(60, rect.height - this.insetTop - this.insetBottom);
    // Fit to the area as it is without the keyboard: when it comes up the picture keeps its size and pans.
    if (!this.keyboard || !this.restH || Math.abs(this.restW - this.cw) > 1) { this.restW = this.cw; this.restH = this.ch; }
    const fitH = this.keyboard ? Math.max(this.ch, this.restH) : this.ch;
    const dpr = window.devicePixelRatio || 1;
    const fit = Math.min(this.cw / this.encW, fitH / this.encH);
    if (this.mode === 'actual') this.base = (this.srcW / this.encW) / dpr;
    else if (this.mode === 'fill') this.base = Math.max(this.cw / this.encW, fitH / this.encH);
    else this.base = fit;
    if (!keepCenter) { this.ox = 0; this.oy = this.insetTop; }
    this._clamp();
    this._apply();
  }

  _clamp() {
    const w = this.encW * this.scale, h = this.encH * this.scale, top = this.insetTop;
    // Smaller than the area: centre. Larger: keep its edges covered (never under the toolbar or the bar).
    this.ox = w <= this.cw + 0.5 ? (this.cw - w) / 2 : Math.min(0, Math.max(this.cw - w, this.ox));
    this.oy = h <= this.ch + 0.5 ? top + (this.ch - h) / 2 : Math.min(top, Math.max(top + this.ch - h, this.oy));
  }

  _apply() {
    this.stage.style.transform = `translate3d(${this.ox}px, ${this.oy}px, 0) scale(${this.scale})`;
    this.dispatchEvent(new Event('change'));
  }

  /** Multiply zoom around a viewer-space point (pinch centre). */
  zoomAt(factor, cx, cy) {
    const old = this.scale;
    const maxZoom = Math.max(1, 4 / this.base);
    this.zoom = Math.min(Math.max(1, this.zoom * factor), Math.max(maxZoom, 1));
    const s = this.scale;
    this.ox = cx - (cx - this.ox) * (s / old);
    this.oy = cy - (cy - this.oy) * (s / old);
    this._clamp();
    this._apply();
  }

  panBy(dx, dy) {
    this.ox += dx; this.oy += dy;
    this._clamp();
    this._apply();
  }

  /** Zoom and pan in one step (a pinch frame), so the picture is redrawn once. */
  pinch(factor, cx, cy, dx, dy) {
    const old = this.scale;
    const maxZoom = Math.max(1, 4 / this.base);
    this.zoom = Math.min(Math.max(1, this.zoom * factor), Math.max(maxZoom, 1));
    const s = this.scale;
    this.ox = cx - (cx - this.ox) * (s / old) + dx;
    this.oy = cy - (cy - this.oy) * (s / old) + dy;
    this._clamp();
    this._apply();
  }

  resetZoom() { this.zoom = 1; this.layout(); }

  /** Viewer client coords -> normalized remote coords (0..1). */
  toRemote(clientX, clientY) {
    const r = this.viewer.getBoundingClientRect();
    const x = (clientX - r.left - this.ox) / (this.encW * this.scale);
    const y = (clientY - r.top - this.oy) / (this.encH * this.scale);
    return { nx: Math.min(1, Math.max(0, x)), ny: Math.min(1, Math.max(0, y)), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
  }

  /** Normalized remote -> viewer client coords. */
  fromRemote(nx, ny) {
    const r = this.viewer.getBoundingClientRect();
    return { x: r.left + this.ox + nx * this.encW * this.scale, y: r.top + this.oy + ny * this.encH * this.scale };
  }

  /** When the picture is bigger than its area, pan so the given remote point stays `margin` px inside it. */
  follow(nx, ny, margin = 48) {
    const w = this.encW * this.scale, h = this.encH * this.scale;
    if (w <= this.cw + 0.5 && h <= this.ch + 0.5) return; // all of it is showing
    const top = this.insetTop;
    const px = this.ox + nx * w, py = this.oy + ny * h;
    const mx = Math.min(margin, this.cw / 3), my = Math.min(margin, this.ch / 3);
    let dx = 0, dy = 0;
    if (px < mx) dx = mx - px; else if (px > this.cw - mx) dx = this.cw - mx - px;
    if (py < top + my) dy = top + my - py; else if (py > top + this.ch - my) dy = top + this.ch - my - py;
    if (dx || dy) this.panBy(dx, dy);
  }
}
