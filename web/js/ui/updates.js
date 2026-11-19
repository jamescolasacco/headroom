// Updates, in the corner of Headroom Server's and Headroom Viewer's own windows: a small download button. Press it and
// it checks; an update it finds downloads with its progress showing, and then the button becomes "Restart to update".
// One press on that and the app restarts on the new version (it asks first if someone is connected). The apps also
// check and download by themselves every few hours, so most of the time the button is simply there to say so.
// (Claude's and Chrome's desktop apps work the same way: nothing to do until an update is ready, then one button.)
import { h, svg, announce } from './dom.js';

const DOWNLOAD = '<path d="M12 4v10.5M7.5 10l4.5 4.5 4.5-4.5M5 19.5h14"/>';
const RESTART = '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.8 4.5v4h-4"/>';
const DONE = '<path d="m5.5 12.5 4 4 9-9"/>';
const SPIN = '<circle cx="12" cy="12" r="8" class="upd-track"/><path d="M12 4a8 8 0 0 1 8 8" class="upd-spin"/>';
const C = 2 * Math.PI * 9;  // the progress ring's circumference
const ring = p => `<circle cx="12" cy="12" r="9" class="upd-track"/><circle cx="12" cy="12" r="9" class="upd-bar"
  stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(C * (1 - Math.min(1, Math.max(0, p)))).toFixed(2)}" transform="rotate(-90 12 12)"/>
  <path d="M12 8v7M9 12.5l3 3 3-3"/>`;
const SHOW_OUTCOME_MS = 4000; // "Up to date" or "Couldn't check", after a check you asked for

export class UpdateCorner {
  /** @param {HTMLElement} el where it goes; @param {object} o { app: 'Headroom Server' | 'Headroom Viewer', post(msg) (to the app) } */
  constructor(el, { app, post }) {
    this.app = app;
    this.post = post;
    this.u = null;          // the app's updater: { phase, current, version, progress, message, checkedAt }
    this.asked = false;     // a check you started is on its way
    this.outcomeUntil = 0;
    this.btn = h('button', { type: 'button', class: 'upd', 'data-key': 'update:corner' },
      h('span', { class: 'upd-icon', 'aria-hidden': 'true' }), h('span', { class: 'upd-label' }));
    this.btn.addEventListener('click', () => this._press());
    el.replaceChildren(this.btn);
    this._render();
  }

  /** The app's updater changed (its `{cmd: 'update', …}` message). */
  set(m) {
    const was = this.u;
    this.u = m;
    if (m.phase === 'ready' && was?.phase !== 'ready') announce(`${this.app} ${m.version} is ready. Restart to update.`);
    if (this.asked && (m.phase === 'current' || m.phase === 'failed')) {
      this.asked = false;
      this.outcomeUntil = performance.now() + SHOW_OUTCOME_MS;
      clearTimeout(this.outcomeTimer);
      this.outcomeTimer = setTimeout(() => this._render(), SHOW_OUTCOME_MS + 50);
      announce(m.phase === 'current' ? `${this.app} is up to date.` : (m.message || 'Couldn\'t check for updates.'));
    }
    if (m.phase !== 'checking' && m.phase !== 'current' && m.phase !== 'failed') this.asked = false;
    this._render();
  }

  _press() {
    const p = this.u?.phase;
    if (p === 'ready') { this.post({ cmd: 'installUpdate' }); return; }
    if (p === 'checking' || p === 'downloading') return;
    this.asked = true;
    this.u = { ...(this.u || {}), phase: 'checking' }; // at once: the app's answer follows
    this.post({ cmd: 'checkUpdate' });
    this._render();
  }

  _render() {
    const u = this.u || { phase: 'idle' };
    const v = u.version ? ` ${u.version}` : '';
    const pct = `${Math.round((u.progress || 0) * 100)}%`;
    const outcome = performance.now() < this.outcomeUntil;
    const checked = u.checkedAt ? `, checked ${new Date(u.checkedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : '';
    let icon = DOWNLOAD, label = '', name = 'Check for updates', tip = name, state = 'idle', open = false;
    switch (u.phase) {
      case 'ready':
        icon = RESTART; label = 'Restart to update'; open = true; state = 'ready';
        name = tip = `Restart to update to ${this.app}${v}`;
        break;
      case 'downloading':
        icon = ring(u.progress || 0); label = `Downloading ${pct}`; open = true; state = 'busy';
        name = tip = `Downloading ${this.app}${v}: ${pct}`;
        break;
      case 'checking':
        icon = SPIN; label = 'Checking…'; open = this.asked; state = 'busy';
        name = tip = 'Checking for updates…';
        break;
      case 'current':
        if (outcome) { icon = DONE; label = 'Up to date'; open = true; }
        state = 'current';
        tip = `${this.app} ${u.current || ''} is up to date${checked}. Click to check again.`.replace(/ {2,}/g, ' ');
        name = `Check for updates (${this.app} is up to date${checked})`;
        break;
      case 'failed':
        if (outcome) { label = 'Couldn\'t check'; open = true; }
        state = 'failed';
        tip = `${u.message || 'Couldn\'t check for updates.'} Click to try again.`;
        name = `Check for updates (the last check failed: ${u.message || 'unknown error'})`;
        break;
    }
    const b = this.btn;
    b.className = `upd ${state}${open ? ' open' : ''}`;
    b.setAttribute('aria-label', name);
    b.title = tip;
    b.setAttribute('aria-disabled', state === 'busy' ? 'true' : 'false');
    b.firstChild.replaceChildren(svg(icon, 20));
    b.lastChild.textContent = label;
  }
}
