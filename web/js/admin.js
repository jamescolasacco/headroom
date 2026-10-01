// Host-side admin page. The /api/admin endpoints only answer requests from this PC (loopback).
const $ = id => document.getElementById(id);

async function api(path, opts = {}) {
  const r = await fetch(`/api/admin${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

const ago = d => {
  if (!d) return 'never';
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(d).toLocaleDateString();
};

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.filter(k => k != null));
  return e;
}

async function load() {
  let st;
  try { st = await api('/status'); } catch (e) {
    $('subtitle').textContent = `Admin is only available on the host PC itself (${e.message}).`;
    return;
  }
  $('title').textContent = st.host.name;
  $('subtitle').textContent = `Headroom ${st.host.version} · ${st.elevated ? 'service mode (lock screen & UAC supported)' : 'user mode'} · port ${st.port}`;
  $('urls').replaceChildren(...st.urls.map(u => el('li', {}, el('a', { href: u, target: '_blank' }, u))));
  $('trust-hint').textContent = st.tailscale
    ? `Tailscale address works on any device in your tailnet with no certificate setup. For LAN addresses, a device must first trust this PC's certificate: open http://<address>:7080/ on it.`
    : `Before the first connection, each device must trust this PC's certificate: open http://<address>:7080/ on it and follow the steps (one time).`;
  $('pw-state').textContent = st.hasPassword ? 'A password is set. Changing it does not unpair existing devices.' : 'No password set — new devices can only pair with a one-time code.';

  const tbody = $('devices');
  tbody.replaceChildren(...(st.devices.length ? st.devices.map(d => {
    const vo = el('input', { type: 'checkbox', checked: d.viewOnly || false });
    vo.addEventListener('change', () => api(`/devices/${d.id}/viewonly`, { method: 'POST', body: JSON.stringify({ viewOnly: vo.checked }) }));
    return el('tr', {},
      el('td', {}, d.name, el('div', { class: 'muted small mono' }, d.id)),
      el('td', {}, ago(d.lastSeen)),
      el('td', { class: 'mono' }, d.lastAddress || ''),
      el('td', {}, vo),
      el('td', {}, el('button', {
        class: 'danger', onclick: async () => {
          if (!confirm(`Revoke ${d.name}? It will be disconnected and must pair again.`)) return;
          await api(`/devices/${d.id}`, { method: 'DELETE' }); load();
        },
      }, 'Revoke')));
  }) : [el('tr', {}, el('td', { colspan: '5', class: 'muted' }, 'No devices yet.'))]));

  $('sessions').replaceChildren(st.sessions.length
    ? el('ul', {}, ...st.sessions.map(s => el('li', {}, `${s.device} from ${s.remoteAddress} since ${new Date(s.connectedAt).toLocaleTimeString()}`)))
    : 'Nobody.');

  const set = st.settings;
  $('s-lock').checked = !!set.lockOnDisconnect;
  $('s-clip').checked = !!set.permissions.clipboard;
  $('s-files').checked = !!set.permissions.fileTransfer;
  $('s-audio').checked = !!set.audio.enabled;
  $('s-encoder').value = set.video.encoder;
  $('s-fps').value = String(set.video.maxFps);
  $('s-bitrate').value = String(set.video.maxBitrateKbps);
}

const save = patch => api('/settings', { method: 'POST', body: JSON.stringify(patch) }).catch(e => alert(e.message));
$('s-lock').onchange = e => save({ lockOnDisconnect: e.target.checked });
$('s-clip').onchange = e => save({ clipboard: e.target.checked });
$('s-files').onchange = e => save({ fileTransfer: e.target.checked });
$('s-audio').onchange = e => save({ audio: e.target.checked });
$('s-encoder').onchange = e => save({ encoder: e.target.value });
$('s-fps').onchange = e => save({ maxFps: +e.target.value });
$('s-bitrate').onchange = e => save({ maxBitrateKbps: +e.target.value });

$('btn-code').onclick = async () => {
  const r = await api('/paircode', { method: 'POST' });
  $('code-out').hidden = false;
  $('code').textContent = `${r.code.slice(0, 5)}-${r.code.slice(5)}`;
  $('code-url').textContent = r.urls[0] || '';
};

$('pw-form').onsubmit = async e => {
  e.preventDefault();
  const a = $('pw1').value, b = $('pw2').value;
  const msg = $('pw-msg');
  if (a !== b) { msg.textContent = 'Passwords don\'t match.'; return; }
  try {
    await api('/password', { method: 'POST', body: JSON.stringify({ password: a }) });
    msg.textContent = 'Password saved.';
    $('pw1').value = $('pw2').value = '';
    load();
  } catch (ex) { msg.textContent = ex.message; }
};

load();
setInterval(load, 5000);
