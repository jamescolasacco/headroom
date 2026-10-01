// Maps the remote desktop onto the window: fit / actual size / fill, plus pinch-zoom and pan.
// The stage element is sized in *encoded* pixels and transformed (GPU) — cheap at any zoom.

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
    this.cw = 0; this.ch = 0;        // available area
    this.insetBottom = 0;            // e.g. extra-keys bar height
    this.base = 1;
    window.addEventListener('resize', () => this.layout());
    window.visualViewport?.addEventListener('resize', () => this.layout());
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

  layout(keepCenter = true) {
    if (!this.encW) return;
    const vv = window.visualViewport;
    const rect = this.viewer.getBoundingClientRect();
    const fullH = vv ? Math.min(rect.height, vv.height) : rect.height;
    this.cw = rect.width;
    this.ch = Math.max(100, fullH - this.insetBottom);
    const dpr = window.devicePixelRatio || 1;
    const fit = Math.min(this.cw / this.encW, this.ch / this.encH);
    if (this.mode === 'actual') this.base = (this.srcW / this.encW) / dpr;
    else if (this.mode === 'fill') this.base = Math.max(this.cw / this.encW, this.ch / this.encH);
    else this.base = fit;
    if (!keepCenter) { this.ox = 0; this.oy = 0; }
    this._clamp();
    this._apply();
  }

  _clamp() {
    const w = this.encW * this.scale, h = this.encH * this.scale;
    // Smaller than the viewport: centre. Larger: keep edges covered.
    this.ox = w <= this.cw ? (this.cw - w) / 2 : Math.min(0, Math.max(this.cw - w, this.ox));
    this.oy = h <= this.ch ? (this.ch - h) / 2 : Math.min(0, Math.max(this.ch - h, this.oy));
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

  /** When zoomed, pan so the given remote point stays at least `margin` px inside the view. */
  follow(nx, ny, margin = 48) {
    if (!this.zoomed && this.mode === 'fit') return;
    const px = this.ox + nx * this.encW * this.scale, py = this.oy + ny * this.encH * this.scale;
    let dx = 0, dy = 0;
    if (px < margin) dx = margin - px; else if (px > this.cw - margin) dx = this.cw - margin - px;
    if (py < margin) dy = margin - py; else if (py > this.ch - margin) dy = this.ch - margin - py;
    if (dx || dy) this.panBy(dx, dy);
  }
}
