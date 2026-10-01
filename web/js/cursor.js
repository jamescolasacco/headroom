// Remote cursor rendering.
//  * "css" mode (a real mouse over the view): the local OS cursor *is* the remote cursor — we set its image
//    to the host's current shape, so it moves with zero latency and still looks right (I-beam, resize...).
//  * "overlay" mode (touch / pen / pointer-lock): we draw the shape at the remote position ourselves.

export class CursorRenderer {
  constructor(layer, overlayEl, viewport) {
    this.layer = layer;
    this.el = overlayEl;
    this.viewport = viewport;
    this.shapes = new Map();
    this.current = null;
    this.visible = true;
    this.mode = 'css';
    this.x = 0; this.y = 0;            // source-monitor px
    this.cssCache = new Map();
    viewport.addEventListener('change', () => { this._applyCss(); this._placeOverlay(); });
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this._applyCss();
    this._placeOverlay();
  }

  setShape({ id, w, h, hotX, hotY, rgba }) {
    let s = this.shapes.get(id);
    if (!s && rgba) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
      s = { id, w, h, hotX, hotY, canvas: c };
      this.shapes.set(id, s);
      if (this.shapes.size > 64) this.shapes.delete(this.shapes.keys().next().value);
    }
    if (!s) return;
    this.current = s;
    this.el.replaceChildren(s.canvas);
    this._applyCss();
    this._placeOverlay();
  }

  setPosition(x, y, visible) {
    this.x = x; this.y = y;
    if (visible !== this.visible) { this.visible = visible; this._applyCss(); }
    this._placeOverlay();
  }

  /** Remote cursor position as normalized coords. */
  get normalized() {
    const v = this.viewport;
    return { nx: v.srcW ? this.x / v.srcW : 0, ny: v.srcH ? this.y / v.srcH : 0 };
  }

  _applyCss() {
    if (this.mode !== 'css') { this.layer.style.cursor = 'none'; return; }
    if (!this.visible) { this.layer.style.cursor = 'none'; return; }
    const s = this.current;
    if (!s) { this.layer.style.cursor = 'default'; return; }
    const v = this.viewport;
    // Remote shape px -> on-screen CSS px: (source -> encoded) * view scale.
    const k = v.srcW ? (v.encW / v.srcW) * v.scale : 1;
    const dpr = window.devicePixelRatio || 1;
    let cssW = Math.max(1, Math.round(s.w * k)), cssH = Math.max(1, Math.round(s.h * k));
    const limit = 128;
    let f = 1;
    if (cssW > limit || cssH > limit) f = limit / Math.max(cssW, cssH);
    cssW = Math.round(cssW * f); cssH = Math.round(cssH * f);
    const key = `${s.id}:${cssW}x${cssH}@${dpr}`;
    let url = this.cssCache.get(key);
    if (!url) {
      const c = document.createElement('canvas');
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(s.canvas, 0, 0, c.width, c.height);
      url = c.toDataURL('image/png');
      this.cssCache.set(key, url);
      if (this.cssCache.size > 64) this.cssCache.delete(this.cssCache.keys().next().value);
    }
    const hx = Math.round(s.hotX * k * f), hy = Math.round(s.hotY * k * f);
    const st = this.layer.style;
    st.cursor = `url(${url}) ${hx} ${hy}, default`;
    if (dpr > 1) {
      // Crisp on HiDPI where supported (ignored otherwise, keeping the plain url above).
      st.cursor = `-webkit-image-set(url(${url}) ${dpr}x) ${hx} ${hy}, default`;
      st.cursor = `image-set(url(${url}) ${dpr}x) ${hx} ${hy}, default`;
    }
  }

  _placeOverlay() {
    const show = this.mode === 'overlay' && this.visible;
    this.el.hidden = !show;
    if (!show) return;
    const v = this.viewport;
    const s = this.current;
    const r = v.srcW ? v.encW / v.srcW : 1;  // source px -> stage (encoded) px
    const hx = s ? s.hotX : 0, hy = s ? s.hotY : 0;
    // The overlay lives inside the transformed stage; keep it a constant on-screen size by undoing zoom a bit.
    const minScreenScale = 0.55;
    const k = Math.max(r, minScreenScale / Math.max(v.scale, 0.0001));
    this.el.style.width = s ? `${s.w * k}px` : '0';
    this.el.style.height = s ? `${s.h * k}px` : '0';
    if (s) { s.canvas.style.width = '100%'; s.canvas.style.height = '100%'; }
    this.el.style.transform = `translate3d(${this.x * r - hx * k}px, ${this.y * r - hy * k}px, 0)`;
  }
}
