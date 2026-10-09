// Headroom web client — entry point: saved computers (home), pairing, and launching sessions.
import { loadHosts, upsertHost, removeHost } from './store.js';
import { normalizeUrl, getInfo, pair, checkHost } from './api.js';
import { Session } from './session.js';
import { h, svg, dialog, confirmDialog, toast } from './ui/dom.js';
import { I } from './ui/icons.js';
import { qrSvg } from './qr.js';
import { deviceLabel, platformId, secure, hasWebCodecs, isStandalone, isIOS, isMac, nativeViewer, postNative, onNative } from './platform.js';
import * as Account from './account.js';

const $ = id => document.getElementById(id);
let session = null;
let sameOriginInfo = null;     // this page's own server: a computer ({host}) or an account server ({service})
const servedByComputer = () => !!sameOriginInfo?.host;
const servedByAccount = () => sameOriginInfo?.service === 'headroom-account-server';

async function main() {
  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(e => console.warn('[sw]', e));
  }
  // Never create history entries: iOS standalone edge-swipe "back" would leave the app.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname);

  $('btn-add-host').addEventListener('click', () => addHostFlow());
  $('btn-sign-in').addEventListener('click', () => signInFlow());
  $('btn-app-settings').addEventListener('click', () => appSettings());

  try { sameOriginInfo = await getInfo(location.origin, { timeout: 3000 }); } catch { sameOriginInfo = null; }

  const code = hash.get('pair');
  if (code && servedByComputer()) {
    await addHostFlow({ url: location.origin, info: sameOriginInfo, code });
  }
  renderHome();
  const refreshed = refreshAccount();
  // Keep the account's computers (online state, addresses) fresh while the home screen is showing.
  const idleRefresh = () => { if (!session && document.visibilityState === 'visible') refreshAccount(); };
  setInterval(idleRefresh, 30000);
  document.addEventListener('visibilitychange', idleRefresh);
  if (hash.get('connect')) await refreshed;
  const hosts = allHosts();
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
  if (!hosts.length && !code && !Account.loadAccount()) {
    if (servedByAccount()) signInFlow();
    else if (servedByComputer()) addHostFlow({ url: location.origin, info: sameOriginInfo });
  }
}

/** Account computers first, then paired ones (a computer that's both shows once, as the account's). */
function allHosts() {
  const acct = Account.accountHosts();
  const ids = new Set(acct.map(x => x.id));
  return [...acct, ...loadHosts().filter(x => !ids.has(x.id))];
}

const accountSnapshot = () => JSON.stringify([Account.loadAccount()?.error, Account.accountHosts().map(x => [x.id, x.name, x.online, x.urls])]);

async function refreshAccount() {
  if (!Account.loadAccount()) return;
  const before = accountSnapshot();
  const a = await Account.refreshComputers();
  if (!a) {
    toast('Signed out of your Headroom account: this device was removed from it.', 6000);
    if (!session) renderHome();
    return;
  }
  if (!session && accountSnapshot() !== before) renderHome();
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
  const acct = Account.loadAccount();
  const hosts = allHosts().sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0));
  const list = $('host-list');
  list.replaceChildren(...hosts.map(hostCard));
  $('home-empty').hidden = hosts.length > 0;
  $('btn-sign-in').hidden = !!acct;
  $('btn-add-host').classList.toggle('primary', !!acct);
  const chip = $('account-chip');
  chip.hidden = !acct;
  if (acct) {
    chip.replaceChildren(svg(I.user, 16), h('span', {}, acct.username),
      ...(acct.error ? [h('span', { class: 'warn-text' }, '· offline')] : []));
    chip.title = `Headroom account at ${acct.server}`;
    chip.onclick = () => accountDialog();
  }
  $('home-empty-text').textContent = acct
    ? `Signed in as ${acct.username}, but no computers have joined the account yet: in Headroom Server on each computer, open Settings → Account and sign in there.`
    : '';
  const hint = [];
  if (!secure) hint.push('Not a secure connection: video needs HTTPS.');
  else if (!hasWebCodecs) hint.push('This browser lacks WebCodecs (needs Safari 16.4+, Chrome/Edge 94+, Firefox 130+).');
  if (isIOS && !isStandalone) hint.push('Tip: Share → Add to Home Screen for a full-screen app (it has its own storage, so sign in or pair inside it).');
  if (nativeViewer) hint.push(isMac
    ? 'Tip: ⌘Tab, ⌘Space and other system shortcuts go to the remote computer while its window is focused.'
    : 'Tip: Win, Alt+Tab and PrtScn go to the remote computer while its window is focused. Ctrl+Alt+End sends Ctrl+Alt+Del.');
  $('home-hint').textContent = hint.join(' ');
  for (const host of hosts) refreshStatus(host);
}

function hostCard(host) {
  const dot = h('span', { class: 'dot', 'data-status': host.id });
  const card = h('div', { class: 'host', role: 'button', tabindex: '0', 'aria-label': `Connect to ${host.name}` },
    h('div', { class: 'os' }, svg(host.os === 'macos' ? I.apple : I.windows, 24)),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'name' }, host.name, host.viewOnly ? h('span', { class: 'tag' }, 'view only') : null),
      h('div', { class: 'addr' }, dot, (host.url || 'no address yet').replace(/^https?:\/\//, '').replace(/\/$/, ''))),
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
  // Account computers: the account knows whether each checked in recently (no probing every address).
  const st = host.account ? (host.online ? 'online' : 'offline') : await checkHost(host);
  const dot = document.querySelector(`.dot[data-status="${CSS.escape(host.id)}"]`);
  if (!dot) return;
  dot.classList.remove('online', 'offline', 'unauth');
  dot.classList.add(st === 'online' ? 'online' : st === 'unauthorized' ? 'unauth' : 'offline');
  dot.title = st === 'online' ? 'Online' : st === 'unauthorized' ? 'Needs pairing again' : 'Offline or unreachable';
}

async function hostMenu(host) {
  if (host.account) return accountHostMenu(host);
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

function accountHostMenu(host) {
  const seen = host.online ? 'online now' : `last seen ${host.lastSeen ? new Date(host.lastSeen).toLocaleString() : 'never'}`;
  return dialog((dlg, done) => {
    dlg.append(h('div', { class: 'body' },
      h('h2', {}, host.name),
      h('p', { class: 'muted small' }, `In your Headroom account · ${seen}${host.viewOnly ? ' · view only from this device' : ''}`),
      h('p', { class: 'small muted' }, 'Addresses it reported (the first that answers is used):'),
      h('div', { class: 'small mono', style: { wordBreak: 'break-all' } }, ...host.urls.map(u => h('div', {}, u))),
      h('div', { class: 'actions' },
        nativeViewer ? h('button', { type: 'button', onclick: () => { done(); postNative({ cmd: 'newWindow', url: `${location.origin}/index.html#connect=${encodeURIComponent(host.id)}` }); } }, 'Open in new window') : null,
        h('button', { type: 'button', onclick: () => { done(); accountDialog(); } }, 'Manage account'),
        h('button', { type: 'button', class: 'primary', onclick: () => done() }, 'Done'))));
  });
}

function connect(host) {
  if (session) return;
  const s = session = new Session(host, {
    onExit: () => { session = null; renderHome(); },
    onUnauthorized: h2 => {
      if (h2.account) refreshAccount();
      else addHostFlow({ url: h2.url, repair: h2 });
    },
  });
  globalThis.__headroomSession = s; // handy for debugging from the console
  s.unlockFromGesture(); // audio must be unlocked inside this tap (iOS): before any await
  (async () => {
    if (host.account) {
      // An account computer may have several addresses (Tailscale, .local name, LAN): use one that answers.
      const url = await Account.reachableUrl(host);
      if (session !== s) return;
      if (!url) {
        s.stop();
        const where = host.urls.map(u => u.replace(/^https:\/\//, '').replace(/\/$/, '')).join(', ');
        toast(host.online
          ? `Can't reach ${host.name} from this network (${where || 'no address'}).${nativeViewer ? '' : ' First time on this device? Install its certificate from http://<its address>:7080/ — or use Tailscale.'}`
          : `${host.name} is offline (it hasn't checked in with your account recently).`, 9000);
        return;
      }
      host.url = url;
      Account.noteConnected(host.computerId, url);
    }
    await s.start();
  })().catch(e => {
    console.error(e);
    toast(`Couldn't start: ${e.message}`, 5000);
    s.stop();
  });
}

// ---------------------------------------------------------------------------------------------- pairing

async function addHostFlow({ url, info, code, repair } = {}) {
  let step = info ? 2 : 1;
  let hostInfo = info || null;
  let target = url || (servedByComputer() && !loadHosts().some(h2 => h2.url === location.origin) ? location.origin : '');
  return dialog((dlg, done) => {
    const render = () => {
      dlg.replaceChildren();
      const err = h('div', { class: 'error', role: 'alert' });
      if (step === 1) {
        const addr = h('input', { type: 'text', value: target, placeholder: '192.168.1.20 or desktop.tailnet.ts.net', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', inputmode: 'url' });
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
            secret.autocomplete = v === 'password' ? 'current-password' : 'one-time-code'; // iOS: no password autofill in the code field
            secret.value = ''; secret.focus();
          };
          return b;
        }));
      // iOS Safari: a Home Screen app has its own storage, separate from Safari's (WebKit, by design), so a
      // pairing made here wouldn't carry over to it. Offer to install first and keep the code at hand.
      const installHint = c => isIOS && !isStandalone && !repair && target === location.origin
        ? h('div', { class: 'callout small' },
          h('b', {}, 'Want the full-screen app?'),
          ' Add it first (Share → Add to Home Screen), open Headroom from your Home Screen and pair there: it keeps its own list of computers.',
          c ? h('div', { style: { marginTop: '6px' } }, 'Your code: ', h('b', { class: 'mono' }, `${c.slice(0, 5)}-${c.slice(5)}`), ' (single use, valid 10 minutes)') : null)
        : null;
      const form = h('form', {},
        h('h2', {}, repair ? `Pair again with ${hi.name}` : `Pair with ${hi.name}`),
        h('p', { class: 'muted small' }, hostInfo.paired
          ? 'Use the password set on the computer, or a one-time code from Headroom Server → Pair a device.'
          : 'This computer has no password yet: use a one-time code from Headroom Server → Pair a device.'),
        installHint(code),
        seg, secretLabel, secret, totpWrap,
        h('label', { class: 'field' }, 'This device\'s name'), devName, err,
        h('div', { class: 'actions' },
          h('button', { type: 'button', onclick: () => done() }, 'Cancel'),
          h('button', { type: 'submit', class: 'primary' }, 'Pair')));
      // No password on the host: only codes work. (Already in code mode with a code from the QR link? Keep it:
      // switching clears the field.)
      if (!hostInfo.paired && method !== 'code') seg.children[1].click();
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
  const acct = Account.loadAccount();
  dialog((dlg, done) => {
    dlg.append(h('div', { class: 'body' },
      h('h2', {}, 'Headroom'),
      h('p', { class: 'muted small' }, 'Remote desktop for your own computers. Video is decoded in hardware with WebCodecs; input, clipboard, audio and files stream over an encrypted WebSocket.'),
      h('p', { class: 'small' }, `This device: ${deviceLabel()} · ${secure ? 'secure context' : 'insecure context'} · WebCodecs ${hasWebCodecs ? 'yes' : 'no'}`),
      h('p', { class: 'small' }, acct ? `Signed in as ${acct.username} (${acct.server}).` : 'Not signed in to a Headroom account.'),
      h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'danger', onclick: async () => {
            done();
            if (await confirmDialog('Forget all computers?', 'Removes every saved computer and pairing from this device, and signs out of your account.', 'Forget all', true)) {
              await Account.signOut();
              try { localStorage.clear(); } catch { }
              renderHome();
            }
          },
        }, 'Forget all'),
        h('button', { type: 'button', onclick: () => { done(); acct ? accountDialog() : signInFlow(); } }, acct ? 'Account' : 'Sign in'),
        h('button', { type: 'button', class: 'primary', onclick: () => done() }, 'Done'))));
  });
}

// ---------------------------------------------------------------------------------------------- account

const lastServerKey = 'headroom.lastAccountServer';

/** Sign in to (or create) a Headroom account; then every computer in it shows up here. */
async function signInFlow() {
  let server = servedByAccount() ? location.origin : (() => { try { return localStorage.getItem(lastServerKey) || ''; } catch { return ''; } })();
  let info = null, register = false;
  return dialog((dlg, done) => {
    const err = h('div', { class: 'error', role: 'alert' });
    const srv = h('input', { type: 'text', value: server, placeholder: 'accounts.example.com', autocomplete: 'url', autocapitalize: 'off', spellcheck: 'false', inputmode: 'url' });
    const srvWrap = h('div', { hidden: servedByAccount() }, h('label', { class: 'field' }, 'Account server'), srv);
    const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const totp = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxlength: '6' });
    const totpWrap = h('div', { hidden: true }, h('label', { class: 'field' }, 'Authenticator code'), totp);
    const devName = h('input', { type: 'text', value: deviceLabel() });
    const title = h('h2', {}, 'Sign in to Headroom');
    const lead = h('p', { class: 'muted small' }, 'Sign in once and every computer in your account is here — no pairing each one.');
    const switchLink = h('button', { type: 'button', class: 'link', hidden: true }, 'Create an account');
    const submit = h('button', { type: 'submit', class: 'primary' }, 'Sign in');
    const setMode = r => {
      register = r;
      title.textContent = r ? 'Create your Headroom account' : 'Sign in to Headroom';
      switchLink.textContent = r ? 'I have an account' : 'Create an account';
      submit.textContent = r ? 'Create account' : 'Sign in';
      pass.autocomplete = r ? 'new-password' : 'current-password';
      pass.placeholder = r ? 'At least 8 characters' : '';
    };
    switchLink.onclick = () => setMode(!register);
    const checkServer = async () => {
      err.textContent = '';
      info = null;
      try { server = Account.normalizeServer(srv.value); } catch (e) { err.textContent = e.message; return false; }
      // An https:// page (any Headroom Server, Headroom Viewer) may not call plain-HTTP servers, except on loopback.
      const u = new URL(server);
      if (u.protocol === 'http:' && location.protocol !== 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) {
        err.textContent = 'The account server needs HTTPS (https://…): the app can\'t reach plain-HTTP servers from here.';
        return false;
      }
      info = await Account.serverInfo(server);
      if (!info) { err.textContent = 'No Headroom account server answered at that address.'; return false; }
      if (info.name && info.name !== 'Headroom') lead.textContent = `${info.name}: sign in once and every computer in your account is here — no pairing each one.`;
      switchLink.hidden = !info.signup;
      if (info.firstAccount) setMode(true); // a brand-new server: the first account is the owner's
      return true;
    };
    srv.addEventListener('change', checkServer);
    const form = h('form', {}, title, lead, srvWrap,
      h('label', { class: 'field' }, 'Username'), user,
      h('label', { class: 'field' }, 'Password'), pass, totpWrap,
      h('label', { class: 'field' }, 'This device\'s name'), devName, err,
      h('div', { class: 'actions' }, switchLink, h('span', { style: { flex: '1' } }),
        h('button', { type: 'button', onclick: () => done() }, 'Cancel'), submit));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      submit.disabled = true;
      try {
        if (!info && !await checkServer()) return;
        err.textContent = '';
        await Account.signIn(server, {
          username: user.value.trim(), password: pass.value, totp: totp.value.trim() || undefined,
          deviceName: devName.value.trim() || deviceLabel(), platform: platformId(), register,
        });
        try { localStorage.setItem(lastServerKey, server); } catch { }
        done(true);
        await refreshAccount();
        renderHome();
        const n = Account.accountHosts().length;
        toast(n ? `Signed in · ${n} computer${n === 1 ? '' : 's'} in your account` : 'Signed in. Now join your computers to the account in Headroom Server → Settings → Account.', 6000);
      } catch (ex) {
        const b = ex.body || {};
        if (b.error === 'totp-required') { totpWrap.hidden = false; totp.focus(); err.textContent = 'Enter the 6-digit code from your authenticator app.'; }
        else if (b.error === 'bad-totp') err.textContent = 'That code didn\'t work. Wait for the next one and try again.';
        else if (b.error === 'bad-credentials') err.textContent = 'Wrong username or password.';
        else if (b.error === 'rate-limited') err.textContent = `Too many attempts. Try again in ${b.retryAfter || 60} s.`;
        else err.textContent = ex.message;
      } finally { submit.disabled = false; }
    });
    dlg.append(form);
    if (server) checkServer();
    setTimeout(() => (server ? user : srv).focus(), 50);
  });
}

/** The account: its devices and computers (remove, view-only), two-factor sign-in, password, sign out. */
async function accountDialog() {
  const a = Account.loadAccount();
  if (!a) return signInFlow();
  return dialog((dlg, done) => {
    const list = h('div', { class: 'list-mini' }, h('p', { class: 'muted small' }, 'Loading…'));
    const msg = h('div', { class: 'error', role: 'alert' });
    const totpBox = h('div');
    const fail = e => { msg.textContent = e.body?.error === 'bad-credentials' ? 'Wrong password.' : e.body?.error === 'bad-totp' ? 'That code didn\'t work.' : e.message; };
    const ago = d => {
      if (!d) return 'never';
      const sec = (Date.now() - new Date(d)) / 1000;
      return sec < 90 ? 'just now' : sec < 3600 ? `${Math.round(sec / 60)} min ago` : sec < 86400 ? `${Math.round(sec / 3600)} h ago` : new Date(d).toLocaleDateString();
    };
    const load = async () => {
      try {
        const [devices, info] = await Promise.all([Account.listDevices(a), Account.me(a)]);
        devices.sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === 'computer' ? -1 : 1));
        list.replaceChildren(...devices.map(d => h('div', { class: 'li-mini' },
          h('div', { class: 'grow' },
            h('div', {}, svg(d.kind === 'computer' ? I.monitor : I.user, 16), ' ', d.name,
              d.current ? h('span', { class: 'tag' }, 'this device') : null,
              d.viewOnly ? h('span', { class: 'tag' }, 'view only') : null),
            h('div', { class: 'muted small' }, `${d.kind === 'computer' ? 'Computer' : 'Device'} · ${d.online ? 'online' : `last seen ${ago(d.lastSeen)}`}`)),
          d.kind === 'viewer' && !d.current ? h('button', {
            type: 'button', class: 'small-btn', title: d.viewOnly ? 'Let this device control computers' : 'This device can watch but not control',
            onclick: async () => { try { await Account.setViewOnly(a, d.id, !d.viewOnly); load(); } catch (e) { fail(e); } },
          }, d.viewOnly ? 'Allow control' : 'View only') : null,
          d.current ? null : h('button', {
            type: 'button', class: 'small-btn danger', onclick: async () => {
              const q = d.kind === 'computer'
                ? `Remove ${d.name} from the account? Your devices stop seeing it (pairings made directly with it keep working).`
                : `Remove ${d.name}? It's signed out and loses access to every computer in the account within seconds.`;
              if (!await confirmDialog('Remove from account?', q, 'Remove', true)) return;
              try { await Account.removeDevice(a, d.id); load(); refreshAccount(); } catch (e) { fail(e); }
            },
          }, 'Remove'))));
        drawTotp(info.account.totpEnabled);
      } catch (e) { fail(e); }
    };
    const drawTotp = enabled => {
      if (enabled) {
        const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
        totpBox.replaceChildren(h('p', { class: 'small' }, h('b', {}, 'Two-factor sign-in is on.'), ' Signing in needs a code from your authenticator app.'),
          h('div', { class: 'row-inline' }, pw, h('button', {
            type: 'button', class: 'small-btn', onclick: async () => { try { await Account.totpDisable(a, pw.value); msg.textContent = ''; drawTotp(false); } catch (e) { fail(e); } },
          }, 'Turn off')));
        return;
      }
      totpBox.replaceChildren(h('p', { class: 'small muted' }, 'Two-factor sign-in asks for a code from an authenticator app whenever a device signs in.'),
        h('button', {
          type: 'button', class: 'small-btn', onclick: async () => {
            try {
              const setup = await Account.totpSetup(a);
              const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', placeholder: '123456', autocomplete: 'one-time-code', 'aria-label': 'Code' });
              const qr = h('div', { class: 'qr-mini' });
              qr.innerHTML = qrSvg(setup.uri, { border: 2 });
              totpBox.replaceChildren(qr,
                h('p', { class: 'small' }, 'Scan this with your authenticator app (or enter ', h('span', { class: 'mono' }, setup.secret), '), then type the code it shows.'),
                h('div', { class: 'row-inline' }, code, h('button', {
                  type: 'button', class: 'small-btn primary', onclick: async () => { try { await Account.totpEnable(a, code.value.trim()); msg.textContent = ''; drawTotp(true); } catch (e) { fail(e); } },
                }, 'Turn on')));
              code.focus();
            } catch (e) { fail(e); }
          },
        }, 'Set up two-factor'));
    };
    const cur = h('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password', 'aria-label': 'Current password' });
    const nw = h('input', { type: 'password', placeholder: 'New password', autocomplete: 'new-password', 'aria-label': 'New password' });
    dlg.append(h('div', { class: 'body' },
      h('h2', {}, a.username),
      h('p', { class: 'muted small' }, `Headroom account at ${a.server}`),
      h('h3', { class: 'sub-h' }, 'Computers and devices'), list,
      h('h3', { class: 'sub-h' }, 'Security'), totpBox,
      h('div', { class: 'row-inline' }, cur, nw, h('button', {
        type: 'button', class: 'small-btn', onclick: async () => {
          try { await Account.changePassword(a, cur.value, nw.value); cur.value = nw.value = ''; msg.textContent = ''; toast('Password changed'); } catch (e) { fail(e); }
        },
      }, 'Change password')),
      msg,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'danger', onclick: async () => { done(); await Account.signOut(); renderHome(); toast('Signed out'); } }, 'Sign out'),
        h('button', { type: 'button', class: 'primary', onclick: () => done() }, 'Done'))));
    load();
  });
}

main();
