// Session toolbar and its sheets. With a mouse it's a pill at the top that hides by itself (it comes back at the
// top edge); on touch screens it stays put, since that's where the keyboard is, and can be folded to a small tab.
import { h, svg, openSheet, closeSheet, sheetOpen, sheetItem, segmented, toast, fmtBytes } from './dom.js';
import { I } from './icons.js';
import { isTouchPrimary, isIPad, canFullscreen, isApple, hasKeyboardLock } from '../platform.js';
import { listFiles, uploadFile } from '../api.js';

const FOLD = '<path d="m6 15 6-6 6 6"/>';
const UNFOLD = '<path d="m6 9 6 6 6-6"/>';
const MORE = '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>';
const NARROW = 560; // narrower than this (a phone held upright): the bar keeps the everyday tools, the rest go under More

export class Toolbar {
  constructor(session) {
    this.s = session;
    this.el = document.getElementById('toolbar');
    this.hideTimer = 0;
    this.hovering = false;
    this.touchUi = isTouchPrimary || isIPad;
    this.el.classList.toggle('pinned', this.touchUi);
    document.getElementById('toolbar-handle').hidden = this.touchUi; // the folded tab takes its place
    this.el.addEventListener('pointerenter', () => { this.hovering = true; clearTimeout(this.hideTimer); });
    this.el.addEventListener('pointerleave', () => { this.hovering = false; this.peek(1500); });
    this.el.addEventListener('pointerdown', e => {
      e.stopPropagation();
      // A tap here mustn't take focus from the remote keyboard (that would close the on-screen keyboard).
      if (e.pointerType === 'touch') e.preventDefault();
    });
    // Keyboard: Ctrl+Alt+Shift+M focuses the toolbar; arrows move along it, Escape goes back to the remote screen.
    this.el.addEventListener('focusin', () => { clearTimeout(this.hideTimer); this.el.classList.remove('hidden'); this.el.inert = false; });
    this.el.addEventListener('focusout', e => { if (!this.dismissing && !this.el.contains(e.relatedTarget)) this.peek(1500); });
    this.el.addEventListener('keydown', e => this._key(e));
    // Its focus ring shows when you arrive from the keyboard, even the first time (not after a tap or click).
    this.el.addEventListener('pointerdown', () => this.el.classList.remove('kbd'), true);
    this.refresh();
  }

  _key(e) {
    const buttons = [...this.el.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape' && sheetOpen()) {
      // A sheet is open (its button is focused here): Escape closes the sheet first.
      e.preventDefault();
      e.stopPropagation();
      closeSheet();
    } else if (e.key === 'Escape' || (e.code === 'KeyM' && e.ctrlKey && e.altKey && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      this.el.classList.remove('kbd');
      this.dismissing = true; // leaving with Escape hides it now, without the usual peek
      document.getElementById('kbd-sink')?.focus({ preventScroll: true });
      this.dismissing = false;
      clearTimeout(this.hideTimer);
      if (this.touchUi) return; // a pinned bar stays where it is
      this.el.classList.add('hidden');
      this.el.inert = true;
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && i >= 0) {
      e.preventDefault();
      buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length].focus();
    }
  }

  btn(icon, label, onClick, { pressed, danger, text } = {}) {
    const b = h('button', { class: 'tb' + (danger ? ' danger' : ''), type: 'button', title: label, 'aria-label': label, 'aria-pressed': pressed != null ? String(!!pressed) : null },
      svg(icon), text ? h('span', {}, text) : null);
    b.addEventListener('click', e => { e.stopPropagation(); onClick(e); this.peek(4000); });
    return b;
  }

  /** Touch screens: folded away to a small tab (the person's choice, kept for this computer). */
  get collapsed() { return this.touchUi && !!this.s.prefs.toolbarCollapsed; }
  narrow() { return (this.s.viewport?.cw || window.innerWidth) < NARROW; }

  setCollapsed(on) {
    const hadFocus = this.el.contains(document.activeElement);
    this.s.setPref('toolbarCollapsed', on); // redraws the bar
    if (hadFocus) this.el.querySelector(on ? 'button' : 'button:not(.danger)')?.focus({ preventScroll: true });
  }

  /** What the bar offers right now, most used first. `always`: stays on a phone's bar (the rest go under More). */
  tools() {
    const s = this.s, t = [];
    const control = s.permissions.input;
    // Watching only: say so (the on-air lamp), and leave out what only works with control.
    if (!control) {
      t.push({ always: true, el: h('span', { class: 'tb-lamp', role: 'status' }, h('span', { class: 'dot live', 'aria-hidden': 'true' }), h('span', { class: 'lamp-text' }, 'View only')) });
    }
    if (control && this.touchUi) {
      t.push({ always: true, icon: I.keyboard, label: 'Keyboard', pressed: !!s.softkbd?.open, onClick: () => s.toggleKeyboard() });
      const pad = s.inputMode === 'trackpad';
      t.push({
        always: true, icon: pad ? I.trackpad : I.touch, label: pad ? 'Trackpad mode (tap to switch to touch)' : 'Touch mode (tap to switch to trackpad)',
        onClick: () => { s.setPref('inputMode', pad ? 'touch' : 'trackpad'); toast(pad ? 'Touch mode: tap where you want to click' : 'Trackpad mode: slide to move, tap to click'); },
      });
    }
    if (control) {
      t.push({ always: true, icon: I.keys, label: 'Extra keys', pressed: !!s.extraKeys?.visible, onClick: () => s.toggleExtraKeys() });
      t.push({ icon: I.bolt, label: 'Shortcuts', onClick: () => this.specialSheet() });
    }
    if (s.monitors.length > 1) {
      const cur = s.monitors.findIndex(m => m.id === s.monitorId);
      t.push({ icon: I.monitor, label: 'Displays', text: String(cur + 1), onClick: () => this.displaysSheet() });
    }
    if (s.permissions.clipboard) t.push({ icon: I.clipboard, label: 'Clipboard', onClick: () => this.clipboardSheet() });
    if (s.permissions.files) t.push({ icon: I.files, label: 'Files', onClick: () => this.filesSheet() });
    if (s.permissions.audio && s.audio.supported) t.push({ icon: s.prefs.audio ? I.sound : I.mute, label: s.prefs.audio ? 'Mute' : 'Unmute', onClick: () => s.setPref('audio', !s.prefs.audio) });
    if (canFullscreen()) t.push({ icon: s.fullscreen ? I.exitFullscreen : I.fullscreen, label: s.fullscreen ? 'Exit full screen' : 'Full screen', onClick: () => s.toggleFullscreen() });
    t.push({ icon: I.settings, label: 'Settings', onClick: () => this.settingsSheet() });
    return t;
  }

  refresh() {
    const s = this.s;
    this._compact = this.touchUi && this.narrow();
    // Folded away: one tab brings it back.
    this.el.classList.toggle('collapsed', this.collapsed);
    if (this.collapsed) {
      this.el.replaceChildren(this.btn(UNFOLD, 'Show tools', () => this.setCollapsed(false)));
      this.fit();
      return;
    }
    // Disconnect, then which computer this is: its screen in its own light, and its name (wide screens).
    const items = [this.btn(I.close, 'Disconnect', () => s.stop(), { danger: true }),
      h('span', { class: 'tb-screen', title: s.host.name }, h('span', { class: 'face', 'aria-hidden': 'true' }), h('span', { class: 'tb-name' }, s.host.name))];
    // Until the computer lets this session in, there's nothing to use yet but leaving.
    if (s.conn?.welcome) {
      const tools = this.tools();
      const shown = this._compact ? tools.filter(t => t.always) : tools;
      const more = this._compact ? tools.filter(t => !t.always) : [];
      items.push(h('span', { class: 'tb-sep' }));
      for (const t of shown) items.push(t.el || this.btn(t.icon, t.label, t.onClick, { pressed: t.pressed, text: t.text }));
      if (more.length) items.push(this.btn(MORE, 'More', () => this.moreSheet(more)));
    }
    if (this.touchUi) items.push(h('span', { class: 'tb-sep' }), this.btn(FOLD, 'Hide tools', () => this.setCollapsed(true)));
    this.el.replaceChildren(...items);
    this.fit();
  }

  /**
   * After a redraw or a change of screen size: a phone turned sideways gets the whole bar (and back), and on touch
   * screens the picture keeps clear of the bar (it sits below it rather than under it).
   */
  fit() {
    if (this.touchUi && !this.collapsed && this.narrow() !== this._compact) { this.refresh(); return; }
    const v = this.s.viewport;
    if (!v || !this.touchUi) return;
    // No room for it (a phone on its side with the keyboard up leaves a strip): it steps aside until there is,
    // so the strip shows the picture and the extra keys. (The keyboard's own Done button still closes it.)
    const below = this.el.offsetTop + this.el.offsetHeight + 6;
    const cramped = v.viewer.clientHeight - below - v.insetBottom < 120;
    this.el.classList.toggle('hidden', cramped);
    this.el.inert = cramped;
    v.setInsetTop(!this.collapsed && !cramped && this.el.offsetHeight > 0 ? below : 0);
  }

  /** The tools a phone's bar has no room for. */
  moreSheet(tools) {
    this._sheet('More', el => {
      el.append(h('h3', {}, 'More'));
      for (const t of tools) {
        el.append(sheetItem(t.label, { icon: svg(t.icon, 20), sub: t.text ? `Showing ${t.text}` : undefined, onClick: () => { closeSheet(); t.onClick(); } }));
      }
    });
  }

  peek(ms = 3000) {
    if (this.touchUi) return; // pinned: it doesn't hide by itself (only when there's no room: fit())
    this.el.classList.remove('hidden');
    this.el.inert = false;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.hovering || sheetOpen() || this.el.contains(document.activeElement)) return;
      this.el.classList.add('hidden');
      this.el.inert = true; // hidden buttons stay out of the tab order
    }, ms);
  }

  /** Shows or hides the toolbar; from the keyboard (`focus`), it also takes focus so its buttons can be used. */
  toggle({ focus = false } = {}) {
    if (this.touchUi) {
      if (this.collapsed) this.setCollapsed(false);
      else if (!focus) { this.setCollapsed(true); return; }
      if (focus) {
        this.el.classList.add('kbd');
        (this.el.querySelector('button:not(.danger)') || this.el.querySelector('button'))?.focus({ preventScroll: true });
      }
      return;
    }
    if (this.el.classList.contains('hidden') || (focus && !this.el.contains(document.activeElement))) {
      this.peek(6000);
      if (focus) {
        // Land on the first tool, not on Disconnect (one Enter away from ending the session).
        this.el.classList.add('kbd');
        (this.el.querySelector('button:not(.danger)') || this.el.querySelector('button'))?.focus({ preventScroll: true });
      }
    } else {
      this.el.classList.add('hidden');
      this.el.inert = true;
    }
  }

  /** Opens a sheet named like the button that opened it ("Settings", "Shortcuts"…); that button closes it again. */
  _sheet(label, build) {
    clearTimeout(this.hideTimer);
    if (sheetOpen() && this._sheetLabel === label) { closeSheet(); return; }
    this._sheetLabel = label;
    openSheet(build, { label, onClose: () => { this._sheetLabel = null; this.peek(1500); } });
  }

  // ------------------------------------------------------------------ displays
  displaysSheet() {
    const s = this.s;
    this._sheet('Displays', el => {
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
    this._sheet('Shortcuts', el => {
      el.append(h('h3', {}, 'Send keys'));
      if (s.macHost) {
        el.append(h('div', { class: 'grid' },
          b('Force Quit…', 'cad', '⌥⌘Esc'), b('Activity Monitor', 'taskmgr'), b('Lock screen', 'lock', '⌃⌘Q'),
          b('App switcher', 'cmdtab', '⌘Tab'), b('Spotlight', 'spotlight', '⌘Space'), b('Mission Control', 'mission', '⌃↑'),
          b('App windows', 'appwindows', '⌃↓'), b('Screenshot', 'shot', '⇧⌘3'), b('Screenshot area', 'shotarea', '⇧⌘4'),
          b('Screenshot tools', 'shottools', '⇧⌘5'), b('Close window', 'closewin', '⌘W'), b('Quit app', 'quit', '⌘Q'),
          b('Hide app', 'hide', '⌘H'), b('Minimize', 'minimize', '⌘M'), b('Emoji', 'emoji', '⌃⌘Space'), b('Esc', 'esc')));
      } else {
        el.append(h('div', { class: 'grid' },
          b('Ctrl+Alt+Del', 'cad'), b('Task Manager', 'taskmgr', 'Ctrl+Shift+Esc'), b('Lock', 'lock', 'Lock the remote computer'),
          b('Start (Win)', 'win'), b('Alt+Tab', 'alttab'), b('Task View', 'wintab', 'Win+Tab'),
          b('Show desktop', 'desktop', 'Win+D'), b('Explorer', 'explorer', 'Win+E'), b('Run…', 'run', 'Win+R'),
          b('Settings', 'settings', 'Win+I'), b('Snip', 'snip', 'Win+Shift+S'), b('PrtScn', 'prtsc'),
          b('Close app', 'altf4', 'Alt+F4'), b('Esc', 'esc'), b('Ctrl+Esc', 'ctrlesc')));
        if (!s.elevated) el.append(h('p', { class: 'muted small', style: { padding: '0 12px 6px' } },
          'Ctrl+Alt+Del and the lock/UAC screens need Headroom installed as a service on the host.'));
      }
      el.append(h('h3', {}, 'Type text'));
      const ta = h('textarea', { class: 'local-input', 'aria-label': 'Text to type on the remote computer', placeholder: 'Text to type on the remote (useful at login screens)…' });
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
    this._sheet('Clipboard', el => {
      el.append(h('h3', {}, 'Remote clipboard'));
      const remote = h('textarea', { class: 'local-input', readonly: true, 'aria-label': 'Remote clipboard' }, s.clipboard.remote || '');
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
      const local = h('textarea', { class: 'local-input', 'aria-label': 'Text to send to the remote clipboard', placeholder: 'Paste or type here…' });
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
      pathEl.textContent = state.path || (s.macHost ? 'This Mac' : 'This PC');
      const rows = [];
      if (state.error) rows.push(h('p', { class: 'small', style: { color: 'var(--stop-ink)', padding: '8px 12px' } }, state.error));
      if (state.path) rows.push(sheetItem(h('span', { class: 'file-row' }, svg(I.folderUp, 20), '..', ''), { onClick: () => load(state.parent || '') }));
      for (const e of state.entries) {
        rows.push(sheetItem(h('span', { class: 'file-row' }, svg(e.dir ? I.files : I.file, 20), e.name, ''), {
          sub: e.dir ? '' : fmtBytes(e.size),
          onClick: () => e.dir ? load(e.path) : this.download(e),
        }));
      }
      listEl.replaceChildren(...rows);
    };
    this._sheet('Files', el => {
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
        const r = await uploadFile(s.host, f, dir, p => { if (bar) bar.firstChild.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`; });
        toast(`Saved ${r.name || f.name} on ${s.host.name}${dir ? '' : ' (Downloads)'}`, 4000);
      } catch (e) {
        toast(`${f.name}: ${e.message}`, 5000);
      } finally {
        if (bar) { bar.hidden = true; bar.firstChild.style.transform = 'scaleX(0)'; }
      }
    }
  }

  // ------------------------------------------------------------------ settings
  settingsSheet() {
    const s = this.s, p = s.prefs;
    // Each option group is named by its heading.
    const row = (label, control) => {
      if (control.getAttribute?.('role') === 'group' && !control.hasAttribute('aria-label')) control.setAttribute('aria-label', label);
      return h('div', {}, h('h3', {}, label), h('div', { class: 'row' }, control));
    };
    this._sheet('Settings', el => {
      el.append(row('Scaling', segmented([
        { value: 'fit', label: 'Fit' }, { value: 'actual', label: '1:1' }, { value: 'fill', label: 'Fill' },
      ], p.scaling, v => s.setPref('scaling', v))));
      if (isTouchPrimary || isIPad) {
        el.append(row('Touch input', segmented([
          { value: 'trackpad', label: 'Trackpad' }, { value: 'touch', label: 'Direct touch' },
        ], s.inputMode, v => s.setPref('inputMode', v))));
      }
      if (s.macHost) {
        el.append(row('Keyboard', segmented([
          { value: 'auto', label: 'Auto' },
          { value: 'pc', label: 'As pressed' },
          { value: 'cmdctrl', label: 'Ctrl = ⌘' },
        ], p.keyboardProfile === 'mac' ? 'pc' : p.keyboardProfile, v => s.setPref('keyboardProfile', v))));
        el.append(h('p', { class: 'muted small', style: { padding: '0 12px' } },
          isApple ? 'Keys go to the Mac as pressed: ⌘ is ⌘, ⌥ is ⌥.' : 'Ctrl = ⌘: Ctrl+C/V/Z… act as ⌘C/V/Z on the Mac, and the Windows key is Control.',
          ' System shortcuts like ⌘Tab and ⌘Space can\'t be captured by a browser tab: use the Shortcuts menu, or Headroom Viewer.'));
      } else {
        el.append(row('Keyboard', segmented([
          { value: 'auto', label: 'Auto' },
          { value: 'mac', label: 'Mac shortcuts' },
          { value: 'pc', label: 'PC' },
          { value: 'cmdctrl', label: '⌘ = Ctrl' },
        ], p.keyboardProfile, v => s.setPref('keyboardProfile', v))));
        el.append(h('p', { class: 'muted small', style: { padding: '0 12px' } },
          isApple ? 'Mac shortcuts: ⌘C/V/X/Z/A/S/F… act as Ctrl, ⌘Q closes, ⌘ alone opens Start, ⌥←/→ jump words.' : 'PC: keys are sent exactly as pressed.',
          !hasKeyboardLock && !isTouchPrimary ? ' Tip: in Chrome/Edge full screen, Alt+Tab and the Windows key go to the remote too.' : ''));
      }
      // The technical options, folded away: most sessions never need them.
      const more = h('details', {}, h('summary', {}, 'Picture and network'));
      const advanced = node => more.append(node);
      advanced(row('Frame rate (fps)', segmented([
        { value: 30, label: '30' }, { value: 60, label: '60' }, { value: 120, label: '120' }, { value: 144, label: '144' },
      ], p.maxFps, v => s.setPref('maxFps', v))));
      advanced(row('Bandwidth (Mb/s)', segmented([
        { value: 0, label: 'Auto' }, { value: 5000, label: '5' }, { value: 12000, label: '12' }, { value: 25000, label: '25' }, { value: 50000, label: '50' },
      ], p.maxBitrateKbps, v => s.setPref('maxBitrateKbps', v))));
      advanced(row('Resolution', segmented([
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
      advanced(row('Connection stats', segmented([
        { value: false, label: 'Hidden' }, { value: true, label: 'Shown' },
      ], !!p.stats, v => s.setPref('stats', v))));
      advanced(row('Video drawing', segmented([
        { value: 'auto', label: 'Auto' }, { value: 'video', label: 'Video' }, { value: 'canvas', label: 'Canvas' },
      ], p.renderer, v => { s.setPref('renderer', v); toast('Takes effect the next time you connect'); })));
      advanced(h('p', { class: 'muted small', style: { padding: '0 12px' } }, 'Leave these on Auto unless the picture misbehaves.'));
      el.append(more);
      // Keyboard shortcuts: only where there's a keyboard to press them on.
      if (!isTouchPrimary) {
        el.append(h('p', { class: 'muted small', style: { padding: '8px 12px 4px' } },
          'Ctrl+Alt+Shift+M toggles this toolbar · F full screen · S stats · Q disconnect'));
      }
    });
  }
}
