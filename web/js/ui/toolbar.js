// Session toolbar (auto-hiding pill at the top) and its sheets.
import { h, svg, openSheet, closeSheet, sheetOpen, sheetItem, segmented, toast, fmtBytes } from './dom.js';
import { I } from './icons.js';
import { isTouchPrimary, isIPad, canFullscreen, isApple, hasKeyboardLock } from '../platform.js';
import { listFiles, uploadFile } from '../api.js';

export class Toolbar {
  constructor(session) {
    this.s = session;
    this.el = document.getElementById('toolbar');
    this.hideTimer = 0;
    this.hovering = false;
    this.el.addEventListener('pointerenter', () => { this.hovering = true; clearTimeout(this.hideTimer); });
    this.el.addEventListener('pointerleave', () => { this.hovering = false; this.peek(1500); });
    this.el.addEventListener('pointerdown', e => e.stopPropagation());
    this.refresh();
  }

  btn(icon, label, onClick, { pressed, danger, text } = {}) {
    const b = h('button', { class: 'tb' + (danger ? ' danger' : ''), type: 'button', title: label, 'aria-label': label, 'aria-pressed': pressed != null ? String(!!pressed) : null },
      svg(icon), text ? h('span', {}, text) : null);
    b.addEventListener('click', e => { e.stopPropagation(); onClick(e); this.peek(4000); });
    return b;
  }

  refresh() {
    const s = this.s;
    const items = [];
    items.push(this.btn(I.close, 'Disconnect', () => s.stop(), { danger: true }));
    items.push(h('span', { class: 'tb-sep' }));
    if (s.monitors.length > 1) {
      const cur = s.monitors.findIndex(m => m.id === s.monitorId);
      items.push(this.btn(I.monitor, 'Displays', () => this.displaysSheet(), { text: String(cur + 1) }));
    }
    if (isTouchPrimary || isIPad) {
      items.push(this.btn(I.keyboard, 'Keyboard', () => s.toggleKeyboard(), { pressed: s.softkbd?.open }));
      items.push(this.btn(s.inputMode === 'trackpad' ? I.trackpad : I.touch, s.inputMode === 'trackpad' ? 'Trackpad mode (tap to switch to touch)' : 'Touch mode (tap to switch to trackpad)',
        () => { s.setPref('inputMode', s.inputMode === 'trackpad' ? 'touch' : 'trackpad'); toast(s.inputMode === 'trackpad' ? 'Trackpad mode: slide to move, tap to click' : 'Touch mode: tap where you want to click'); }));
    }
    items.push(this.btn(I.keys, 'Extra keys', () => s.toggleExtraKeys(), { pressed: s.extraKeys?.visible }));
    items.push(this.btn(I.bolt, 'Shortcuts', () => this.specialSheet()));
    if (s.permissions.clipboard) items.push(this.btn(I.clipboard, 'Clipboard', () => this.clipboardSheet()));
    if (s.permissions.files) items.push(this.btn(I.files, 'Files', () => this.filesSheet()));
    if (s.permissions.audio && s.audio.supported) items.push(this.btn(s.prefs.audio ? I.sound : I.mute, s.prefs.audio ? 'Mute' : 'Unmute', () => s.setPref('audio', !s.prefs.audio)));
    if (canFullscreen()) items.push(this.btn(s.fullscreen ? I.exitFullscreen : I.fullscreen, s.fullscreen ? 'Exit full screen' : 'Full screen', () => s.toggleFullscreen()));
    items.push(this.btn(I.settings, 'Settings', () => this.settingsSheet()));
    this.el.replaceChildren(...items);
  }

  peek(ms = 3000) {
    this.el.classList.remove('hidden');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => { if (!this.hovering && !sheetOpen()) this.el.classList.add('hidden'); }, ms);
  }

  toggle() {
    if (this.el.classList.contains('hidden')) this.peek(6000); else this.el.classList.add('hidden');
  }

  _sheet(build) {
    clearTimeout(this.hideTimer);
    openSheet(build, { onClose: () => this.peek(1500) });
  }

  // ------------------------------------------------------------------ displays
  displaysSheet() {
    const s = this.s;
    this._sheet(el => {
      el.append(h('h3', {}, 'Displays'));
      s.monitors.forEach((m, i) => el.append(sheetItem(`${i + 1}. ${m.name}`, {
        sub: `${m.width}×${m.height}${m.refreshHz ? ` · ${Math.round(m.refreshHz)} Hz` : ''}${m.primary ? ' · main' : ''}`,
        active: m.id === s.monitorId,
        onClick: () => { s.selectMonitor(m.id); closeSheet(); },
      })));
      if (!isTouchPrimary) el.append(h('p', { class: 'muted small', style: { padding: '4px 12px' } }, 'Shortcut: Ctrl+Alt+Shift+1…9 or ←/→'));
    });
  }

  // ------------------------------------------------------------------ special keys
  specialSheet() {
    const s = this.s;
    const b = (label, action, title) => h('button', { type: 'button', title: title || label, onclick: () => { s.special(action); closeSheet(); } }, label);
    this._sheet(el => {
      el.append(h('h3', {}, 'Send keys'));
      el.append(h('div', { class: 'grid' },
        b('Ctrl+Alt+Del', 'cad'), b('Task Manager', 'taskmgr', 'Ctrl+Shift+Esc'), b('Lock', 'lock', 'Lock the remote computer'),
        b('Start (Win)', 'win'), b('Alt+Tab', 'alttab'), b('Task View', 'wintab', 'Win+Tab'),
        b('Show desktop', 'desktop', 'Win+D'), b('Explorer', 'explorer', 'Win+E'), b('Run…', 'run', 'Win+R'),
        b('Settings', 'settings', 'Win+I'), b('Snip', 'snip', 'Win+Shift+S'), b('PrtScn', 'prtsc'),
        b('Close app', 'altf4', 'Alt+F4'), b('Esc', 'esc'), b('Ctrl+Esc', 'ctrlesc')));
      if (!s.elevated) el.append(h('p', { class: 'muted small', style: { padding: '0 12px 6px' } },
        'Ctrl+Alt+Del and the lock/UAC screens need Headroom installed as a service on the host.'));
      el.append(h('h3', {}, 'Type text'));
      const ta = h('textarea', { class: 'local-input', placeholder: 'Text to type on the remote (useful at login screens)…' });
      el.append(h('div', { class: 'row' }, ta, h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px' } },
        h('button', { type: 'button', class: 'primary', onclick: () => { s.typeText(ta.value); closeSheet(); } }, 'Type it'))));
      if (!isTouchPrimary) {
        el.append(h('h3', {}, 'Mouse'));
        el.append(sheetItem(s.relative ? 'Release captured mouse' : 'Capture mouse (games / 3D apps)', {
          sub: 'Ctrl+Alt+Shift+R', onClick: () => { s.toggleRelativeMouse(); closeSheet(); },
        }));
      }
    });
  }

  // ------------------------------------------------------------------ clipboard
  clipboardSheet() {
    const s = this.s;
    this._sheet(el => {
      el.append(h('h3', {}, 'Remote clipboard'));
      const remote = h('textarea', { class: 'local-input', readonly: true }, s.clipboard.remote || '');
      el.append(h('div', { class: 'row' }, remote, h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
        h('button', {
          type: 'button', class: 'primary', onclick: async () => {
            try { await navigator.clipboard.writeText(s.clipboard.remote || ''); toast('Copied to this device'); }
            catch { remote.select(); document.execCommand?.('copy'); toast('Copied'); }
          },
        }, 'Copy to this device'),
        h('button', { type: 'button', onclick: () => s.conn.sendJson({ t: 'clip-get' }) }, 'Refresh'))));
      const onRemote = e => { remote.value = e.detail; };
      s.clipboard.addEventListener('remote', onRemote);
      el.append(h('h3', {}, 'Send to remote'));
      const local = h('textarea', { class: 'local-input', placeholder: 'Paste or type here…' });
      el.append(h('div', { class: 'row' }, local, h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
        h('button', { type: 'button', class: 'primary', onclick: () => { s.clipboard.lastPushed = null; s.clipboard.pushLocal(local.value); toast('Remote clipboard updated'); } }, 'Set remote clipboard'),
        h('button', { type: 'button', onclick: () => { s.typeText(local.value); closeSheet(); } }, 'Type it'),
        navigator.clipboard?.readText ? h('button', {
          type: 'button', onclick: async () => {
            try { local.value = await s.clipboard.readLocalExplicit(); toast('Sent this device\'s clipboard'); } catch { toast('Clipboard access was denied'); }
          },
        }, 'Send my clipboard') : null)));
    });
  }

  // ------------------------------------------------------------------ files
  filesSheet(path = '') {
    const s = this.s;
    const state = { path, entries: [], parent: null, error: null };
    let listEl, pathEl;
    const load = async p => {
      listEl.replaceChildren(h('p', { class: 'muted small', style: { padding: '8px 12px' } }, 'Loading…'));
      try {
        const r = await listFiles(s.host, p);
        Object.assign(state, { path: r.path, entries: r.entries, parent: r.parent, error: null });
      } catch (e) { state.error = e.message; }
      render();
    };
    const render = () => {
      pathEl.textContent = state.path || 'This PC';
      const rows = [];
      if (state.error) rows.push(h('p', { class: 'small', style: { color: 'var(--bad)', padding: '8px 12px' } }, state.error));
      if (state.path) rows.push(sheetItem(h('span', { class: 'file-row' }, svg(I.folderUp, 20), '..', ''), { onClick: () => load(state.parent || '') }));
      for (const e of state.entries) {
        rows.push(sheetItem(h('span', { class: 'file-row' }, svg(e.dir ? I.files : I.file, 20), e.name, ''), {
          sub: e.dir ? '' : fmtBytes(e.size),
          onClick: () => e.dir ? load(e.path) : this.download(e),
        }));
      }
      listEl.replaceChildren(...rows);
    };
    this._sheet(el => {
      const input = h('input', { type: 'file', multiple: true, hidden: true });
      input.addEventListener('change', () => { this.uploadFiles([...input.files], state.path); input.value = ''; });
      el.append(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        h('h3', {}, 'Files on ' + s.host.name),
        h('button', { type: 'button', class: 'tb', onclick: () => input.click(), title: 'Upload here' }, svg(I.upload), h('span', {}, 'Upload'))), input);
      pathEl = h('div', { class: 'files-path' });
      listEl = h('div');
      this.progressEl = h('div', { class: 'progress', hidden: true }, h('div'));
      el.append(pathEl, this.progressEl, listEl);
      load(path);
    });
  }

  download(entry) {
    const s = this.s;
    const id = Math.random().toString(36).slice(2);
    const onToken = e => {
      if (e.detail.id !== id && e.detail.path !== entry.path) return;
      s.conn.removeEventListener('file-token', onToken);
      const url = `${s.host.url}/api/files/download?t=${encodeURIComponent(e.detail.token)}`;
      const a = h('a', { href: url, download: entry.name, rel: 'noopener' });
      document.body.append(a); a.click(); a.remove();
      toast(`Downloading ${entry.name}`);
    };
    s.conn.addEventListener('file-token', onToken);
    s.conn.sendJson({ t: 'file-token', path: entry.path, id });
  }

  async uploadFiles(files, dir = '') {
    const s = this.s;
    for (const f of files) {
      toast(`Uploading ${f.name}…`, 60000);
      const bar = this.progressEl?.isConnected ? this.progressEl : null;
      if (bar) bar.hidden = false;
      try {
        const r = await uploadFile(s.host, f, dir, p => { if (bar) bar.firstChild.style.width = `${Math.round(p * 100)}%`; });
        toast(`Saved ${r.name || f.name} on ${s.host.name}${dir ? '' : ' (Downloads)'}`, 4000);
      } catch (e) {
        toast(`${f.name}: ${e.message}`, 5000);
      } finally {
        if (bar) { bar.hidden = true; bar.firstChild.style.width = '0'; }
      }
    }
  }

  // ------------------------------------------------------------------ settings
  settingsSheet() {
    const s = this.s, p = s.prefs;
    const row = (label, control) => h('div', {}, h('h3', {}, label), h('div', { class: 'row' }, control));
    this._sheet(el => {
      el.append(row('Scaling', segmented([
        { value: 'fit', label: 'Fit' }, { value: 'actual', label: '1:1' }, { value: 'fill', label: 'Fill' },
      ], p.scaling, v => s.setPref('scaling', v))));
      if (isTouchPrimary || isIPad) {
        el.append(row('Touch input', segmented([
          { value: 'trackpad', label: 'Trackpad' }, { value: 'touch', label: 'Direct touch' },
        ], s.inputMode, v => s.setPref('inputMode', v))));
      }
      el.append(row('Keyboard', segmented([
        { value: 'auto', label: 'Auto' },
        { value: 'mac', label: 'Mac shortcuts' },
        { value: 'pc', label: 'PC' },
        { value: 'cmdctrl', label: '⌘ = Ctrl' },
      ], p.keyboardProfile, v => s.setPref('keyboardProfile', v))));
      el.append(h('p', { class: 'muted small', style: { padding: '0 12px' } },
        isApple ? 'Mac shortcuts: ⌘C/V/X/Z/A/S/F… act as Ctrl, ⌘Q closes, ⌘ alone opens Start, ⌥←/→ jump words.' : 'PC: keys are sent exactly as pressed.',
        !hasKeyboardLock && !isTouchPrimary ? ' Tip: in Chrome/Edge full screen, Alt+Tab and the Windows key go to the remote too.' : ''));
      el.append(row('Frame rate', segmented([
        { value: 30, label: '30' }, { value: 60, label: '60' }, { value: 120, label: '120' }, { value: 144, label: '144' },
      ], p.maxFps, v => s.setPref('maxFps', v))));
      el.append(row('Bandwidth', segmented([
        { value: 0, label: 'Auto' }, { value: 5000, label: '5' }, { value: 12000, label: '12' }, { value: 25000, label: '25' }, { value: 50000, label: '50 Mb/s' },
      ], p.maxBitrateKbps, v => s.setPref('maxBitrateKbps', v))));
      el.append(row('Resolution', segmented([
        { value: 'native', label: 'Native' }, { value: '1440', label: '1440p' }, { value: '1080', label: '1080p' }, { value: '720', label: '720p' }, { value: 'device', label: 'This screen' },
      ], p.resolution, v => s.setPref('resolution', v))));
      if (isTouchPrimary) {
        el.append(row('Scrolling', segmented([
          { value: true, label: 'Natural' }, { value: false, label: 'Traditional' },
        ], p.naturalScroll !== false, v => s.setPref('naturalScroll', v))));
        el.append(row('Pointer speed', segmented([
          { value: 0.7, label: 'Slow' }, { value: 1, label: 'Normal' }, { value: 1.4, label: 'Fast' }, { value: 2, label: 'Faster' },
        ], p.pointerSpeed, v => s.setPref('pointerSpeed', v))));
      }
      el.append(row('Overlay', segmented([
        { value: false, label: 'Clean' }, { value: true, label: 'Show stats' },
      ], !!p.stats, v => s.setPref('stats', v))));
      el.append(row('Renderer', segmented([
        { value: 'auto', label: 'Auto' }, { value: 'video', label: 'Video' }, { value: 'canvas', label: 'Canvas' },
      ], p.renderer, v => { s.setPref('renderer', v); toast('Renderer applies on next connect'); })));
      el.append(h('p', { class: 'muted small', style: { padding: '8px 12px 4px' } },
        `Ctrl+Alt+Shift+M toggles this toolbar · F full screen · S stats · Q disconnect`));
    });
  }
}
