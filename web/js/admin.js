// Headroom Server's window. Runs on the host (loopback-only /api/admin) — inside the tray app's WebView2 window
// (Windows), the menu-bar app's WKWebView window (Mac), or any browser on the computer at http://localhost:7080/.
// Four sections: Home (who's connected), Let someone connect (guest codes), Account, Settings.
import { h, svg } from './ui/dom.js';
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
};

const SECTIONS = [['home', 'Home'], ['connect', 'Let someone connect'], ['account', 'Account'], ['settings', 'Settings']];
const OLD_SECTIONS = { status: 'home', support: 'connect', pair: 'connect', devices: 'account', security: 'account', features: 'settings', quality: 'settings', connection: 'settings', about: 'settings' };

let st = null;            // last /status
let current = 'home';
let accountNote = null;   // { ok, text } — result of the last account action, shown until the next one
let codeError = '';
let loginItem = null;     // Start at login (native window only): true/false, or null when unknown
const choices = {};       // request id -> { files, clipboard }: kept while the page redraws

// ------------------------------------------------------------------ api
async function api(path, opts = {}) {
  const r = await fetch(`/api/admin${path}`, { headers: { 'Content-Type': 'application/json' }, cache: 'no-store', ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(body.message || body.error || `HTTP ${r.status}`); e.body = body; throw e; }
  return body;
}
const post = (path, body) => api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
const saveSettings = patch => post('/settings', patch).then(refresh);

/** What's on screen depends on the status; while typing, only Home redraws (others keep their fields). */
async function refresh() {
  try {
    st = await api('/status');
  } catch (e) {
    st = null;
    renderOffline(e.message);
    return;
  }
  renderNav();
  document.getElementById('side-host').textContent = st.host.name;
  document.getElementById('side-foot').textContent = `v${st.host.version}`;
  const typing = document.activeElement && document.getElementById('content').contains(document.activeElement) && document.activeElement.matches('input[type=text], input[type=email], input[type=password]');
  if (!typing) render();
  postNative({ cmd: 'status', viewers: st.sessions.length, names: st.sessions.map(s => s.device) });
}

// ------------------------------------------------------------------ chrome
function renderNav() {
  const nav = document.getElementById('nav');
  const waiting = st?.support?.requests?.length || 0;
  nav.replaceChildren(...SECTIONS.map(([id, label]) => {
    const n = id === 'home' ? (st?.sessions.length || 0) + waiting : 0;
    const b = h('button', { class: 'nav-item', type: 'button', 'aria-current': id === current ? 'page' : null },
      svg(ICON[id], 18), label, n ? h('span', { class: 'count' }, n) : null);
    b.onclick = () => { go(id); document.getElementById('content').focus(); };
    return b;
  }));
}

function renderOffline(message) {
  document.getElementById('nav').replaceChildren();
  const c = document.getElementById('content');
  c.replaceChildren(h('section', {},
    h('div', { class: 'card' }, h('div', { class: 'hero down' }, h('div', { class: 'ring' }, svg(ICON.down, 28)),
      h('div', {}, h('div', { class: 'title' }, 'Headroom Server isn\'t running'),
        h('div', { class: 'muted small' }, native ? 'Start it here, or from the Headroom icon in the menu bar / notification area.' : `This page talks to Headroom Server on this computer (${message}).`))),
      native ? h('div', { class: 'row', style: { marginTop: '14px' } }, h('button', { class: 'primary', onclick: () => postNative({ cmd: 'startServer' }) }, 'Start server')) : null)));
}

function render() {
  const c = document.getElementById('content');
  const views = { home: viewHome, connect: viewConnect, account: viewAccount, settings: viewSettings };
  c.replaceChildren(views[current]());
}

// ------------------------------------------------------------------ helpers
const ago = d => {
  if (!d) return 'never';
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(d).toLocaleDateString();
};
const countryName = code => {
  if (!code) return '';
  try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) || code; } catch { return code; }
};
const where = x => [x.country ? `${countryName(x.country)} (approximate)` : '', (x.address || x.remoteAddress || '').replace(' (via relay)', '')].filter(Boolean).join(' · ');
const prettyCode = c => String(c || '').replace(/(\d{3})(?=\d)/g, '$1 ');
const site = () => (st?.relay?.site || '').replace(/^https?:\/\//, '');

function copyBtn(text, label = 'Copy') {
  const b = h('button', { class: 'sm copy', type: 'button' }, label);
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(text); } catch { postNative({ cmd: 'copy', text }); }
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = label; }, 1500);
  };
  return b;
}

function toggle(checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.onchange = () => onChange(input.checked);
  return h('label', { class: 'switch' }, input, h('span'));
}

function switchRow(title, sub, checked, onChange) {
  return h('div', { class: 'switch-row' }, h('div', { class: 'main' }, h('div', { class: 't' }, title), sub ? h('div', { class: 's' }, sub) : null), toggle(checked, onChange));
}

function checkbox(label, checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.onchange = () => onChange(input.checked);
  return { input, el: h('label', { class: 'check' }, input, ' ', label) };
}

function qrBox(text) {
  const box = h('div', { class: 'qr', title: text });
  box.innerHTML = QrCode.encode(text, 'M').toSvg({ border: 2 });
  return box;
}

function openExternal(url) {
  if (native) postNative({ cmd: 'openUrl', url }); else window.open(url, '_blank', 'noopener');
}

// ------------------------------------------------------------------ Home

/** Someone with your code is waiting: Accept, View only or Decline, choosing what else they may do. */
function requestsCard() {
  const reqs = st.support?.requests || [];
  if (!reqs.length) return null;
  return h('div', { class: 'card attention' }, h('h3', {}, 'Someone wants to connect'),
    h('div', { class: 'list' }, ...reqs.map(r => {
      const ch = choices[r.id] ||= { files: false, clipboard: false };
      const files = checkbox('Let them transfer files', ch.files, v => { ch.files = v; });
      const clip = checkbox('Share clipboard', ch.clipboard, v => { ch.clipboard = v; });
      const answer = (accept, viewOnly) => post(`/support/requests/${r.id}`, { accept, viewOnly, files: files.input.checked, clipboard: clip.input.checked }).catch(() => { }).then(refresh);
      return h('div', { class: 'li request' },
        h('div', { class: 'main' },
          h('div', { class: 't' }, `“${r.name}” wants to see and control ${thisPc()}`),
          h('div', { class: 's' }, 'Name not verified', where(r) ? ` · from ${where(r)}` : '', ` · asked ${ago(r.created)}`),
          h('div', { class: 's warn-line' }, svg(ICON.warn, 14), ' Only accept if you know them and asked for help. Scammers pretend to be support and ask for codes.'),
          h('div', { class: 'row checks' }, files.el, clip.el)),
        h('div', { class: 'row' },
          h('button', { class: 'sm danger', type: 'button', onclick: () => answer(false, false) }, 'Decline'),
          h('button', { class: 'sm', type: 'button', onclick: () => answer(true, true) }, 'View only'),
          h('button', { class: 'sm primary', type: 'button', onclick: () => answer(true, false) }, 'Accept')));
    })));
}

function sessionRow(s) {
  const r = s.rights || {};
  const set = patch => post(`/sessions/${s.id}/rights`, patch).then(refresh).catch(() => { });
  return h('div', { class: 'li' },
    h('div', { class: 'main' },
      h('div', { class: 't' }, s.device || 'Someone', h('span', { class: `badge ${s.guest ? 'warn' : 'ok'}`, style: { marginLeft: '8px' } }, s.guest ? 'Guest (code)' : 'Your account')),
      h('div', { class: 's' }, `${where(s)} · since ${new Date(s.connectedAt).toLocaleTimeString()}`),
      s.guest ? h('div', { class: 'row checks' },
        h('span', { class: 'small' }, 'Control'), toggle(r.input, v => set({ input: v })),
        h('span', { class: 'small' }, 'Files'), toggle(r.files, v => set({ files: v })),
        h('span', { class: 'small' }, 'Clipboard'), toggle(r.clipboard, v => set({ clipboard: v }))) : null),
    h('button', { class: 'sm danger', type: 'button', onclick: () => post(`/sessions/${s.id}/disconnect`).then(refresh) }, 'Stop'));
}

function viewHome() {
  const n = st.sessions.length;
  const perms = st.permissions;
  const missing = mac() && perms && (!perms.screenRecording || !perms.accessibility);
  const relay = st.relay || {};
  const hero = h('div', { class: `hero ${n ? 'live' : 'ready'}` },
    h('div', { class: 'ring' }, svg(n ? ICON.live : ICON.check, 28)),
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, n ? `${n === 1 ? `${st.sessions[0].device || 'Someone'} is` : `${n} people are`} connected` : 'Nobody is connected'),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        st.account ? h('span', { class: 'badge ok' }, `Signed in as ${st.account.email}`) : h('span', { class: 'badge' }, 'Not signed in'),
        relay.state === 'online' ? h('span', { class: 'badge ok' }, 'Online') : h('span', { class: 'badge warn' }, relay.state === 'retrying' ? 'Offline — retrying' : 'Connecting…'),
        missing ? h('span', { class: 'badge warn' }, 'Needs permission') : null,
        st.testPattern ? h('span', { class: 'badge warn' }, 'Test pattern') : null)),
    n ? h('button', { class: 'danger', type: 'button', onclick: () => post('/sessions/disconnect-all').then(refresh) }, n > 1 ? 'Stop all' : 'Stop') : null);
  const next = !st.account && !n ? h('div', { class: 'card' }, h('h3', {}, 'Get started'),
    h('div', { class: 'list' },
      h('div', { class: 'li' }, h('div', { class: 'main' }, h('div', { class: 't' }, 'Reach this computer from your other devices'),
        h('div', { class: 's' }, `Sign in with your Headroom account. Then it's in your list at ${site() || 'the Headroom website'} and in Headroom Viewer.`)),
      h('button', { class: 'sm primary', type: 'button', onclick: () => go('account') }, 'Sign in')),
      h('div', { class: 'li' }, h('div', { class: 'main' }, h('div', { class: 't' }, 'Let someone help you'),
        h('div', { class: 's' }, 'Give them a code. They connect from their browser — no account, no download — after you accept.')),
      h('button', { class: 'sm', type: 'button', onclick: () => go('connect') }, 'Get a code')))) : null;
  return h('section', {}, h('h2', {}, 'Home'),
    requestsCard(),
    h('div', { class: 'card' }, hero),
    n ? h('div', { class: 'card' }, h('h3', {}, 'Connected now'), h('div', { class: 'list' }, ...st.sessions.map(sessionRow))) : null,
    missing ? permissionsCard() : null,
    next);
}

// ------------------------------------------------------------------ Let someone connect

function viewConnect() {
  const relay = st.relay || {}, code = st.support?.code;
  const online = relay.state === 'online';
  const card = h('div', { class: 'card' });
  const draw = () => {
    const c = st.support?.code;
    const left = c ? Math.max(0, Math.round((new Date(c.expiresAt) - Date.now()) / 1000)) : 0;
    if (!c || !left) {
      card.replaceChildren(
        h('p', {}, `Give someone this code and they can connect to ${thisPc()} from their browser. No account or download for them.`),
        h('ul', { class: 'steps small' },
          h('li', {}, `They open ${site() || 'the Headroom website'} and enter the code (or you send them the link).`),
          h('li', {}, `${ThisPc()} asks you to accept, and you choose what they can do. Nobody gets in without you clicking Accept.`),
          h('li', {}, 'You can stop the session at any time.')),
        h('div', { class: 'row' }, h('button', {
          class: 'primary', type: 'button', disabled: !online || null, onclick: async e => {
            e.target.disabled = true;
            codeError = '';
            try { await post('/support/code'); } catch (ex) { codeError = ex.message; }
            refresh();
          },
        }, 'Create a code')),
        !online ? h('p', { class: 'small muted' }, `Connecting to Headroom…${relay.error ? ` (${relay.error})` : ''}`) : null,
        codeError ? h('div', { class: 'msg err' }, codeError) : null);
      return;
    }
    card.replaceChildren(h('div', { class: 'pair-grid' }, qrBox(c.link),
      h('div', {},
        h('div', { class: 'muted small' }, 'Your code'),
        h('div', { class: 'code-big' }, prettyCode(c.code)),
        h('div', { class: 'muted small' }, `For one person · expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`),
        h('p', { class: 'small' }, `They enter it at ${site()}, or open the link:`),
        h('p', { class: 'small mono', style: { wordBreak: 'break-all' } }, c.link),
        h('div', { class: 'row' }, copyBtn(c.code, 'Copy code'), copyBtn(c.link, 'Copy link'),
          h('button', { class: 'sm', type: 'button', onclick: () => api('/support/code', { method: 'DELETE' }).then(refresh) }, 'Stop sharing')))));
  };
  draw();
  const tick = setInterval(() => { if (!card.isConnected) clearInterval(tick); else if (st.support?.code) draw(); }, 1000);
  return h('section', {}, h('h2', {}, 'Let someone connect'),
    h('p', { class: 'lead' }, 'For help from someone, or to reach this computer from a browser that isn\'t signed in.'),
    requestsCard(), card,
    code ? h('p', { class: 'small muted' }, 'Only give the code to someone you know. Nobody from Headroom will ever ask you for it.') : null);
}

// ------------------------------------------------------------------ Account

const ACCOUNT_ERRORS = {
  'bad-credentials': 'Wrong email or password.',
  'bad-totp': 'That code didn\'t work. Wait for the next one and try again.',
  'rate-limited': 'Too many attempts. Try again in a minute.',
};

async function redraw() {
  try { st = await api('/status'); } catch (e) { renderOffline(e.message); return; }
  renderNav();
  render();
}

function viewAccount() {
  const a = st.account;
  const m = h('div', { class: accountNote ? `msg ${accountNote.ok ? 'ok' : 'err'}` : 'msg' }, accountNote?.text || '');
  if (a) {
    const name = h('input', { type: 'text', value: st.settings.displayName || '', placeholder: st.host.machine, class: 'grow', maxlength: '64', 'aria-label': `${ThisPc()}'s name` });
    const saved = h('div', { class: 'msg' });
    return h('section', {}, h('h2', {}, 'Account'),
      h('p', { class: 'lead' }, `${ThisPc()} is one of your devices. Sign in at ${site()} or in Headroom Viewer on any device to see it and connect.`),
      h('div', { class: 'card' }, h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'Signed in as'), h('div', {}, a.email),
        h('div', { class: 'k' }, 'Last check-in'), h('div', {}, a.error ? h('span', {}, h('span', { class: 'badge warn' }, 'Problem'), ` ${a.error}`) : ago(a.lastSync))),
        h('div', { class: 'row', style: { marginTop: '12px' } },
          h('button', {
            class: 'danger', type: 'button', onclick: async () => {
              if (!confirm(`Sign ${thisPc()} out of ${a.email}? It leaves your list of devices. Guest codes keep working.`)) return;
              await post('/account/leave').catch(() => { });
              accountNote = null;
              redraw();
            },
          }, 'Sign out')), m),
      h('div', { class: 'card' }, h('h3', {}, `${ThisPc()}'s name`),
        h('p', { class: 'small muted' }, 'How it\'s listed in your account and shown to people who connect.'),
        h('div', { class: 'row' }, name, h('button', {
          type: 'button', onclick: async () => {
            await saveSettings({ displayName: name.value });
            saved.className = 'msg ok'; saved.textContent = 'Saved.';
          },
        }, 'Save')), saved));
  }
  const email = h('input', { type: 'email', class: 'grow', placeholder: 'Email', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Email' });
  const pass = h('input', { type: 'password', class: 'grow', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const totp = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '123456', autocomplete: 'one-time-code', 'aria-label': 'Authenticator code' });
  const totpRow = h('div', { class: 'row', hidden: true }, h('span', { class: 'small' }, 'Code from your authenticator app'), totp);
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
  const form = h('form', {}, h('div', { class: 'row' }, email, pass), totpRow, h('div', { class: 'row' }, submit), m);
  form.onsubmit = async e => {
    e.preventDefault();
    m.className = 'msg'; m.textContent = 'Signing in…';
    submit.disabled = true;
    try {
      const r = await post('/account/join', { email: email.value.trim(), password: pass.value, totp: totp.value.trim() || undefined });
      accountNote = { ok: true, text: `Signed in as ${r.email}. ${ThisPc()} is now in your account.` };
      redraw();
    } catch (ex) {
      m.className = 'msg err';
      const b = ex.body || {};
      if (b.error === 'totp-required') { totpRow.hidden = false; totp.focus(); m.textContent = 'This account uses two-factor sign-in: enter the code from your authenticator app.'; }
      else m.textContent = ACCOUNT_ERRORS[b.error] || ex.message;
    } finally { submit.disabled = false; }
  };
  const web = path => h('button', { type: 'button', class: 'link-btn', onclick: () => openExternal(`${st.relay.site}/${path}`) });
  return h('section', {}, h('h2', {}, 'Account'),
    h('p', { class: 'lead' }, `Sign in with your Headroom account to add ${thisPc()} to it. Then it's in your list on every device where you're signed in — click it to connect, from anywhere.`),
    h('div', { class: 'card' }, h('h3', {}, 'Sign in'), form,
      h('p', { class: 'small muted', style: { marginTop: '12px' } },
        Object.assign(web('#signup'), { textContent: 'Create an account' }), ' · ', Object.assign(web('#forgot'), { textContent: 'Forgot password?' }),
        ` (opens ${site()})`)),
    h('p', { class: 'small muted' }, `Your password goes only to Headroom; ${thisPc()} gets its own sign-in, which you can remove from any device (Account → Your devices).`));
}

// ------------------------------------------------------------------ Settings

/** Mac: the two privacy permissions, with shortcuts to grant them. */
function permissionsCard() {
  const p = st.permissions || {};
  const item = (ok, title, sub, kind, url) => h('div', { class: 'li' },
    h('div', { class: 'main' }, h('div', { class: 't' }, title, ' ', h('span', { class: `badge ${ok ? 'ok' : 'warn'}` }, ok ? 'Allowed' : 'Not allowed')),
      h('div', { class: 's' }, sub)),
    ok ? null : h('button', { class: 'sm', type: 'button', onclick: () => post('/permissions/request', { kind }).then(refresh) }, 'Ask macOS'),
    ok ? null : h('button', { class: 'sm primary', type: 'button', onclick: () => openExternal(url) }, 'Open System Settings'));
  return h('div', { class: 'card' }, h('h3', {}, 'macOS permissions'),
    h('div', { class: 'list' },
      item(p.screenRecording, 'Screen Recording', 'Lets people who connect see the screen and hear its sound.', 'screen', p.screenRecordingUrl),
      item(p.accessibility, 'Accessibility', 'Lets people who connect control the mouse and keyboard.', 'accessibility', p.accessibilityUrl)),
    p.screenRecording && p.accessibility ? null : h('p', { class: 'small muted' },
      'Turn on Headroom Server in each list (System Settings → Privacy & Security). macOS applies Screen Recording after Headroom Server restarts.'));
}

function viewSettings() {
  const v = st.settings.video, p = st.settings.permissions;
  const sel = (value, options, onChange) => {
    const s = h('select', { class: 'inline' }, ...options.map(([val, label]) => h('option', { value: String(val) }, label)));
    s.value = String(value);
    s.onchange = () => onChange(s.value);
    return s;
  };
  const row = (title, sub, control) => h('div', { class: 'switch-row' }, h('div', { class: 'main' }, h('div', { class: 't' }, title), h('div', { class: 's' }, sub)), control);
  const openBtn = (label, path) => native ? h('button', { class: 'sm', type: 'button', onclick: () => postNative({ cmd: 'openFolder', path }) }, label) : null;
  return h('section', {}, h('h2', {}, 'Settings'),
    h('div', { class: 'card' }, h('h3', {}, 'General'),
      loginItem !== null ? switchRow('Start at login', `Keeps ${thisPc()} reachable after a restart.`, loginItem, x => { loginItem = x; postNative({ cmd: 'loginItem', enabled: x }); }) : null,
      switchRow('Notify when someone connects', `A notification on ${thisPc()} each time a session starts or ends.`, st.settings.notifyOnConnect !== false, x => saveSettings({ notifyOnConnect: x })),
      mac() ? switchRow('Lock this Mac when the last person disconnects', 'So nobody walks up to an unlocked screen afterwards.', st.settings.lockOnDisconnect, x => saveSettings({ lockOnDisconnect: x })) : null),
    h('div', { class: 'card' }, h('h3', {}, 'Your devices may'),
      h('p', { class: 'small muted' }, 'For devices signed in to your account. Guests get what you allow when you accept them.'),
      switchRow('Control', 'Off = they can watch but not use the mouse or keyboard.', p.input, x => saveSettings({ input: x })),
      switchRow('Clipboard', 'Copy on one side, paste on the other (text).', p.clipboard, x => saveSettings({ clipboard: x })),
      switchRow('Files', `Browse, download and upload files on ${thisPc()}.`, p.fileTransfer, x => saveSettings({ fileTransfer: x })),
      switchRow('Sound', `Hear ${thisPc()}'s audio.`, st.settings.audio.enabled, x => saveSettings({ audio: x }))),
    h('div', { class: 'card' }, h('h3', {}, 'Quality'),
      h('p', { class: 'small muted' }, 'Upper limits. Each session adapts below these to its connection.'),
      row('Encoder', mac() ? 'Hardware uses the Mac\'s built-in video encoder (fastest). Software works everywhere.' : 'Hardware uses your graphics card (fastest). Software works everywhere.', sel(v.encoder, [['auto', 'Automatic'], ['hardware', 'Hardware only'], ['software', 'Software']], x => saveSettings({ encoder: x }))),
      row('Maximum frame rate', 'Higher is smoother but uses more bandwidth.', sel(v.maxFps, [[30, '30 fps'], [60, '60 fps'], [120, '120 fps'], [144, '144 fps'], [240, '240 fps']], x => saveSettings({ maxFps: +x }))),
      row('Maximum bitrate', 'Caps bandwidth per session.', sel(v.maxBitrateKbps, [[10000, '10 Mb/s'], [20000, '20 Mb/s'], [40000, '40 Mb/s'], [80000, '80 Mb/s'], [150000, '150 Mb/s']], x => saveSettings({ maxBitrateKbps: +x })))),
    mac() ? permissionsCard() : null,
    h('div', { class: 'card' }, h('h3', {}, 'About'), h('div', { class: 'kv' },
      h('div', { class: 'k' }, 'Version'), h('div', {}, st.host.version),
      h('div', { class: 'k' }, 'Data folder'), h('div', { class: 'row' }, h('span', { class: 'mono' }, st.dataDir), openBtn('Open', st.dataDir)),
      h('div', { class: 'k' }, 'Logs'), h('div', { class: 'row' }, h('span', { class: 'mono' }, st.logDir), openBtn('Open', st.logDir)))));
}

// ------------------------------------------------------------------ boot
function go(id) {
  id = OLD_SECTIONS[id] || id;
  if (!SECTIONS.some(([s]) => s === id)) return;
  current = id;
  history.replaceState(null, '', `#${id}`);
  if (st) { renderNav(); render(); }
}
const fromHash = OLD_SECTIONS[location.hash.slice(1)] || location.hash.slice(1);
if (SECTIONS.some(([id]) => id === fromHash)) current = fromHash;
window.addEventListener('hashchange', () => go(location.hash.slice(1)));
native?.on(m => {
  if (m?.cmd === 'navigate') go(m.section);
  if (m?.cmd === 'loginItem') { loginItem = !!m.enabled; if (st && current === 'settings') render(); }
});
postNative({ cmd: 'getLoginItem' });
refresh();
setInterval(refresh, 2000);
