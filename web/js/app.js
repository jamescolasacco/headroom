// Headroom web client — entry point: saved computers (home), pairing, and launching sessions.
import { loadHosts, upsertHost, removeHost } from './store.js';
import { normalizeUrl, getInfo, pair, checkHost } from './api.js';
import { Session } from './session.js';
import { h, svg, dialog, confirmDialog, toast } from './ui/dom.js';
import { I } from './ui/icons.js';
import { deviceLabel, secure, hasWebCodecs, isStandalone, isIOS, nativeViewer, postNative, onNative } from './platform.js';

const $ = id => document.getElementById(id);
let session = null;
let sameOriginInfo = null;

async function main() {
  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(e => console.warn('[sw]', e));
  }
  // Never create history entries: iOS standalone edge-swipe "back" would leave the app.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname);

  $('btn-add-host').addEventListener('click', () => addHostFlow());
  $('btn-app-settings').addEventListener('click', () => appSettings());

  try { sameOriginInfo = await getInfo(location.origin, { timeout: 3000 }); } catch { sameOriginInfo = null; }

  const code = hash.get('pair');
  if (code && sameOriginInfo) {
    await addHostFlow({ url: location.origin, info: sameOriginInfo, code });
  }
  renderHome();
  const hosts = loadHosts();
  // Headroom Viewer: #add=<url> resumes adding a computer after its certificate was trusted;
  // #connect=<hostId> opens a session (used by "Open in new window").
  const add = hash.get('add');
  if (add) {
    try { await addHostFlow({ url: add, info: await getInfo(add) }); } catch (e) { toast(e.message, 6000); }
    return;
  }
  const connectId = hash.get('connect');
  const toConnect = connectId && hosts.find(x => x.id === connectId);
  if (toConnect) { connect(toConnect); return; }
  if (!hosts.length && sameOriginInfo && !code) addHostFlow({ url: location.origin, info: sameOriginInfo });
}

/** Headroom Viewer: ask the native shell to verify + pin a computer's certificate. */
function requestTrust(url) {
  return new Promise(resolve => {
    const off = onNative(m => {
      if (m?.cmd !== 'trustResult' || m.url !== url) return;
      off();
      resolve(m);
    });
    postNative({ cmd: 'trustHost', url });
  });
}

// ---------------------------------------------------------------------------------------------- home

function renderHome() {
  $('viewer').hidden = true;
  $('home').hidden = false;
  const hosts = loadHosts().sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0));
  const list = $('host-list');
  list.replaceChildren(...hosts.map(hostCard));
  $('home-empty').hidden = hosts.length > 0;
  const hint = [];
  if (!secure) hint.push('Not a secure connection: video needs HTTPS.');
  else if (!hasWebCodecs) hint.push('This browser lacks WebCodecs (needs Safari 16.4+, Chrome/Edge 94+, Firefox 130+).');
  if (isIOS && !isStandalone) hint.push('Tip: Share → Add to Home Screen for a full-screen app.');
  if (nativeViewer) hint.push('Tip: Win, Alt+Tab and PrtScn go to the remote computer while its window is focused. Ctrl+Alt+End sends Ctrl+Alt+Del.');
  $('home-hint').textContent = hint.join(' ');
  for (const host of hosts) refreshStatus(host);
}

function hostCard(host) {
  const dot = h('span', { class: 'dot', 'data-status': host.id });
  const card = h('div', { class: 'host', role: 'button', tabindex: '0', 'aria-label': `Connect to ${host.name}` },
    h('div', { class: 'os' }, svg(host.os === 'macos' ? I.apple : I.windows, 24)),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'name' }, host.name),
      h('div', { class: 'addr' }, dot, host.url.replace(/^https?:\/\//, ''))),
    h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'More', title: 'More',
      onclick: e => { e.stopPropagation(); hostMenu(host); },
    }, svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>')));
  const go = () => connect(host);
  card.addEventListener('click', go);
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  return card;
}

async function refreshStatus(host) {
  const st = await checkHost(host);
  const dot = document.querySelector(`.dot[data-status="${CSS.escape(host.id)}"]`);
  if (!dot) return;
  dot.classList.remove('online', 'offline', 'unauth');
  dot.classList.add(st === 'online' ? 'online' : st === 'unauthorized' ? 'unauth' : 'offline');
  dot.title = st === 'online' ? 'Online' : st === 'unauthorized' ? 'Needs pairing again' : 'Offline or unreachable';
}

async function hostMenu(host) {
  await dialog((dlg, done) => {
    const name = h('input', { type: 'text', value: host.name, 'aria-label': 'Name' });
    dlg.append(h('div', { class: 'body' },
      h('h2', {}, host.name),
      h('p', { class: 'muted small' }, host.url),
      h('label', { class: 'field' }, 'Name'), name,
      h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'danger', onclick: async () => {
            done();
            if (await confirmDialog('Remove computer?', `${host.name} will be removed from this device. You can add it again later.`, 'Remove', true)) {
              removeHost(host.id); renderHome();
            }
          },
        }, 'Remove'),
        h('button', { type: 'button', onclick: () => { done(); addHostFlow({ url: host.url, repair: host }); } }, 'Pair again'),
        nativeViewer ? h('button', { type: 'button', onclick: () => { done(); postNative({ cmd: 'newWindow', url: `${location.origin}/index.html#connect=${encodeURIComponent(host.id)}` }); } }, 'Open in new window') : null,
        h('button', { type: 'button', class: 'primary', onclick: () => { upsertHost({ ...host, name: name.value.trim() || host.name }); done(); renderHome(); } }, 'Save'))));
  });
}

function connect(host) {
  if (session) return;
  session = new Session(host, {
    onExit: () => { session = null; renderHome(); },
    onUnauthorized: h2 => addHostFlow({ url: h2.url, repair: h2 }),
  });
  globalThis.__headroomSession = session; // handy for debugging from the console
  session.unlockFromGesture(); // audio must be unlocked inside this tap (iOS)
  session.start().catch(e => {
    console.error(e);
    toast(`Couldn't start: ${e.message}`, 5000);
    session?.stop();
  });
}

// ---------------------------------------------------------------------------------------------- pairing

async function addHostFlow({ url, info, code, repair } = {}) {
  let step = info ? 2 : 1;
  let hostInfo = info || null;
  let target = url || (sameOriginInfo && !loadHosts().some(h2 => h2.url === location.origin) ? location.origin : '');
  return dialog((dlg, done) => {
    const render = () => {
      dlg.replaceChildren();
      const err = h('div', { class: 'error', role: 'alert' });
      if (step === 1) {
        const addr = h('input', { type: 'url', value: target, placeholder: '192.168.1.20 or desktop.tailnet.ts.net', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: 'url' });
        const form = h('form', {},
          h('h2', {}, 'Add a computer'),
          h('p', { class: 'muted small' }, 'Enter the address shown by Headroom on the computer.'),
          h('label', { class: 'field' }, 'Address'), addr, err,
          h('div', { class: 'actions' },
            h('button', { type: 'button', onclick: () => done() }, 'Cancel'),
            h('button', { type: 'submit', class: 'primary' }, 'Continue')));
        form.addEventListener('submit', async e => {
          e.preventDefault();
          err.textContent = '';
          try {
            target = normalizeUrl(addr.value);
            hostInfo = await getInfo(target);
            step = 2;
            render();
          } catch (ex) {
            if (ex.unreachable && nativeViewer) {
              // Probably an untrusted certificate: the viewer verifies the computer's key fingerprint
              // with the user and pins it (it then reloads straight back into this flow).
              err.textContent = 'Checking this computer\'s certificate…';
              const r = await requestTrust(target);
              if (r.ok && r.reason === 'already-trusted') err.textContent = 'This computer is reachable but didn\'t answer as a Headroom host. Check the address and port.';
              else if (!r.ok) err.textContent = r.reason === 'declined' ? 'Not trusted — nothing was saved.' : r.reason;
              return;
            }
            err.replaceChildren(ex.message, ex.unreachable ? certHelp(target || addr.value) : '');
          }
        });
        dlg.append(form);
        setTimeout(() => addr.focus(), 50);
        return;
      }
      // step 2: credentials
      const hi = hostInfo.host;
      let method = code ? 'code' : 'password';
      const secret = h('input', { type: method === 'password' ? 'password' : 'text', autocomplete: method === 'password' ? 'current-password' : 'one-time-code', value: code || '', autocapitalize: 'characters', spellcheck: 'false' });
      const totp = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxlength: '6' });
      const totpWrap = h('div', { hidden: !hostInfo.totp }, h('label', { class: 'field' }, 'Authenticator code'), totp);
      const devName = h('input', { type: 'text', value: deviceLabel() });
      const secretLabel = h('label', { class: 'field' }, method === 'password' ? 'Password' : 'Pairing code');
      const seg = h('div', { class: 'seg', role: 'group' },
        ...[['password', 'Password'], ['code', 'Pairing code']].map(([v, l]) => {
          const b = h('button', { type: 'button', 'aria-pressed': String(method === v) }, l);
          b.onclick = () => {
            method = v;
            for (const x of seg.children) x.setAttribute('aria-pressed', String(x === b));
            secretLabel.textContent = v === 'password' ? 'Password' : 'Pairing code';
            secret.type = v === 'password' ? 'password' : 'text';
            secret.value = ''; secret.focus();
          };
          return b;
        }));
      const form = h('form', {},
        h('h2', {}, repair ? `Pair again with ${hi.name}` : `Pair with ${hi.name}`),
        h('p', { class: 'muted small' }, hostInfo.paired
          ? 'Use the password set on the computer, or a one-time code from "headroom pair".'
          : 'This computer has no password yet: use the pairing code shown in its Headroom window.'),
        seg, secretLabel, secret, totpWrap,
        h('label', { class: 'field' }, 'This device\'s name'), devName, err,
        h('div', { class: 'actions' },
          h('button', { type: 'button', onclick: () => done() }, 'Cancel'),
          h('button', { type: 'submit', class: 'primary' }, 'Pair')));
      if (!hostInfo.paired) { method = 'code'; seg.children[1].click(); }
      form.addEventListener('submit', async e => {
        e.preventDefault();
        err.textContent = '';
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const val = secret.value.trim();
          const r = await pair(target, {
            password: method === 'password' ? secret.value : undefined,
            code: method === 'code' ? val.replace(/[\s-]/g, '') : undefined,
            totp: totp.value.trim() || undefined,
            deviceName: devName.value.trim() || deviceLabel(),
          });
          upsertHost({
            id: r.host.id, name: repair?.name || r.host.name, url: target, os: r.host.os, token: r.token,
            deviceId: r.device.id, deviceName: r.device.name, addedAt: Date.now(),
          });
          toast(`Paired with ${r.host.name}`);
          done(true);
          renderHome();
        } catch (ex) {
          btn.disabled = false;
          const b = ex.body || {};
          if (b.error === 'totp-required') { totpWrap.hidden = false; totp.focus(); err.textContent = 'Enter the 6-digit code from your authenticator app.'; }
          else if (b.error === 'rate-limited') err.textContent = `Too many attempts. Try again in ${b.retryAfter || 60} s.`;
          else if (b.error === 'bad-credentials') err.textContent = method === 'password' ? 'Wrong password.' : 'That code is wrong or expired.';
          else err.textContent = ex.message;
        }
      });
      dlg.append(form);
      setTimeout(() => (code ? devName : secret).focus(), 50);
    };
    render();
  });
}

function certHelp(target) {
  let host = target;
  try { host = new URL(/^https?:/.test(target) ? target : `https://${target}`).hostname; } catch { }
  const helper = `http://${host}:7080/`;
  return h('div', { class: 'small muted', style: { marginTop: '8px' } },
    'First time from this device? It may not trust the computer\'s certificate yet. Open ',
    h('a', { href: helper, target: '_blank', rel: 'noopener' }, helper),
    ' to install it (one time), then try again.');
}

// ---------------------------------------------------------------------------------------------- app settings

function appSettings() {
  dialog((dlg, done) => {
    dlg.append(h('div', { class: 'body' },
      h('h2', {}, 'Headroom'),
      h('p', { class: 'muted small' }, 'Remote desktop for your own computers. Video is decoded in hardware with WebCodecs; input, clipboard, audio and files stream over an encrypted WebSocket.'),
      h('p', { class: 'small' }, `This device: ${deviceLabel()} · ${secure ? 'secure context' : 'insecure context'} · WebCodecs ${hasWebCodecs ? 'yes' : 'no'}`),
      h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'danger', onclick: async () => {
            done();
            if (await confirmDialog('Forget all computers?', 'Removes every saved computer and pairing from this device.', 'Forget all', true)) {
              try { localStorage.clear(); } catch { }
              renderHome();
            }
          },
        }, 'Forget all'),
        h('button', { type: 'button', class: 'primary', onclick: () => done() }, 'Done'))));
  });
}

main();
