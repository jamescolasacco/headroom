// Tiny DOM helpers: element builder, toast, bottom-sheet and dialog plumbing.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function svg(pathData, size = 22) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = pathData;
  return s;
}

/** The English plural for a count, by the language's rules: plural(3, '1 device', '3 devices'). */
const pluralRules = new Intl.PluralRules('en');
export const plural = (n, one, other) => (pluralRules.select(n) === 'one' ? one : other);

// Switching between light and dark mustn't animate every colour at once: transitions are off for that frame.
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  void root.offsetHeight; // apply the new colours with transitions off
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
});

let uid = 0;
/** A unique id for wiring labels, hints and errors to their controls. */
export const nextId = (prefix = 'hr') => `${prefix}-${++uid}`;

/**
 * Headroom Viewer's and Headroom Server's windows: hover styles apply only while the window is in front (app.css
 * gates every :hover on `:where(html:not([data-bg]))`). A window in the background gets no mouse moves, so the web view
 * keeps showing whatever was under the pointer when it went there: a link that opened the browser stayed lit, and
 * nothing else lit up until the window was clicked again. (Not in a browser tab: there, clicking the address bar takes
 * focus from the page too, and its links don't send you to another app.) Focus in an embedded frame (the human check)
 * still counts as in front.
 */
export function trackWindowFront() {
  const root = document.documentElement;
  const mark = () => root.toggleAttribute('data-bg', !document.hasFocus());
  addEventListener('focus', mark);
  addEventListener('blur', () => setTimeout(mark, 0)); // where focus went (a frame of ours, or another app) is known a moment later
  mark();
}

/**
 * Tells screen readers about something that changed, politely. The region (#announcer) is always in the page and
 * starts empty, so every update is read; clearing it first makes a repeated message read again.
 */
let announceTimer = 0, announceQueue = [];
export function announce(message) {
  const el = document.getElementById('announcer');
  if (!el || !message) return;
  announceQueue.push(message);
  el.textContent = '';
  clearTimeout(announceTimer);
  // A moment after clearing (so the same words twice are read again); messages that arrive together are read together.
  announceTimer = setTimeout(() => { el.textContent = announceQueue.join(' '); announceQueue = []; }, 60);
}

let toastTimer = 0, toastLeft = 0, toastSince = 0, toastWired = false;
const hideToast = el => {
  if (el.hidePopover && el.matches(':popover-open')) { try { el.hidePopover(); } catch { } }
  else el.hidden = true;
};
/** (Re)starts the countdown to hiding the message, with the time it has left. */
function armToast(el) {
  clearTimeout(toastTimer);
  toastSince = Date.now();
  toastTimer = setTimeout(() => hideToast(el), toastLeft);
}
/** Stops the countdown (pointer on the message, or the tab in the background): nobody misses a message. */
function pauseToast() {
  if (!toastTimer) return;
  clearTimeout(toastTimer);
  toastTimer = 0;
  toastLeft = Math.max(1200, toastLeft - (Date.now() - toastSince));
}
/**
 * A short message at the bottom of the screen, on every screen. It sits in the top layer (a popover) so it also
 * shows above an open dialog, and it is announced. Longer messages stay longer.
 */
export function toast(message, ms) {
  const el = document.getElementById('toast');
  if (!el) return;
  if (!toastWired) {
    toastWired = true;
    el.addEventListener('pointerenter', pauseToast);
    el.addEventListener('pointerleave', () => { if (!toastTimer) armToast(el); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) pauseToast(); else if (!toastTimer && el.textContent) armToast(el); });
    el.addEventListener('toggle', e => { if (e.newState === 'closed') { el.hidden = true; el.textContent = ''; clearTimeout(toastTimer); toastTimer = 0; } });
  }
  el.textContent = message;
  el.hidden = false;
  if (el.showPopover && !el.matches(':popover-open')) { try { el.showPopover(); } catch { } }
  announce(message);
  toastLeft = ms ?? Math.min(9000, Math.max(2600, message.length * 60));
  if (document.hidden) { clearTimeout(toastTimer); toastTimer = 0; } else armToast(el);
}

/**
 * A labelled form field: the label is bound to the input, an optional hint is linked as its description, and
 * an error line below it is linked too and starts empty. Returns the nodes to append plus `error(text)` to show
 * or clear the error (which also marks the field invalid).
 */
export function field(label, input, { hint } = {}) {
  input.id ||= nextId('f');
  const lab = h('label', { class: 'field', for: input.id }, label);
  const hintEl = hint ? h('p', { class: 'hint', id: nextId('hint') }, hint) : null;
  const errEl = h('p', { class: 'field-error', id: nextId('err'), hidden: true });
  const describe = () => {
    const ids = [hintEl && !hintEl.hidden ? hintEl.id : null, errEl.hidden ? null : errEl.id].filter(Boolean).join(' ');
    if (ids) input.setAttribute('aria-describedby', ids); else input.removeAttribute('aria-describedby');
  };
  describe();
  const error = text => {
    errEl.textContent = text || '';
    errEl.hidden = !text;
    if (hintEl) hintEl.hidden = !!text; // the error says what to do; the hint would only repeat it
    if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    describe();
    // Moving focus to the field reads the error out; when focus is already there, say it.
    if (text && document.activeElement === input) announce(text);
  };
  input.addEventListener('input', () => { if (!errEl.hidden) error(''); });
  return { nodes: [lab, input, hintEl, errEl], error, input };
}

/**
 * Marks a submit button busy without disabling it (a disabled button drops keyboard focus): it shows `busyLabel`,
 * ignores further presses, and is restored by the returned function.
 */
export function busy(button, busyLabel) {
  if (button.getAttribute('aria-disabled') === 'true') return null;
  const label = button.textContent;
  button.setAttribute('aria-disabled', 'true');
  button.classList.add('busy');
  if (busyLabel) button.textContent = busyLabel;
  return () => {
    button.removeAttribute('aria-disabled');
    button.classList.remove('busy');
    button.textContent = label;
  };
}

// ------------------------------------------------------------------ sheet (popover menus in the viewer)
let sheetClose = null;

/**
 * The way out of a dialog or sheet, in its top corner: a sticky strip with no height of its own holds it, so it stays
 * in view while a tall one scrolls (on a phone, its other buttons can be a long scroll away).
 */
function closeStrip(cls, onClick) {
  return h('div', { class: 'close-strip' },
    h('button', { type: 'button', class: `icon-btn ${cls}`, 'aria-label': 'Close', onclick: onClick }, svg('<path d="M18 6 6 18M6 6l12 12"/>', 20)));
}

/**
 * Opens the session's option sheet. It's named `label` (the name of the button that opened it), else by its first
 * heading; it takes focus, keeps Tab inside it, closes on Escape, its close button or a tap outside, and gives focus
 * back to its button.
 */
export function openSheet(build, { onClose, label } = {}) {
  const sheet = document.getElementById('sheet');
  const backdrop = document.getElementById('sheet-backdrop');
  const opener = document.activeElement;
  const openerName = opener?.getAttribute?.('aria-label');
  closeSheet();
  sheet.replaceChildren();
  build(sheet);
  const title = sheet.querySelector('h2, h3');
  if (label) { sheet.setAttribute('aria-label', label); sheet.removeAttribute('aria-labelledby'); }
  else if (title) { sheet.removeAttribute('aria-label'); title.id ||= nextId('sheet'); sheet.setAttribute('aria-labelledby', title.id); }
  else { sheet.removeAttribute('aria-label'); sheet.removeAttribute('aria-labelledby'); }
  // A way out you can see (on a phone a tall sheet leaves little to tap around it).
  sheet.prepend(closeStrip('sheet-close', () => close()));
  sheet.hidden = false;
  backdrop.hidden = false;
  const onKey = e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Modal: Tab and Shift+Tab go round the sheet's own controls (the ones showing: not inside a folded section).
    const shown = el => {
      if (el.disabled || !el.getClientRects().length) return false;
      for (let d = el.closest('details'); d; d = d.parentElement?.closest('details')) {
        if (!d.open && !d.querySelector(':scope > summary')?.contains(el)) return false;
      }
      return true;
    };
    const stops = [...sheet.querySelectorAll('button, input:not([type=hidden]), textarea, select, summary, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter(shown);
    if (!stops.length) { e.preventDefault(); return; }
    const first = stops[0], last = stops[stops.length - 1];
    if (e.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const close = () => {
    sheet.hidden = true; backdrop.hidden = true; sheet.replaceChildren();
    backdrop.removeEventListener('pointerdown', close);
    sheet.removeEventListener('keydown', onKey);
    sheetClose = null;
    onClose?.();
    // Back to the button that opened it, even if the toolbar was redrawn meanwhile (found again by its name).
    const back = opener?.isConnected ? opener
      : openerName ? document.querySelector(`#toolbar [aria-label="${CSS.escape(openerName)}"]`) : null;
    back?.focus?.({ preventScroll: true });
  };
  backdrop.addEventListener('pointerdown', close);
  sheet.addEventListener('keydown', onKey);
  sheetClose = close;
  // Focus the selected option, else the first control (keyboard users land inside; pointer users don't see a ring).
  (sheet.querySelector('.item.active, [aria-pressed="true"]') || sheet.querySelector('button:not(.sheet-close), input, textarea, select, [tabindex="0"]'))?.focus({ preventScroll: true });
  return close;
}

export function closeSheet() { sheetClose?.(); }
export function sheetOpen() { return !!sheetClose; }

export function sheetItem(label, { sub, onClick, active, icon } = {}) {
  return h('button', { class: 'item' + (active ? ' active' : ''), type: 'button', onclick: onClick },
    h('span', {}, icon || null, label), sub != null ? h('span', { class: 'sub' }, sub) : null);
}

export function segmented(options, value, onChange, label) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label || null });
  for (const o of options) {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.value === value) }, o.label);
    b.addEventListener('click', () => {
      for (const x of wrap.children) x.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-pressed', 'true');
      onChange(o.value);
    });
    wrap.append(b);
  }
  return wrap;
}

// ------------------------------------------------------------------ modal dialog
/**
 * Opens the modal dialog. It is named by its first heading. Focus goes to the element marked `autofocus`, else
 * to the heading (so the dialog is read from the top and no keyboard pops up on phones). Its close button (always
 * in view at the top), Escape or a click outside it close it, as Cancel would; closing gives focus back to
 * whatever opened it.
 */
export function dialog(build) {
  const dlg = document.getElementById('dlg');
  const opener = document.activeElement;
  dlg.replaceChildren();
  return new Promise(resolve => {
    const done = v => { dlg.close(); resolve(v); };
    build(dlg, done);
    dlg.prepend(closeStrip('dlg-close', () => done()));
    // Outside it is the backdrop (the click lands on the dialog element itself, beyond its box). A press that started
    // inside, like selecting text and letting go outside, doesn't count.
    const outside = e => {
      const r = dlg.getBoundingClientRect();
      return e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
    };
    let pressedOutside = false;
    dlg.onpointerdown = e => { pressedOutside = outside(e); };
    dlg.onclick = e => { if (pressedOutside && outside(e)) done(); pressedOutside = false; };
    const title = dlg.querySelector('h2');
    if (title) {
      title.id ||= nextId('dlg');
      title.tabIndex = -1;
      dlg.setAttribute('aria-labelledby', title.id);
    } else dlg.removeAttribute('aria-labelledby');
    dlg.onclose = () => {
      resolve(undefined);
      if (opener?.isConnected && opener.focus) opener.focus({ preventScroll: true });
    };
    dlg.showModal();
    const first = dlg.querySelector('[autofocus]') || title;
    first?.focus({ preventScroll: true });
    dlg.scrollTop = 0;
  });
}

export function confirmDialog(title, message, okLabel = 'Continue', danger = false) {
  return dialog((dlg, done) => {
    dlg.append(h('div', { class: 'body' },
      h('h2', {}, title), h('p', { class: 'muted' }, message),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => done(false) }, 'Cancel'),
        h('button', { type: 'button', class: danger ? 'danger' : 'primary', onclick: () => done(true) }, okLabel))));
  });
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
