// Performance overlay (Ctrl+Alt+Shift+S). Shows the whole pipeline: capture/encode on the host,
// network, decode on this device, plus what the bitrate controller is doing.

export class StatsOverlay {
  constructor(el, session) {
    this.el = el;
    this.s = session;
    this.timer = 0;
    this.lastBytes = 0;
    this.lastT = performance.now();
  }

  setVisible(on) {
    this.el.hidden = !on;
    clearInterval(this.timer);
    if (on) { this.render(); this.timer = setInterval(() => this.render(), 500); }
  }

  render() {
    const s = this.s, c = s.conn, cfg = s.videoConfig, hs = s.hostStats || {}, ds = s.presenter?.lastStats || {};
    const now = performance.now();
    const bytes = c?.bytesIn || 0;
    const kbps = ((bytes - this.lastBytes) * 8) / Math.max(1, now - this.lastT);
    this.lastBytes = bytes; this.lastT = now;
    const f = s.frameStats;
    const rtt = c?.rttMs || 0;
    const est = (f.encodeMs || 0) + rtt / 2 + (f.receiveMs || 0) + (ds.decodeMs || 0);
    const lines = [
      cfg ? `${cfg.width}×${cfg.height}${cfg.sourceWidth !== cfg.width ? ` (from ${cfg.sourceWidth}×${cfg.sourceHeight})` : ''}  ${s.presenter.fps} fps` : 'waiting for video…',
      `${(kbps / 1000).toFixed(1)} Mb/s   target ${((hs.targetKbps || 0) / 1000).toFixed(1)}`,
      `rtt ${rtt.toFixed(1)} ms   frame rtt ${(hs.frameRttMs || 0).toFixed(1)}`,
      `encode ${(f.encodeMs || 0).toFixed(1)}  net ${(f.receiveMs || 0).toFixed(1)}  decode ${(ds.decodeMs || 0).toFixed(1)} ms`,
      `≈ ${est.toFixed(0)} ms + display`,
      cfg ? `${cfg.codec}  ${cfg.encoder}${cfg.hardware ? '' : ' (software)'}` : '',
      `${s.presenter?.mode || ''}  dropped ${ds.dropped || 0}  queue ${ds.queue || 0}${ds.hw && ds.hw !== 'no-preference' ? '  ' + ds.hw : ''}`,
    ];
    this.el.textContent = lines.filter(Boolean).join('\n');
  }

  dispose() { clearInterval(this.timer); }
}
