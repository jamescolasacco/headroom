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

let toastTimer = 0;
export function toast(message, ms = 2600) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ------------------------------------------------------------------ sheet (popover menus in the viewer)
let sheetClose = null;

export function openSheet(build, { onClose } = {}) {
  const sheet = document.getElementById('sheet');
  const backdrop = document.getElementById('sheet-backdrop');
  closeSheet();
  sheet.replaceChildren();
  build(sheet);
  sheet.hidden = false;
  backdrop.hidden = false;
  const close = () => {
    sheet.hidden = true; backdrop.hidden = true; sheet.replaceChildren();
    backdrop.removeEventListener('pointerdown', close);
    sheetClose = null;
    onClose?.();
  };
  backdrop.addEventListener('pointerdown', close);
  sheetClose = close;
  return close;
}

export function closeSheet() { sheetClose?.(); }
export function sheetOpen() { return !!sheetClose; }

export function sheetItem(label, { sub, onClick, active, icon } = {}) {
  return h('button', { class: 'item' + (active ? ' active' : ''), type: 'button', onclick: onClick },
    h('span', {}, icon || null, label), sub != null ? h('span', { class: 'sub' }, sub) : null);
}

export function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'group' });
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
export function dialog(build) {
  const dlg = document.getElementById('dlg');
  dlg.replaceChildren();
  return new Promise(resolve => {
    const done = v => { dlg.close(); resolve(v); };
    build(dlg, done);
    dlg.onclose = () => resolve(undefined);
    dlg.showModal();
  });
}

export function confirmDialog(title, message, okLabel = 'OK', danger = false) {
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
