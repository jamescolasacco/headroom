// Headroom Server settings window. Runs on the host (loopback-only /api/admin) — inside the tray app's
// WebView2 window, or in any browser at http://localhost:7080/admin.html.
import { h, svg } from './ui/dom.js';
import { QrCode } from './qr.js';

const native = window.chrome?.webview || null;   // present when hosted by HeadroomServer.exe
const postNative = msg => native?.postMessage(msg);

const ICON = {
  status: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  pair: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  devices: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  security: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  features: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  quality: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  connection: '<path d="M5 12.55a11 11 0 0 1 14 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
  about: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  live: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><circle cx="12" cy="10.5" r="2.5"/>',
  down: '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
};

const SECTIONS = [
  ['status', 'Status'], ['pair', 'Pair a device'], ['devices', 'Devices'], ['security', 'Security'],
  ['features', 'Features'], ['quality', 'Quality'], ['connection', 'Connection'], ['about', 'About'],
];

let st = null;            // last /status
let current = 'status';
let pairState = null;     // { code, expires, urls }
let totpSetup = null;     // { secret, uri }
let pollTimer = 0;

// ------------------------------------------------------------------ api
async function api(path, opts = {}) {
  const r = await fetch(`/api/admin${path}`, { headers: { 'Content-Type': 'application/json' }, cache: 'no-store', ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}
const post = (path, body) => api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
const saveSettings = patch => post('/settings', patch).then(refresh);

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
  if (!document.activeElement || !document.getElementById('content').contains(document.activeElement) || current === 'status') render();
  postNative({ cmd: 'status', viewers: st.sessions.length, names: st.sessions.map(s => s.device) });
}

// ------------------------------------------------------------------ chrome
function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...SECTIONS.map(([id, label]) => {
    const b = h('button', { class: 'nav-item', type: 'button', 'aria-current': id === current ? 'page' : null },
      svg(ICON[id === 'pair' ? 'pair' : id], 18), label,
      id === 'status' && st?.sessions.length ? h('span', { class: 'count' }, st.sessions.length) : null);
    b.onclick = () => { go(id); document.getElementById('content').focus(); };
    return b;
  }));
}

function renderOffline(message) {
  document.getElementById('nav').replaceChildren();
  const c = document.getElementById('content');
  c.replaceChildren(h('section', {},
    h('div', { class: 'card' }, h('div', { class: 'hero down' }, h('div', { class: 'ring' }, svg(ICON.down, 28)),
      h('div', {}, h('div', { class: 'title' }, 'The Headroom server isn\'t running'),
        h('div', { class: 'muted small' }, native ? 'Start it from the tray icon menu, or restart the Headroom service.' : `This page talks to the server on this PC (${message}).`))),
      native ? h('div', { class: 'row', style: { marginTop: '14px' } }, h('button', { class: 'primary', onclick: () => postNative({ cmd: 'startServer' }) }, 'Start server')) : null)));
}

function render() {
  const c = document.getElementById('content');
  const views = { status: viewStatus, pair: viewPair, devices: viewDevices, security: viewSecurity, features: viewFeatures, quality: viewQuality, connection: viewConnection, about: viewAbout };
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

function copyBtn(text) {
  const b = h('button', { class: 'sm copy', type: 'button' }, 'Copy');
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { postNative({ cmd: 'copy', text }); b.textContent = 'Copied'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
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

function qrBox(text) {
  const box = h('div', { class: 'qr', title: text });
  box.innerHTML = QrCode.encode(text, 'M').toSvg({ border: 2 });
  return box;
}

function preferredUrl() {
  return st.urls.find(u => u.includes('.ts.net')) || st.urls.find(u => /https:\/\/\d+\.\d+\.\d+\.\d+/.test(u)) || st.urls[0];
}

// ------------------------------------------------------------------ views
function viewStatus() {
  const n = st.sessions.length;
  const hero = h('div', { class: `hero ${n ? 'live' : 'ready'}` },
    h('div', { class: 'ring' }, svg(n ? ICON.live : ICON.check, 28)),
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, n ? `${n} viewer${n > 1 ? 's' : ''} connected` : 'Ready for connections'),
      h('div', { class: 'row', style: { marginTop: '6px' } },
        st.elevated ? h('span', { class: 'badge ok' }, 'Service mode') : h('span', { class: 'badge warn' }, 'User mode'),
        h('span', { class: 'badge' }, `${st.devices.length} paired device${st.devices.length === 1 ? '' : 's'}`),
        st.tailscale ? h('span', { class: 'badge ok' }, 'Tailscale') : null)));
  const modeTip = st.elevated ? null : h('p', { class: 'small muted', style: { marginTop: '12px' } },
    st.serviceInstalled
      ? 'The Headroom service is installed but this window is talking to a user-mode server. Stop it so the service can take over.'
      : 'In user mode, UAC prompts and the lock screen can\'t be shown or controlled. Install service mode (run install.ps1 as administrator) for full unattended access.');

  const viewers = h('div', { class: 'list' }, ...(n ? st.sessions.map(s => h('div', { class: 'li' },
    h('div', { class: 'main' }, h('div', { class: 't' }, s.device || 'Viewer'), h('div', { class: 's' }, `${s.remoteAddress} · since ${new Date(s.connectedAt).toLocaleTimeString()}`)),
    h('button', { class: 'sm danger', type: 'button', onclick: () => post(`/sessions/${s.id}/disconnect`).then(refresh) }, 'Disconnect'))) : [h('div', { class: 'empty' }, 'Nobody is connected.')]));

  const addrs = h('div', { class: 'list' }, ...st.urls.map(u => h('div', { class: 'li' },
    h('div', { class: 'main' }, h('div', { class: 't mono' }, u), h('div', { class: 's' }, u.includes('.ts.net') ? 'Tailscale — works anywhere, no certificate setup' : u.includes('.local') ? 'Local network name' : 'Local network address')),
    copyBtn(u))));

  return h('section', {},
    h('h2', {}, 'Status'), h('p', { class: 'lead' }, 'Headroom lets your other devices see and control this PC.'),
    h('div', { class: 'card' }, hero, modeTip),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow', style: { margin: 0 } }, 'Connected viewers'),
      n > 1 ? h('button', { class: 'sm danger', type: 'button', onclick: () => post('/sessions/disconnect-all').then(refresh) }, 'Disconnect everyone') : null), viewers),
    h('div', { class: 'card' }, h('h3', {}, 'Connect from another device'), addrs,
      h('p', { class: 'small muted' }, 'New device? Use “Pair a device” to get a code or scan a QR code.')));
}

function viewPair() {
  const card = h('div', { class: 'card' });
  const draw = () => {
    card.replaceChildren();
    if (!pairState || pairState.expires < Date.now()) {
      pairState = null;
      card.append(h('h3', {}, 'One-time pairing code'),
        h('p', { class: 'muted small' }, 'Works once, for 10 minutes. No password needed — handy for your phone.'),
        h('button', { class: 'primary', type: 'button', onclick: async () => {
          const r = await post('/paircode');
          pairState = { code: r.code, expires: Date.now() + r.expiresInSeconds * 1000, urls: r.urls };
          draw();
        } }, 'Create pairing code'));
      return;
    }
    const pretty = `${pairState.code.slice(0, 5)}-${pairState.code.slice(5)}`;
    const link = pairState.urls.find(u => u.startsWith(preferredUrl())) || pairState.urls[0];
    const left = Math.max(0, Math.round((pairState.expires - Date.now()) / 1000));
    card.append(h('div', { class: 'pair-grid' }, qrBox(link),
      h('div', {},
        h('div', { class: 'muted small' }, 'Scan with the phone\'s camera, or enter this code in Headroom:'),
        h('div', { class: 'code-big' }, pretty),
        h('div', { class: 'muted small' }, `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`),
        h('p', { class: 'small mono', style: { wordBreak: 'break-all' } }, link),
        h('div', { class: 'row' }, copyBtn(link), h('button', { class: 'sm', type: 'button', onclick: () => { pairState = null; draw(); } }, 'Cancel')))));
  };
  draw();
  const tick = setInterval(() => { if (!card.isConnected) clearInterval(tick); else if (pairState) draw(); }, 1000);

  const lanIp = st.lanAddresses[0];
  const trustUrl = lanIp ? `http://${lanIp}:${st.httpPort}/` : null;
  const trust = h('div', { class: 'card' },
    h('h3', {}, 'First time on a phone or tablet?'),
    st.tailscale
      ? h('p', { class: 'small' }, 'If the device uses Tailscale, nothing to set up — the pairing QR above opens your tailnet address with a real certificate.')
      : null,
    trustUrl ? h('div', { class: 'pair-grid' }, qrBox(trustUrl), h('div', {},
      h('p', { class: 'small' }, 'On your home network, the device must trust this PC\'s certificate once:'),
      h('ol', { class: 'steps small' },
        h('li', {}, 'Scan this code (opens ', h('span', { class: 'mono' }, trustUrl), ' in Safari).'),
        h('li', {}, 'Download the profile, then install it in Settings → General → VPN & Device Management.'),
        h('li', {}, 'Turn it on in Settings → General → About → Certificate Trust Settings.'),
        h('li', {}, 'Scan the pairing code above, then Share → Add to Home Screen.')))) : h('p', { class: 'muted small' }, 'No local network address found.'));

  return h('section', {}, h('h2', {}, 'Pair a device'),
    h('p', { class: 'lead' }, 'Each phone, tablet or computer pairs once; after that it connects with its own key, which you can revoke any time.'),
    card, trust,
    h('div', { class: 'card' }, h('h3', {}, 'Or use the password'),
      h('p', { class: 'small muted' }, st.hasPassword ? 'Any device can also pair with the password (Security section).' : 'No password is set yet — set one in Security if you want to pair without a code.')));
}

function viewDevices() {
  const rows = st.devices.length ? st.devices.map(d => {
    const online = st.sessions.some(s => s.deviceId === d.id);
    return h('div', { class: 'li' },
      h('div', { class: 'main' }, h('div', { class: 't' }, d.name, online ? h('span', { class: 'badge ok', style: { marginLeft: '8px' } }, 'connected') : null),
        h('div', { class: 's' }, `Last seen ${ago(d.lastSeen)}${d.lastAddress ? ' from ' + d.lastAddress : ''} · paired ${new Date(d.created).toLocaleDateString()}`)),
      h('label', { class: 'small muted', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, 'View only',
        toggle(d.viewOnly, v => post(`/devices/${d.id}/viewonly`, { viewOnly: v }).then(refresh))),
      h('button', { class: 'sm danger', type: 'button', onclick: async () => {
        if (!confirm(`Revoke ${d.name}? It will be disconnected and must pair again.`)) return;
        await api(`/devices/${d.id}`, { method: 'DELETE' });
        refresh();
      } }, 'Revoke'));
  }) : [h('div', { class: 'empty' }, 'No devices yet. Pair one from “Pair a device”.')];
  return h('section', {}, h('h2', {}, 'Devices'),
    h('p', { class: 'lead' }, 'Everything that can connect to this PC. View-only devices can watch but not control.'),
    h('div', { class: 'card' }, h('div', { class: 'list' }, ...rows)));
}

function viewSecurity() {
  const msg = h('div', { class: 'msg' });
  const p1 = h('input', { type: 'password', class: 'grow', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
  const p2 = h('input', { type: 'password', class: 'grow', placeholder: 'Repeat', autocomplete: 'new-password' });
  const pwForm = h('form', {}, h('div', { class: 'row' }, p1, p2, h('button', { class: 'primary', type: 'submit' }, 'Save')), msg);
  pwForm.onsubmit = async e => {
    e.preventDefault();
    if (p1.value !== p2.value) { msg.className = 'msg err'; msg.textContent = 'Passwords don\'t match.'; return; }
    try { await post('/password', { password: p1.value }); msg.className = 'msg ok'; msg.textContent = 'Password saved.'; p1.value = p2.value = ''; refresh(); }
    catch (ex) { msg.className = 'msg err'; msg.textContent = ex.message; }
  };

  const totpCard = h('div', { class: 'card' });
  const drawTotp = () => {
    totpCard.replaceChildren(h('h3', {}, 'Two-factor pairing'));
    if (st.totpEnabled) {
      totpCard.append(h('p', { class: 'small' }, h('span', { class: 'badge ok' }, 'On'), ' Pairing with the password also needs a 6-digit code from your authenticator app.'),
        h('button', { class: 'danger', type: 'button', onclick: () => post('/totp/disable').then(refresh) }, 'Turn off'));
      return;
    }
    if (!totpSetup) {
      totpCard.append(h('p', { class: 'small muted' }, 'Require a code from an authenticator app (Google Authenticator, 1Password, Authy…) when pairing with the password. Pairing codes and already-paired devices are unaffected.'),
        h('button', { type: 'button', onclick: async () => { totpSetup = await post('/totp/setup'); drawTotp(); } }, 'Set up'));
      return;
    }
    const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '123456', style: { maxWidth: '140px' } });
    const m = h('div', { class: 'msg' });
    totpCard.append(h('div', { class: 'pair-grid' }, qrBox(totpSetup.uri), h('div', {},
      h('p', { class: 'small' }, 'Scan with your authenticator app, then enter the code it shows.'),
      h('p', { class: 'small mono' }, totpSetup.secret.replace(/(.{4})/g, '$1 ').trim()),
      h('div', { class: 'row' }, code, h('button', { class: 'primary', type: 'button', onclick: async () => {
        try { await post('/totp/enable', { code: code.value }); totpSetup = null; refresh(); }
        catch (ex) { m.className = 'msg err'; m.textContent = ex.message; }
      } }, 'Verify & turn on'), h('button', { type: 'button', onclick: () => { totpSetup = null; drawTotp(); } }, 'Cancel')), m)));
  };
  drawTotp();

  return h('section', {}, h('h2', {}, 'Security'),
    h('p', { class: 'lead' }, 'The password is only used to pair new devices. Changing it doesn\'t sign out paired devices.'),
    h('div', { class: 'card' }, h('h3', {}, st.hasPassword ? 'Change password' : 'Set a password'), pwForm),
    totpCard,
    h('div', { class: 'card' },
      switchRow('Lock this PC when the last viewer disconnects', 'So nobody walks up to an unlocked screen after a remote session.', st.settings.lockOnDisconnect, v => saveSettings({ lockOnDisconnect: v }))));
}

function viewFeatures() {
  const p = st.settings.permissions;
  return h('section', {}, h('h2', {}, 'Features'), h('p', { class: 'lead' }, 'What connected devices are allowed to do.'),
    h('div', { class: 'card' },
      switchRow('Remote control', 'Off = every device is view-only (watch, no mouse or keyboard).', p.input, v => saveSettings({ input: v })),
      switchRow('Clipboard sync', 'Copy on one side, paste on the other (text).', p.clipboard, v => saveSettings({ clipboard: v })),
      switchRow('File transfer', 'Browse, download and upload files on this PC.', p.fileTransfer, v => saveSettings({ fileTransfer: v })),
      switchRow('Sound', 'Stream this PC\'s audio to the viewer.', st.settings.audio.enabled, v => saveSettings({ audio: v }))));
}

function viewQuality() {
  const v = st.settings.video;
  const sel = (value, options, onChange) => {
    const s = h('select', { class: 'inline' }, ...options.map(([val, label]) => h('option', { value: String(val) }, label)));
    s.value = String(value);
    s.onchange = () => onChange(s.value);
    return s;
  };
  const row = (title, sub, control) => h('div', { class: 'switch-row' }, h('div', { class: 'main' }, h('div', { class: 't' }, title), h('div', { class: 's' }, sub)), control);
  return h('section', {}, h('h2', {}, 'Quality'), h('p', { class: 'lead' }, 'Upper limits. Each viewer adapts below these automatically based on its connection.'),
    h('div', { class: 'card' },
      row('Encoder', 'Hardware uses your graphics card (fastest). Software works everywhere.', sel(v.encoder, [['auto', 'Automatic'], ['hardware', 'Hardware only'], ['software', 'Software']], x => saveSettings({ encoder: x }))),
      row('Maximum frame rate', 'Higher is smoother but uses more bandwidth.', sel(v.maxFps, [[30, '30 fps'], [60, '60 fps'], [120, '120 fps'], [144, '144 fps'], [240, '240 fps']], x => saveSettings({ maxFps: +x }))),
      row('Maximum bitrate', 'Caps bandwidth per viewer.', sel(v.maxBitrateKbps, [[10000, '10 Mb/s'], [20000, '20 Mb/s'], [40000, '40 Mb/s'], [80000, '80 Mb/s'], [150000, '150 Mb/s']], x => saveSettings({ maxBitrateKbps: +x })))));
}

function viewConnection() {
  const thumb = st.caThumbprint.replace(/(.{4})/g, '$1 ').trim();
  return h('section', {}, h('h2', {}, 'Connection'), h('p', { class: 'lead' }, 'How devices reach this PC.'),
    h('div', { class: 'card' }, h('h3', {}, 'Tailscale'),
      st.tailscale
        ? h('p', { class: 'small' }, h('span', { class: 'badge ok' }, 'Ready'), ' ', h('span', { class: 'mono' }, `https://${st.tailscale}:${st.port}/`), ' works from anywhere your devices are signed into Tailscale.')
        : h('p', { class: 'small muted' }, 'Not detected. For access away from home with no port forwarding: install Tailscale on this PC and your devices, then enable MagicDNS and HTTPS Certificates in the Tailscale admin console. Headroom picks it up automatically within a few minutes.')),
    h('div', { class: 'card' }, h('h3', {}, 'This PC\'s certificate'),
      h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'HTTPS port'), h('div', { class: 'mono' }, String(st.port)),
        h('div', { class: 'k' }, 'Setup page (HTTP)'), h('div', { class: 'mono' }, st.lanAddresses.map(a => `http://${a}:${st.httpPort}/`).join('  ') || '—'),
        h('div', { class: 'k' }, 'CA fingerprint'), h('div', { class: 'mono' }, thumb)),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('a', { href: '/headroom-ca.crt', download: 'headroom-ca.crt' }, 'Download certificate'),
        h('a', { href: '/headroom-ca.mobileconfig' }, 'iPhone/iPad profile'))),
    h('div', { class: 'card' }, h('h3', {}, 'Firewall'),
      h('p', { class: 'small muted' }, 'Service mode adds a Windows Firewall rule for private and domain networks. On public Wi-Fi, Headroom stays unreachable unless you use Tailscale.')));
}

function viewAbout() {
  const name = h('input', { type: 'text', value: st.settings.displayName || '', placeholder: st.host.machine, class: 'grow' });
  const m = h('div', { class: 'msg' });
  const openBtn = (label, path) => native ? h('button', { class: 'sm', type: 'button', onclick: () => postNative({ cmd: 'openFolder', path }) }, label) : null;
  return h('section', {}, h('h2', {}, 'About'),
    h('div', { class: 'card' }, h('h3', {}, 'Name shown to viewers'),
      h('div', { class: 'row' }, name, h('button', { type: 'button', onclick: async () => { await saveSettings({ displayName: name.value }); m.className = 'msg ok'; m.textContent = 'Saved.'; } }, 'Save')), m),
    h('div', { class: 'card' }, h('div', { class: 'kv' },
      h('div', { class: 'k' }, 'Version'), h('div', {}, st.host.version),
      h('div', { class: 'k' }, 'Mode'), h('div', {}, st.elevated ? 'Service (SYSTEM)' : 'User'),
      h('div', { class: 'k' }, 'Host ID'), h('div', { class: 'mono' }, st.host.id),
      h('div', { class: 'k' }, 'Data folder'), h('div', { class: 'row' }, h('span', { class: 'mono' }, st.dataDir), openBtn('Open', st.dataDir)),
      h('div', { class: 'k' }, 'Logs'), h('div', { class: 'row' }, h('span', { class: 'mono' }, st.logDir), openBtn('Open', st.logDir)))));
}

// ------------------------------------------------------------------ boot
function go(id) {
  if (!SECTIONS.some(([s]) => s === id)) return;
  current = id;
  history.replaceState(null, '', `#${id}`);
  if (st) { renderNav(); render(); }
}
const fromHash = location.hash.slice(1);
if (SECTIONS.some(([id]) => id === fromHash)) current = fromHash;
window.addEventListener('hashchange', () => go(location.hash.slice(1)));
native?.addEventListener('message', e => { if (e.data?.cmd === 'navigate') go(e.data.section); });
refresh();
pollTimer = setInterval(() => { if (current === 'status' || current === 'devices') refresh(); else api('/status').then(s => { st = s; renderNav(); postNative({ cmd: 'status', viewers: st.sessions.length, names: st.sessions.map(x => x.device) }); }).catch(() => renderOffline('not reachable')); }, 2000);
