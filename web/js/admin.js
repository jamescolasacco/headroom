// Headroom Server's window. Runs on the host (loopback-only /api/admin) — inside the tray app's WebView2 window
// (Windows), the menu-bar app's WKWebView window (Mac), or any browser on the computer at http://localhost:7080/.
// Four sections: Home (who's connected), Let someone connect (guest codes), Account, Settings.
//
// The status is polled every 2 s, but a section is only redrawn when what it shows has changed, and focus,
// scroll position and unsent choices survive a redraw; times and the code countdown update in place.
import { h, svg, announce, field, nextId, plural } from './ui/dom.js';
import { QrCode } from './qr.js';
import { bridge } from './platform.js';

const native = bridge;   // present when hosted by Headroom Server's own window
const postNative = msg => native?.post(msg);
const mac = () => st?.host?.os === 'macos';
const thisPc = () => (mac() ? 'this Mac' : 'this PC');
const ThisPc = () => (mac() ? 'This Mac' : 'This PC');

const ICON = {
  home: '<path d="M3 11 12 3l9 8M5 9.5V21h14V9.5"/>',
  connect: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"/>',
  live: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><circle cx="12" cy="10.5" r="2.5"/>',
  down: '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M12 8v4M12 16h.01"/>',
};

const SECTIONS = [['home', 'Home'], ['connect', 'Let someone connect'], ['account', 'Account'], ['settings', 'Settings']];
const OLD_SECTIONS = { status: 'home', support: 'connect', pair: 'connect', devices: 'account', security: 'account', features: 'settings', quality: 'settings', connection: 'settings', about: 'settings' };

let st = null;            // last /status
let current = 'home';
let shownKey = '';        // what the drawn section was drawn from (redraw only when it changes)
let notes = {};           // section -> { ok, text }: results of the last action, kept across redraws
let codeError = '';
let loginItem = null;     // Start at login (native window only): true/false, or null when unknown
const choices = {};       // request id -> { files, clipboard }: kept while the page redraws
let knownRequests = null; // request and session ids seen at the last poll (null before the first)
let knownSessions = null;

// ------------------------------------------------------------------ api
async function api(path, opts = {}) {
  const r = await fetch(`/api/admin${path}`, { headers: { 'Content-Type': 'application/json' }, cache: 'no-store', ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(body.message || body.error || `HTTP ${r.status}`); e.body = body; throw e; }
  return body;
}
const post = (path, body) => api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
const saveSettings = patch => post('/settings', patch).then(() => refresh());

async function refresh({ force = false } = {}) {
  let next;
  try {
    next = await api('/status');
  } catch (e) {
    st = null;
    shownKey = '';
    renderOffline(e.message);
    return;
  }
  const wasOffline = !st;
  st = next;
  tellAboutChanges();
  renderNav();
  document.getElementById('side-host').textContent = st.host.name;
  document.getElementById('side-foot').textContent = `v${st.host.version}`;
  const key = viewKey();
  if (force || wasOffline || key !== shownKey) render(key);
  else updateLiveText();
  postNative({ cmd: 'status', viewers: st.sessions.length, names: st.sessions.map(s => s.device) });
}

/** What the current section is drawn from. Times and countdowns aren't in it: they update in place. */
function viewKey() {
  const s = st;
  const sessions = s.sessions.map(x => [x.id, x.device, x.guest, x.remoteAddress, x.country, x.rights]);
  const requests = (s.support?.requests || []).map(r => [r.id, r.name, r.address, r.country]);
  const perms = s.permissions ? [s.permissions.screenRecording, s.permissions.accessibility] : null;
  switch (current) {
    case 'home': return JSON.stringify(['home', sessions, requests, s.account?.email, s.relay?.state, perms, s.testPattern, s.host.name]);
    case 'connect': return JSON.stringify(['connect', s.relay?.state, s.relay?.error, s.support?.code?.code, requests, codeError]);
    case 'account': return JSON.stringify(['account', s.account?.email, s.account?.error, s.settings.displayName, s.host.machine, notes.account, notes.rename]);
    default: return JSON.stringify(['settings', s.settings, perms, loginItem, s.dataDir, s.logDir, s.host.version]);
  }
}

/** Announces arrivals and departures (the menu-bar app shows the prompt; this is for screen readers here). */
function tellAboutChanges() {
  const reqs = st.support?.requests || [];
  for (const r of reqs) if (!knownRequests?.has(r.id)) announce(`${r.name} wants to connect to ${thisPc()}. Go to Home to answer.`);
  knownRequests = new Set(reqs.map(r => r.id));
  const ids = new Set(st.sessions.map(s => s.id));
  if (knownSessions) {
    for (const s of st.sessions) if (!knownSessions.has(s.id)) announce(`${s.device || 'Someone'} connected.`);
    for (const id of knownSessions) if (!ids.has(id)) announce('A session ended.');
  }
  knownSessions = ids;
}

// ------------------------------------------------------------------ chrome
let navButtons = null;
/** Builds the section menu once; afterwards only its state and counts change (so focus stays on it). */
function renderNav() {
  const nav = document.getElementById('nav');
  if (!navButtons || !nav.contains(navButtons.home)) {
    navButtons = {};
    nav.replaceChildren(...SECTIONS.map(([id, label]) => {
      const count = h('span', { class: 'count', 'aria-hidden': 'true', hidden: true });
      const sr = h('span', { class: 'sr-only' });
      const b = h('button', { class: 'nav-item', type: 'button', 'data-key': `nav:${id}` }, svg(ICON[id], 18), h('span', {}, label), count, sr);
      b.onclick = () => go(id, { focus: true });
      navButtons[id] = b;
      return b;
    }));
  }
  const waiting = st?.support?.requests?.length || 0;
  const people = st?.sessions.length || 0;
  for (const [id] of SECTIONS) {
    const b = navButtons[id];
    if (id === current) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    const [count, sr] = [b.querySelector('.count'), b.querySelector('.sr-only')];
    const n = id === 'home' ? people + waiting : 0;
    count.hidden = !n;
    count.textContent = n ? String(n) : '';
    count.classList.toggle('attention', id === 'home' && waiting > 0);
    sr.textContent = id !== 'home' || !n ? '' : `, ${[waiting ? `${waiting} waiting` : '', people ? `${people} connected` : ''].filter(Boolean).join(', ')}`;
  }
}

function renderOffline(message) {
  navButtons = null;
  document.getElementById('nav').replaceChildren();
  const c = document.getElementById('content');
  c.replaceChildren(h('section', {},
    h('div', { class: 'card' }, h('div', { class: 'hero down' }, h('div', { class: 'ring' }, svg(ICON.down, 28)),
      h('div', {}, h('h2', { class: 'title' }, 'Headroom Server isn\'t running'),
        h('p', { class: 'muted small' }, native ? 'Start it here, or from the Headroom icon in the menu bar / notification area.' : `This page talks to Headroom Server on this computer (${message}).`))),
      native ? h('div', { class: 'row', style: { marginTop: '14px' } }, h('button', { class: 'primary', onclick: () => postNative({ cmd: 'startServer' }) }, 'Start server')) : null)));
}

/** Redraws the current section, keeping keyboard focus and the scroll position where they were. */
function render(key = viewKey()) {
  const c = document.getElementById('content');
  const focusKey = document.activeElement?.closest?.('[data-key]')?.dataset.key;
  const inContent = c.contains(document.activeElement);
  const scroll = c.scrollTop;
  const views = { home: viewHome, connect: viewConnect, account: viewAccount, settings: viewSettings };
  c.replaceChildren(views[current]());
  shownKey = key;
  c.scrollTop = scroll;
  if (inContent && focusKey) c.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  updateLiveText();
}

/** Text that changes every second or minute, updated without a redraw. */
function updateLiveText() {
  for (const el of document.querySelectorAll('[data-ago]')) el.textContent = ago(el.dataset.ago);
  for (const el of document.querySelectorAll('[data-expires]')) {
    const left = Math.max(0, Math.round((new Date(el.dataset.expires) - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    if (!left && st?.support?.code) refresh({ force: true });
  }
}
setInterval(updateLiveText, 1000);

// ------------------------------------------------------------------ helpers
const ago = d => {
  if (!d) return 'never';
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(d).toLocaleDateString();
};
const agoEl = d => h('span', { 'data-ago': d ? new Date(d).toISOString() : '' }, ago(d));
const countryName = code => {
  if (!code) return '';
  try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) || code; } catch { return code; }
};
const where = x => [x.country ? `${countryName(x.country)} (approximate)` : '', (x.address || x.remoteAddress || '').replace(' (via relay)', '')].filter(Boolean).join(' · ');
const prettyCode = c => String(c || '').replace(/(\d{3})(?=\d)/g, '$1 ');
const site = () => (st?.relay?.site || '').replace(/^https?:\/\//, '');
/** Like replaceChildren, but skips empty entries (replaceChildren would print "null"). */
const put = (el, ...kids) => { el.replaceChildren(...kids.flat().filter(k => k != null && k !== false)); return el; };
const note = section => {
  const n = notes[section];
  return h('p', { class: n ? `msg ${n.ok ? 'ok' : 'err'}` : 'msg', role: 'status' }, n?.text || '');
};

function copyBtn(text, label = 'Copy', key) {
  const b = h('button', { class: 'sm copy', type: 'button', 'data-key': key || null }, label);
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(text); } catch { postNative({ cmd: 'copy', text }); }
    b.textContent = 'Copied';
    announce(`Copied the ${label.replace(/^Copy /, '')}`);
    setTimeout(() => { b.textContent = label; }, 1500);
  };
  return b;
}

/** A switch: a checkbox with the switch role, named by `label` or by the element ids in `labelledby`. */
function toggle(checked, onChange, { label, labelledby, describedby, key } = {}) {
  const input = h('input', {
    type: 'checkbox', role: 'switch', 'aria-label': label || null, 'aria-labelledby': labelledby || null,
    'aria-describedby': describedby || null, 'data-key': key || null,
  });
  input.checked = !!checked;
  input.onchange = () => onChange(input.checked);
  return h('label', { class: 'switch' }, input, h('span', { 'aria-hidden': 'true' }));
}

function switchRow(title, sub, checked, onChange, key) {
  const t = h('div', { class: 't', id: nextId('sw') }, title);
  const s = sub ? h('div', { class: 's', id: nextId('sw') }, sub) : null;
  return h('div', { class: 'switch-row' }, h('div', { class: 'main' }, t, s),
    toggle(checked, onChange, { labelledby: t.id, describedby: s?.id, key: key || `sw:${title}` }));
}

/** A button that asks in place: the first press arms it (and says what will happen), the second within 5 s acts. */
function armedButton(label, question, run, key) {
  let armed = 0;
  const b = h('button', { type: 'button', 'data-key': key || null }, label);
  b.onclick = async () => {
    if (!armed) {
      b.textContent = question;
      announce(`${question} Press again to confirm.`);
      armed = setTimeout(() => { armed = 0; b.textContent = label; }, 5000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    b.setAttribute('aria-disabled', 'true');
    try { await run(); } finally { b.removeAttribute('aria-disabled'); b.textContent = label; }
  };
  return b;
}

function checkbox(label, checked, onChange, key) {
  const input = h('input', { type: 'checkbox', 'data-key': key || null });
  input.checked = !!checked;
  input.onchange = () => onChange(input.checked);
  return h('label', { class: 'check' }, input, h('span', {}, label));
}

function qrBox(text, size) {
  const box = h('div', { class: 'qr', role: 'img', 'aria-label': 'QR code that opens the link', title: text, style: size ? { width: `${size}px` } : null });
  box.innerHTML = QrCode.encode(text, 'M').toSvg({ border: 2 });
  return box;
}

function openExternal(url) {
  if (native) postNative({ cmd: 'openUrl', url }); else window.open(url, '_blank', 'noopener');
}

// ------------------------------------------------------------------ Home

/**
 * Someone with your code is waiting. The riskiest moment in the app, so it looks like it: a warning card with
 * the unverified name, where they are, the scam warning at full size, what else they may do (off unless
 * ticked), and the answers in the same order as the menu-bar prompt: Accept, View only, Decline.
 */
function requestsCard() {
  const reqs = st.support?.requests || [];
  if (!reqs.length) return null;
  return h('section', { class: 'request-stack', 'aria-label': 'Waiting for your answer' }, ...reqs.map(r => {
    const ch = choices[r.id] ||= { files: false, clipboard: false };
    const titleId = nextId('req');
    const answer = (accept, viewOnly) => {
      post(`/support/requests/${r.id}`, { accept, viewOnly, files: ch.files, clipboard: ch.clipboard })
        .then(() => announce(accept ? `${r.name} can now ${viewOnly ? 'see' : 'see and control'} ${thisPc()}.` : `Declined ${r.name}.`))
        .catch(() => announce('That request is no longer waiting.'))
        .then(() => refresh({ force: true }));
    };
    const btn = (label, cls, accept, viewOnly) => h('button', { class: cls, type: 'button', 'data-key': `req:${r.id}:${label}`, 'aria-describedby': titleId, onclick: () => answer(accept, viewOnly) }, label);
    return h('div', { class: 'card request', role: 'group', 'aria-labelledby': titleId },
      h('div', { class: 'request-head' }, svg(ICON.shield, 22),
        h('div', {},
          h('h3', { id: titleId }, `“${r.name}” wants to connect to ${thisPc()}`),
          h('p', { class: 'small' }, 'They typed that name; it isn\'t verified', where(r) ? ` · from ${where(r)}` : '', ' · asked ', agoEl(r.created)))),
      h('p', { class: 'request-warning' }, 'Only accept if you know this person and asked for their help. Scammers call pretending to be support and ask for codes.'),
      h('div', { class: 'row checks' },
        checkbox('Let them transfer files', ch.files, v => { ch.files = v; }, `req:${r.id}:files`),
        checkbox('Share clipboard', ch.clipboard, v => { ch.clipboard = v; }, `req:${r.id}:clipboard`)),
      h('div', { class: 'row request-actions' },
        btn('Accept', 'sm accept', true, false),
        btn('View only', 'sm accept', true, true),
        btn('Decline', 'sm decline', false, false)),
      h('p', { class: 'muted small' }, 'No answer in 2 minutes declines.'));
  }));
}

function sessionRow(s) {
  const r = s.rights || {};
  const set = patch => post(`/sessions/${s.id}/rights`, patch).then(() => refresh({ force: true })).catch(() => { });
  const mini = (label, value, k) => h('label', { class: 'mini-switch' }, h('span', { class: 'small' }, label),
    toggle(value, v => set({ [k]: v }), { label: `${label} for ${s.device || 'this guest'}`, key: `sess:${s.id}:${k}` }));
  return h('li', { class: 'li' },
    h('div', { class: 'main' },
      h('div', { class: 't' }, s.device || 'Someone', h('span', { class: `badge ${s.guest ? 'warn' : 'ok'}`, style: { marginLeft: '8px' } }, s.guest ? 'Guest (code)' : 'Your account')),
      h('div', { class: 's' }, `${where(s)} · connected `, agoEl(s.connectedAt)),
      s.guest ? h('div', { class: 'row checks' }, mini('Control', r.input, 'input'), mini('Files', r.files, 'files'), mini('Clipboard', r.clipboard, 'clipboard')) : null),
    h('button', { class: 'sm danger', type: 'button', 'data-key': `sess:${s.id}:stop`, 'aria-label': `Stop ${s.device || 'this session'}`, onclick: () => post(`/sessions/${s.id}/disconnect`).then(() => refresh({ force: true })) }, 'Stop'));
}

function viewHome() {
  const n = st.sessions.length;
  const perms = st.permissions;
  const missing = mac() && perms && (!perms.screenRecording || !perms.accessibility);
  const relay = st.relay || {};
  const state = n ? 'live' : missing ? 'warn' : 'ready';
  const hero = h('div', { class: `hero ${state}` },
    h('div', { class: 'ring', 'aria-hidden': 'true' }, svg(n ? ICON.live : missing ? ICON.warn : ICON.check, 28)),
    h('div', { class: 'grow' },
      h('p', { class: 'title' }, n ? plural(n, `${st.sessions[0].device || 'Someone'} is connected`, `${n} people are connected`) : missing ? 'Needs permission before anyone can connect' : 'Nobody is connected'),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        st.account ? h('span', { class: 'badge ok' }, `Signed in as ${st.account.email}`) : h('span', { class: 'badge' }, 'Not signed in'),
        relay.state === 'online' ? h('span', { class: 'badge ok' }, 'Online') : h('span', { class: 'badge warn' }, relay.state === 'retrying' ? 'Offline: retrying' : 'Connecting…'),
        st.testPattern ? h('span', { class: 'badge warn' }, 'Test pattern') : null)),
    n > 1 ? h('button', { class: 'danger', type: 'button', 'data-key': 'home:stop-all', onclick: () => post('/sessions/disconnect-all').then(() => refresh({ force: true })) }, 'Stop all') : null);
  const next = !st.account && !n ? h('div', { class: 'card' }, h('h3', {}, 'Get started'),
    h('ul', { class: 'list' },
      h('li', { class: 'li' }, h('div', { class: 'main' }, h('div', { class: 't' }, 'Reach this computer from your other devices'),
        h('div', { class: 's' }, `Sign in with your Headroom account. Then it's in your list at ${site() || 'the Headroom website'} and in Headroom Viewer.`)),
      h('button', { class: 'sm primary', type: 'button', 'data-key': 'home:signin', onclick: () => go('account', { focus: true }) }, 'Sign in')),
      h('li', { class: 'li' }, h('div', { class: 'main' }, h('div', { class: 't' }, 'Let someone help you'),
        h('div', { class: 's' }, 'Give them a code. They connect from their browser — no account, no download — after you accept.')),
      h('button', { class: 'sm', type: 'button', 'data-key': 'home:code', onclick: () => go('connect', { focus: true }) }, 'Get a code')))) : null;
  return h('section', {}, h('h2', { tabindex: '-1' }, 'Home'),
    requestsCard(),
    missing ? permissionsCard() : null,
    h('div', { class: 'card' }, hero),
    n ? h('div', { class: 'card' }, h('h3', {}, 'Connected now'), h('ul', { class: 'list' }, ...st.sessions.map(sessionRow))) : null,
    next);
}

// ------------------------------------------------------------------ Let someone connect

function viewConnect() {
  const relay = st.relay || {}, c = st.support?.code;
  const online = relay.state === 'online';
  const card = h('div', { class: 'card share' });
  const left = c ? Math.max(0, Math.round((new Date(c.expiresAt) - Date.now()) / 1000)) : 0;
  if (!c || !left) {
    put(card,
      h('p', {}, `Give someone a code and they can connect to ${thisPc()} from their browser. No account or download for them.`),
      h('ol', { class: 'steps small' },
        h('li', {}, `They open ${site() || 'the Headroom website'} and enter the code, or you send them the link.`),
        h('li', {}, `${ThisPc()} asks you to accept, and you choose what they can do. Nobody gets in without you clicking Accept.`),
        h('li', {}, 'You can stop the session at any time.')),
      h('div', { class: 'row' }, h('button', {
        class: 'primary', type: 'button', 'data-key': 'connect:create', 'aria-disabled': online ? null : 'true', onclick: async e => {
          if (!online || e.currentTarget.getAttribute('aria-disabled') === 'true') return;
          e.currentTarget.setAttribute('aria-disabled', 'true');
          codeError = '';
          try { await post('/support/code'); announce('Code created.'); } catch (ex) { codeError = ex.message; announce(ex.message); }
          refresh({ force: true });
        },
      }, 'Create a code')),
      !online ? h('p', { class: 'small muted', role: 'status' }, `Connecting to Headroom…${relay.error ? ` (${relay.error})` : ''}`) : null,
      codeError ? h('p', { class: 'msg err', role: 'alert' }, codeError) : null);
  } else {
    put(card,
      h('div', { class: 'share-grid' },
        h('div', {},
          h('p', { class: 'muted small', id: 'code-label' }, 'Your code'),
          h('p', { class: 'code-big' }, prettyCode(c.code)),
          h('p', { class: 'muted small' }, 'For one person · expires in ', h('span', { 'data-expires': c.expiresAt, class: 'mono' })),
          h('p', { class: 'request-warning' }, 'Only give this code to someone you know. Nobody from Headroom will ever ask you for it.'),
          h('div', { class: 'row' }, copyBtn(c.code, 'Copy code', 'connect:copy-code'), copyBtn(c.link, 'Copy link', 'connect:copy-link'),
            h('button', { class: 'sm', type: 'button', 'data-key': 'connect:stop', onclick: () => api('/support/code', { method: 'DELETE' }).then(() => { announce('Stopped sharing the code.'); refresh({ force: true }); }) }, 'Stop sharing')),
          h('p', { class: 'small' }, `They enter it at ${site()}, or open the link: `, h('span', { class: 'mono link-text' }, c.link))),
        h('figure', { class: 'share-qr' }, qrBox(c.link, 132), h('figcaption', { class: 'muted small' }, 'Or scan to open the link'))));
  }
  return h('section', {}, h('h2', { tabindex: '-1' }, 'Let someone connect'),
    h('p', { class: 'lead' }, 'For help from someone, or to reach this computer from a browser that isn\'t signed in.'),
    requestsCard(), card);
}

// ------------------------------------------------------------------ Account

const ACCOUNT_ERRORS = {
  'bad-credentials': 'Wrong email or password.',
  'bad-totp': 'That code didn\'t work. Wait for the next one and try again.',
  'rate-limited': 'Too many attempts. Try again in a minute.',
};

function viewAccount() {
  const a = st.account;
  if (a) {
    const name = h('input', { type: 'text', value: st.settings.displayName || '', placeholder: st.host.machine, class: 'grow', maxlength: '64', autocomplete: 'off', 'data-key': 'account:name' });
    const nameF = field(`${ThisPc()}'s name`, name, { hint: 'How it\'s listed in your account and shown to people who connect. Leave empty to use the computer\'s name.' });
    const save = h('button', { type: 'submit', 'data-key': 'account:save' }, 'Save name');
    const form = h('form', { class: 'name-form' }, ...nameF.nodes, h('div', { class: 'row' }, save), note('rename'));
    form.onsubmit = async e => {
      e.preventDefault();
      try { await post('/settings', { displayName: name.value }); notes.rename = { ok: true, text: 'Saved.' }; announce('Saved.'); }
      catch (ex) { notes.rename = { ok: false, text: ex.message }; }
      setTimeout(() => { delete notes.rename; }, 4000);
      refresh({ force: true });
    };
    return h('section', {}, h('h2', { tabindex: '-1' }, 'Account'),
      h('p', { class: 'lead' }, `${ThisPc()} is one of your devices. Sign in at ${site()} or in Headroom Viewer on any device to see it and connect.`),
      h('div', { class: 'card' }, h('dl', { class: 'kv' },
        h('dt', { class: 'k' }, 'Signed in as'), h('dd', {}, a.email),
        h('dt', { class: 'k' }, 'Last check-in'), h('dd', {}, a.error ? h('span', {}, h('span', { class: 'badge warn' }, 'Problem'), ` ${a.error}`) : agoEl(a.lastSync))),
        h('div', { class: 'row', style: { marginTop: '12px' } },
          armedButton('Sign out', `Sign ${thisPc()} out of ${a.email}?`, async () => {
            await post('/account/leave').catch(() => { });
            notes.account = { ok: true, text: `Signed out. ${ThisPc()} left your devices; codes still work.` };
            announce(notes.account.text);
            refresh({ force: true });
          }, 'account:signout')), note('account')),
      h('div', { class: 'card' }, h('h3', {}, `${ThisPc()}'s name`), form));
  }
  const email = h('input', { type: 'email', class: 'grow', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', name: 'email', 'data-key': 'account:email' });
  const pass = h('input', { type: 'password', class: 'grow', autocomplete: 'current-password', name: 'password', 'data-key': 'account:password' });
  const totp = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '123456', autocomplete: 'one-time-code', name: 'totp', 'data-key': 'account:totp' });
  const emailF = field('Email', email), passF = field('Password', pass), totpF = field('Code from your authenticator app', totp);
  const totpRow = h('div', { hidden: true }, ...totpF.nodes);
  const submit = h('button', { class: 'primary', type: 'submit', 'data-key': 'account:submit' }, 'Sign in');
  const status = note('account');
  const form = h('form', { class: 'signin', novalidate: true }, ...emailF.nodes, ...passF.nodes, totpRow, h('div', { class: 'row' }, submit), status);
  form.onsubmit = async e => {
    e.preventDefault();
    if (submit.getAttribute('aria-disabled') === 'true') return;
    if (!email.value.trim()) { emailF.error('Enter your email.'); email.focus(); return; }
    if (!pass.value) { passF.error('Enter your password.'); pass.focus(); return; }
    status.className = 'msg'; status.textContent = 'Signing in…';
    submit.setAttribute('aria-disabled', 'true');
    try {
      const r = await post('/account/join', { email: email.value.trim(), password: pass.value, totp: totp.value.trim() || undefined });
      notes.account = { ok: true, text: `Signed in as ${r.email}. ${ThisPc()} is now in your account.` };
      announce(notes.account.text);
      refresh({ force: true });
    } catch (ex) {
      status.textContent = '';
      const b = ex.body || {};
      if (b.error === 'totp-required') { totpRow.hidden = false; announce('This account uses two-factor sign-in: enter the code from your authenticator app.'); totp.focus(); }
      else if (b.error === 'bad-totp') { totpF.error(ACCOUNT_ERRORS['bad-totp']); totp.focus(); }
      else if (b.error === 'bad-credentials') { passF.error(ACCOUNT_ERRORS['bad-credentials']); pass.select(); pass.focus(); }
      else { status.className = 'msg err'; status.textContent = ACCOUNT_ERRORS[b.error] || ex.message; }
    } finally { submit.removeAttribute('aria-disabled'); }
  };
  const web = (path, label) => h('a', { href: `${st.relay.site}/${path}`, target: '_blank', rel: 'noopener', onclick: e => { if (native) { e.preventDefault(); openExternal(`${st.relay.site}/${path}`); } } }, label);
  return h('section', {}, h('h2', { tabindex: '-1' }, 'Account'),
    h('p', { class: 'lead' }, `Sign in with your Headroom account to add ${thisPc()} to it. Then it's in your list on every device where you're signed in — click it to connect, from anywhere.`),
    h('div', { class: 'card' }, h('h3', {}, 'Sign in'), form,
      h('p', { class: 'small muted', style: { marginTop: '12px' } }, web('#signup', 'Create an account'), ' · ', web('#forgot', 'Forgot password?'), ` (opens ${site()})`)),
    h('p', { class: 'small muted' }, `Your password goes only to Headroom; ${thisPc()} gets its own sign-in, which you can remove from any device (Account → Your devices).`));
}

// ------------------------------------------------------------------ Settings

/** Mac: the two privacy permissions, with shortcuts to grant them. */
function permissionsCard() {
  const p = st.permissions || {};
  const item = (ok, title, sub, kind, url) => h('li', { class: 'li' },
    h('div', { class: 'main' }, h('div', { class: 't' }, title, ' ', h('span', { class: `badge ${ok ? 'ok' : 'warn'}` }, ok ? 'Allowed' : 'Not allowed')),
      h('div', { class: 's' }, sub)),
    ok ? null : h('div', { class: 'row' },
      h('button', { class: 'sm', type: 'button', 'data-key': `perm:${kind}:ask`, onclick: () => post('/permissions/request', { kind }).then(() => refresh({ force: true })) }, 'Ask macOS'),
      h('button', { class: 'sm primary', type: 'button', 'data-key': `perm:${kind}:open`, onclick: () => openExternal(url) }, 'Open System Settings')));
  return h('div', { class: 'card' }, h('h3', {}, 'macOS permissions'),
    h('ul', { class: 'list' },
      item(p.screenRecording, 'Screen Recording', 'Lets people who connect see the screen and hear its sound.', 'screen', p.screenRecordingUrl),
      item(p.accessibility, 'Accessibility', 'Lets people who connect control the mouse and keyboard.', 'accessibility', p.accessibilityUrl)),
    p.screenRecording && p.accessibility ? null : h('p', { class: 'small muted' },
      'Turn on Headroom Server in each list (System Settings → Privacy & Security). macOS applies Screen Recording after Headroom Server restarts.'));
}

function viewSettings() {
  const v = st.settings.video, p = st.settings.permissions;
  const row = (title, sub, control) => {
    const t = h('div', { class: 't', id: nextId('set') }, title);
    const s = h('div', { class: 's', id: nextId('set') }, sub);
    control.setAttribute('aria-labelledby', t.id);
    control.setAttribute('aria-describedby', s.id);
    return h('div', { class: 'switch-row' }, h('div', { class: 'main' }, t, s), control);
  };
  const sel = (value, options, onChange, key) => {
    const s = h('select', { class: 'inline', 'data-key': key }, ...options.map(([val, label]) => h('option', { value: String(val) }, label)));
    s.value = String(value);
    s.onchange = () => onChange(s.value);
    return s;
  };
  const openBtn = (label, path, what) => native ? h('button', { class: 'sm', type: 'button', 'aria-label': `Open the ${what} folder`, onclick: () => postNative({ cmd: 'openFolder', path }) }, label) : null;
  return h('section', {}, h('h2', { tabindex: '-1' }, 'Settings'),
    h('div', { class: 'card' }, h('h3', {}, 'General'),
      loginItem !== null ? switchRow('Start at login', `Keeps ${thisPc()} reachable after a restart.`, loginItem, x => { loginItem = x; postNative({ cmd: 'loginItem', enabled: x }); }, 'set:login') : null,
      switchRow('Notify when someone connects', `A notification on ${thisPc()} each time a session starts or ends.`, st.settings.notifyOnConnect !== false, x => saveSettings({ notifyOnConnect: x }), 'set:notify'),
      mac() ? switchRow('Lock this Mac when the last person disconnects', 'So nobody walks up to an unlocked screen afterwards.', st.settings.lockOnDisconnect, x => saveSettings({ lockOnDisconnect: x }), 'set:lock') : null),
    h('div', { class: 'card' }, h('h3', {}, 'Your devices may'),
      h('p', { class: 'small muted' }, 'For devices signed in to your account. Guests get what you allow when you accept them.'),
      switchRow('Control', 'Off = they can watch but not use the mouse or keyboard.', p.input, x => saveSettings({ input: x }), 'set:input'),
      switchRow('Clipboard', 'Copy on one side, paste on the other (text).', p.clipboard, x => saveSettings({ clipboard: x }), 'set:clipboard'),
      switchRow('Files', `Browse, download and upload files on ${thisPc()}.`, p.fileTransfer, x => saveSettings({ fileTransfer: x }), 'set:files'),
      switchRow('Sound', `Hear ${thisPc()}'s audio.`, st.settings.audio.enabled, x => saveSettings({ audio: x }), 'set:sound')),
    h('div', { class: 'card' }, h('h3', {}, 'Picture quality'),
      h('p', { class: 'small muted' }, 'Upper limits. Each session adapts below these to its connection.'),
      row('Encoder', mac() ? 'Hardware uses the Mac\'s built-in video encoder (fastest). Software works everywhere.' : 'Hardware uses your graphics card (fastest). Software works everywhere.', sel(v.encoder, [['auto', 'Automatic'], ['hardware', 'Hardware only'], ['software', 'Software']], x => saveSettings({ encoder: x }), 'set:encoder')),
      row('Maximum frame rate', 'Higher is smoother but uses more bandwidth.', sel(v.maxFps, [[30, '30 fps'], [60, '60 fps'], [120, '120 fps'], [144, '144 fps'], [240, '240 fps']], x => saveSettings({ maxFps: +x }), 'set:fps')),
      row('Maximum bitrate', 'Caps bandwidth per session.', sel(v.maxBitrateKbps, [[10000, '10 Mb/s'], [20000, '20 Mb/s'], [40000, '40 Mb/s'], [80000, '80 Mb/s'], [150000, '150 Mb/s']], x => saveSettings({ maxBitrateKbps: +x }), 'set:bitrate'))),
    mac() ? permissionsCard() : null,
    h('div', { class: 'card' }, h('h3', {}, 'About'), h('dl', { class: 'kv' },
      h('dt', { class: 'k' }, 'Version'), h('dd', {}, st.host.version),
      h('dt', { class: 'k' }, 'Data folder'), h('dd', { class: 'row' }, h('span', { class: 'mono path' }, st.dataDir), openBtn('Open', st.dataDir, 'data')),
      h('dt', { class: 'k' }, 'Logs'), h('dd', { class: 'row' }, h('span', { class: 'mono path' }, st.logDir), openBtn('Open', st.logDir, 'logs')))));
}

// ------------------------------------------------------------------ boot
/** Shows a section; from the menu, focus moves to its heading so it's read from the top. */
function go(id, { focus = false } = {}) {
  id = OLD_SECTIONS[id] || id;
  if (!SECTIONS.some(([s]) => s === id)) return;
  current = id;
  history.replaceState(null, '', `#${id}`);
  document.title = `${SECTIONS.find(([s]) => s === id)[1]} — Headroom Server`;
  if (st) {
    renderNav();
    render();
    if (focus) document.querySelector('#content h2')?.focus({ preventScroll: true });
    document.getElementById('content').scrollTop = 0;
  }
}
const fromHash = OLD_SECTIONS[location.hash.slice(1)] || location.hash.slice(1);
if (SECTIONS.some(([id]) => id === fromHash)) current = fromHash;
window.addEventListener('hashchange', () => go(location.hash.slice(1)));
native?.on(m => {
  if (m?.cmd === 'navigate') go(m.section, { focus: true });
  if (m?.cmd === 'loginItem') { loginItem = !!m.enabled; if (st && current === 'settings') refresh({ force: true }); }
});
postNative({ cmd: 'getLoginItem' });
refresh().then(() => { document.title = `${SECTIONS.find(([s]) => s === current)[1]} — Headroom Server`; });
setInterval(refresh, 2000);
