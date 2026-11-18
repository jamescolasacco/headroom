// Headroom web client — entry point: saved computers (home), pairing, and launching sessions.
import { loadHosts, upsertHost, removeHost } from './store.js';
import { normalizeUrl, getInfo, pair, checkHost } from './api.js';
import { Session } from './session.js';
import { h, svg, dialog, confirmDialog, toast } from './ui/dom.js';
import { I } from './ui/icons.js';
import { qrSvg } from './qr.js';
import { deviceLabel, platformId, secure, hasWebCodecs, isStandalone, isIOS, isMac, nativeViewer, postNative, onNative } from './platform.js';
import * as Account from './account.js';
import { DEFAULT_ACCOUNT_SERVER } from './config.js';

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
  $('btn-support').addEventListener('click', () => supportFlow());
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
  // Links from an administrator: https://<account server>/#invite=… or #reset=…
  if (hash.get('invite')) { await inviteFlow(hash.get('invite')); return; }
  if (hash.get('reset')) { await resetFlow(hash.get('reset')); return; }
  // A remote-support link: https://<relay>/#id=<Headroom ID>[&code=<support code>]
  if (hash.get('id')) { supportFlow({ id: hash.get('id'), code: hash.get('code') || '' }); return; }
  // Served by a computer, with nothing saved and no account server to sign in to: offer to pair with it. (With an
  // account server, the home screen is the login; pairing stays one link away.)
  if (!hosts.length && !code && !Account.loadAccount() && servedByComputer() && !defaultServer()) addHostFlow({ url: location.origin, info: sameOriginInfo });
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
  // Signed out: the home screen is the login (kept across re-renders so typing isn't lost).
  const slot = $('signin-slot');
  const inlineLogin = !acct && !!defaultServer();
  if (inlineLogin && !slot.firstChild) slot.append(signInForm({ inline: true }));
  if (!inlineLogin) slot.replaceChildren();
  slot.hidden = !inlineLogin;
  $('home-empty').hidden = hosts.length > 0 || inlineLogin;
  $('btn-sign-in').hidden = !!acct || inlineLogin;
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
    : servedByAccount() ? 'Helping someone? Use “Connect with an ID” with the Headroom ID and code they give you.' : '';
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
      h('div', { class: 'addr' }, dot, host.url && host.url === host.relayUrl
        ? `via relay · ID ${Account.prettyId(host.relayId)}`
        : (host.url || 'no address yet').replace(/^https?:\/\//, '').replace(/\/$/, ''))),
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
      host.relayId ? h('p', { class: 'small' }, `Headroom ID ${Account.prettyId(host.relayId)} · ${host.relayOnline ? 'reachable from anywhere through the relay' : 'not on the relay right now'}`) : null,
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
        toast(!host.online
          ? `${host.name} is offline (it hasn't checked in with your account recently).`
          : host.relayUrl
            ? `${host.name} answers neither directly nor through the relay right now. Try again in a moment.`
            : `Can't reach ${host.name} from this network (${where || 'no address'}).${nativeViewer ? '' : ' First time on this device? Install its certificate from http://<its address>:7080/ — or use Tailscale.'}`, 9000);
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

// ---------------------------------------------------------------------------------------------- remote support

const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k) || ''; localStorage.setItem(k, v); } catch { } return ''; };

/** AnyDesk-style: reach someone's computer with its Headroom ID and the one-time code they read out to you. */
function supportFlow({ id = '', code = '' } = {}) {
  const acct = Account.loadAccount();
  const knownRelay = servedByAccount() ? location.origin : acct?.server || defaultServer() || pref('headroom.lastRelay');
  return dialog((dlg, done) => {
    const err = h('div', { class: 'error', role: 'alert' });
    const idIn = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '123 456 789', value: Account.prettyId(id), 'aria-label': 'Headroom ID' });
    const codeIn = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxlength: '7', value: code.replace(/\D/g, ''), 'aria-label': 'Support code' });
    const nameIn = h('input', { type: 'text', value: pref('headroom.supportName'), placeholder: 'Shown to the person at the computer', autocomplete: 'name' });
    const relayIn = h('input', { type: 'text', inputmode: 'url', value: knownRelay, placeholder: 'accounts.example.com', autocapitalize: 'off', spellcheck: 'false' });
    const relayWrap = h('div', { hidden: !!knownRelay }, h('label', { class: 'field' }, 'Relay server'), relayIn,
      h('p', { class: 'muted small' }, 'The Headroom account server the computer uses (its owner knows it).'));
    idIn.addEventListener('input', () => { idIn.value = Account.prettyId(idIn.value).slice(0, 11); });
    const submit = h('button', { type: 'submit', class: 'primary' }, 'Connect');
    const form = h('form', {},
      h('h2', {}, 'Connect with an ID'),
      h('p', { class: 'muted small' }, 'Ask the person at the computer for its Headroom ID and a support code (Headroom Server → Remote support). They\'ll be asked to accept.'),
      h('label', { class: 'field' }, 'Headroom ID'), idIn,
      h('label', { class: 'field' }, 'Support code'), codeIn,
      h('label', { class: 'field' }, 'Your name'), nameIn, relayWrap, err,
      h('div', { class: 'actions' },
        knownRelay ? h('button', { type: 'button', class: 'link', onclick: () => { relayWrap.hidden = false; relayIn.focus(); } }, 'Other relay…') : null,
        h('span', { style: { flex: '1' } }),
        h('button', { type: 'button', onclick: () => done() }, 'Cancel'), submit));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      err.textContent = '';
      const rid = idIn.value.replace(/\D/g, ''), c = codeIn.value.replace(/\D/g, '');
      if (!/^\d{9}$/.test(rid)) { err.textContent = 'A Headroom ID has 9 digits.'; return; }
      if (!/^\d{6}$/.test(c)) { err.textContent = 'A support code has 6 digits.'; return; }
      let relay;
      try { relay = Account.normalizeServer(relayIn.value); } catch { relayWrap.hidden = false; err.textContent = 'Enter the relay server.'; relayIn.focus(); return; }
      const u = new URL(relay);
      if (u.protocol === 'http:' && location.protocol !== 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) {
        err.textContent = 'The relay server needs HTTPS (https://…).';
        return;
      }
      const url = `${relay}/r/${rid}`;
      submit.disabled = true;
      let info;
      try {
        const r = await fetch(`${url}/api/info`, { cache: 'no-store' });
        info = await r.json().catch(() => ({}));
        if (!r.ok) {
          err.textContent = info.error === 'unknown-id' ? 'No computer has that ID on this relay.'
            : info.error === 'offline' ? 'That computer isn\'t connected right now. Is Headroom Server running on it?'
              : info.message || `The relay answered ${r.status}.`;
          return;
        }
      } catch {
        relayWrap.hidden = false;
        err.textContent = 'Can\'t reach the relay server. Check its address and your connection.';
        return;
      } finally { submit.disabled = false; }
      pref('headroom.lastRelay', relay);
      if (nameIn.value.trim()) pref('headroom.supportName', nameIn.value.trim());
      done(true);
      // A one-off: not saved with your computers. The session reconnects with the key it gets once accepted.
      connect({
        id: `support:${rid}`, name: info.host?.name || `Computer ${Account.prettyId(rid)}`, os: info.host?.os, url,
        support: { code: c, name: nameIn.value.trim() || deviceLabel() },
      });
    });
    dlg.append(form);
    setTimeout(() => (id ? (code ? submit : codeIn) : idIn).focus(), 50);
  });
}

// ---------------------------------------------------------------------------------------------- account

const lastServerKey = 'headroom.lastAccountServer';

/** The account server this app signs in to: the page's own when served by one, else the configured default. */
function defaultServer() {
  if (servedByAccount()) return location.origin;
  return DEFAULT_ACCOUNT_SERVER || pref(lastServerKey);
}

/**
 * The sign-in form: username and password (and a code when two-factor is on), for the default account server
 * unless "Change server" is used. Inline on the home screen when signed out, or in a dialog.
 */
function signInForm({ inline = false, onDone, onCancel } = {}) {
  let server = defaultServer();
  let info = null, register = false;
  const err = h('div', { class: 'error', role: 'alert' });
  const srv = h('input', { type: 'text', value: server, placeholder: 'accounts.example.com', autocomplete: 'url', autocapitalize: 'off', spellcheck: 'false', inputmode: 'url', 'aria-label': 'Account server' });
  const srvWrap = h('div', { hidden: !!server }, h('label', { class: 'field' }, 'Account server'), srv);
  const where = h('span', {}, server ? server.replace(/^https?:\/\//, '') : '');
  const change = h('button', { type: 'button', class: 'link', hidden: !server || servedByAccount() || null, onclick: () => { srvWrap.hidden = false; change.hidden = true; srv.focus(); } }, 'Change server');
  const serverLine = h('p', { class: 'muted small', hidden: !server }, 'Your Headroom account on ', where, change.hidden ? null : ' · ', change);
  const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Username', value: pref('headroom.lastUsername') });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const totp = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxlength: '6', 'aria-label': 'Authenticator code' });
  const totpWrap = h('div', { hidden: true }, h('label', { class: 'field' }, 'Authenticator code'), totp);
  const title = h('h2', {}, 'Sign in');
  const switchLink = h('button', { type: 'button', class: 'link', hidden: true }, 'Create an account');
  const submit = h('button', { type: 'submit', class: inline ? 'primary wide' : 'primary' }, 'Sign in');
  const setMode = r => {
    register = r;
    title.textContent = r ? 'Create your account' : 'Sign in';
    switchLink.textContent = r ? 'I have an account' : 'Create an account';
    submit.textContent = r ? 'Create account' : 'Sign in';
    pass.autocomplete = r ? 'new-password' : 'current-password';
    pass.placeholder = r ? 'At least 8 characters' : '';
  };
  switchLink.onclick = () => setMode(!register);
  const checkServer = async () => {
    err.textContent = '';
    info = null;
    try { server = Account.normalizeServer(srv.value); } catch (e) { err.textContent = e.message; srvWrap.hidden = false; return false; }
    // An https:// page (any Headroom Server, Headroom Viewer) may not call plain-HTTP servers, except on loopback.
    const u = new URL(server);
    if (u.protocol === 'http:' && location.protocol !== 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) {
      err.textContent = 'The account server needs HTTPS (https://…): the app can\'t reach plain-HTTP servers from here.';
      return false;
    }
    info = await Account.serverInfo(server);
    if (!info) { err.textContent = `Can't reach ${server.replace(/^https?:\/\//, '')} right now. Check your connection.`; return false; }
    where.textContent = server.replace(/^https?:\/\//, '');
    switchLink.hidden = !info.signup;
    if (info.firstAccount && info.signup) setMode(true); // a brand-new server: the first account is the owner's
    return true;
  };
  srv.addEventListener('change', checkServer);
  const form = h('form', { class: inline ? 'signin-card' : null }, title, serverLine, srvWrap,
    h('label', { class: 'field' }, 'Username'), user,
    h('label', { class: 'field' }, 'Password'), pass, totpWrap, err,
    inline
      ? h('div', {}, submit, h('div', { class: 'row-center' }, switchLink))
      : h('div', { class: 'actions' }, switchLink, h('span', { style: { flex: '1' } }),
        h('button', { type: 'button', onclick: () => onCancel?.() }, 'Cancel'), submit));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    submit.disabled = true;
    try {
      if (!info && !await checkServer()) return;
      err.textContent = '';
      await Account.signIn(server, {
        username: user.value.trim(), password: pass.value, totp: totp.value.trim() || undefined,
        deviceName: deviceLabel(), platform: platformId(), register,
      });
      pref(lastServerKey, server);
      onDone?.();
      await refreshAccount();
      renderHome();
      const n = Account.accountHosts().length;
      toast(Account.loadAccount()?.passwordWeak
        ? 'Signed in. Please change your password: it doesn\'t meet this server\'s rules (tap your name).'
        : n ? `Signed in · ${n} computer${n === 1 ? '' : 's'}` : 'Signed in. Now add your computers: Headroom Server → Settings → Account on each one.', 7000);
    } catch (ex) {
      const b = ex.body || {};
      if (b.error === 'totp-required') { totpWrap.hidden = false; totp.focus(); err.textContent = 'Enter the 6-digit code from your authenticator app.'; }
      else if (b.error === 'bad-totp') err.textContent = 'That code didn\'t work. Wait for the next one and try again.';
      else if (b.error === 'bad-credentials') err.textContent = 'Wrong username or password.';
      else if (b.error === 'rate-limited') err.textContent = `Too many attempts. Try again in ${b.retryAfter || 60} s.`;
      else err.textContent = ex.message;
    } finally { submit.disabled = false; }
  });
  if (server) checkServer();
  form.focusFirst = () => (server ? user : srv).focus();
  return form;
}

async function signInFlow() {
  return dialog((dlg, done) => {
    const form = signInForm({ onDone: () => done(true), onCancel: () => done() });
    dlg.append(form);
    setTimeout(() => form.focusFirst(), 50);
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
    const fail = e => { msg.textContent = e.body?.message || (e.body?.error === 'bad-credentials' ? 'Wrong password.' : e.body?.error === 'bad-totp' ? 'That code didn\'t work.' : e.message); };
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
          d.current ? null : confirmButton('Remove', d.kind === 'computer' ? 'Remove from account?' : 'Sign it out?', async () => {
            try { await Account.removeDevice(a, d.id); load(); refreshAccount(); } catch (e) { fail(e); }
          }))));
        drawTotp(info.account.totpEnabled);
        Account.updateAccount({ role: info.account.role });
        roleLine.hidden = info.account.role !== 'admin';
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
    const roleLine = h('div', { hidden: a.role !== 'admin' },
      h('p', { class: 'small' }, h('span', { class: 'tag' }, 'Administrator'), ' You can invite people and manage the accounts on this server.'),
      h('button', { type: 'button', class: 'small-btn primary', onclick: () => { done(); peopleDialog(); } }, 'Manage people'));
    const weak = a.passwordWeak ? h('div', { class: 'callout small' }, h('b', {}, 'Please change your password.'),
      ' It doesn\'t meet this server\'s rules (at least 12 characters, not your username, not a common or breached password). A few random words work well.') : null;
    dlg.append(h('div', { class: 'body' },
      h('h2', {}, a.username),
      h('p', { class: 'muted small' }, `Headroom account at ${a.server.replace(/^https?:\/\//, '')}`),
      roleLine,
      h('h3', { class: 'sub-h' }, 'Computers and devices'), list,
      h('h3', { class: 'sub-h' }, 'Security'), weak, totpBox,
      h('p', { class: 'small muted' }, 'Change password: at least 12 characters (a few words work well). Your other browsers and phones will need to sign in again.'),
      h('div', { class: 'row-inline' }, cur, nw, h('button', {
        type: 'button', class: 'small-btn', onclick: async () => {
          try {
            const r = await Account.changePassword(a, cur.value, nw.value);
            cur.value = nw.value = '';
            msg.textContent = '';
            Account.updateAccount({ passwordWeak: false });
            weak?.remove();
            toast(r.signedOut ? `Password changed. ${r.signedOut} other device${r.signedOut === 1 ? '' : 's'} signed out.` : 'Password changed.', 5000);
          } catch (e) { fail(e); }
        },
      }, 'Change password')),
      msg,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'danger', onclick: async () => { done(); await Account.signOut(); renderHome(); toast('Signed out'); } }, 'Sign out'),
        h('button', { type: 'button', class: 'primary', onclick: () => done() }, 'Done'))));
    load();
  });
}

const agoText = d => {
  if (!d) return 'never';
  const sec = (Date.now() - new Date(d)) / 1000;
  return sec < 90 ? 'just now' : sec < 3600 ? `${Math.round(sec / 60)} min ago` : sec < 86400 ? `${Math.round(sec / 3600)} h ago` : new Date(d).toLocaleDateString();
};

/** A button that asks "are you sure?" in place: the first tap arms it, the second (within 5 s) runs it. */
function confirmButton(label, question, run) {
  let armed = 0;
  const b = h('button', { type: 'button', class: 'small-btn danger' }, label);
  b.onclick = async () => {
    if (!armed) {
      b.textContent = question;
      armed = setTimeout(() => { armed = 0; b.textContent = label; }, 5000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    b.disabled = true;
    try { await run(); } finally { b.disabled = false; b.textContent = label; }
  };
  return b;
}

/** Password rules shown wherever a new password is chosen (the server checks them too, plus breached passwords). */
const passwordHint = () => h('p', { class: 'muted small' }, 'At least 12 characters. A few random words make a strong, easy one; spaces are fine. Passwords known from data breaches are refused.');

/** Administrators: the people on this server. Invite links, password reset links, two-factor resets, roles, removal. */
function peopleDialog() {
  const a = Account.loadAccount();
  if (!a) return signInFlow();
  return dialog((dlg, done) => {
    const msg = h('div', { class: 'error', role: 'alert' });
    const result = h('div');
    const users = h('div', { class: 'list-mini' }, h('p', { class: 'muted small' }, 'Loading…'));
    const invites = h('div', { class: 'list-mini' });
    const fail = e => { msg.textContent = e.body?.message || (e.body?.error === 'bad-credentials' ? 'Wrong password.' : e.message); };
    const showLink = (title, url, note) => {
      const field = h('input', { type: 'text', readonly: true, value: url, class: 'mono', 'aria-label': 'Link', onclick: e => e.target.select() });
      const qr = h('div', { class: 'qr-mini' });
      qr.innerHTML = qrSvg(url, { border: 2 });
      result.replaceChildren(h('div', { class: 'callout' }, h('b', {}, title), h('p', { class: 'small' }, note),
        h('div', { class: 'row-inline' }, field, h('button', {
          type: 'button', class: 'small-btn', onclick: async e => {
            try { await navigator.clipboard.writeText(url); e.target.textContent = 'Copied'; } catch { field.select(); e.target.textContent = 'Press ⌘C / Ctrl+C'; }
          },
        }, 'Copy')), qr));
      result.scrollIntoView({ block: 'nearest' });
    };
    // Changes that could lock someone out ask for your password again (re-authentication), right in the row.
    const withPassword = (row, label, run) => {
      row.querySelector('.reauth')?.remove();
      const pw = h('input', { type: 'password', placeholder: 'Your password', autocomplete: 'current-password', 'aria-label': 'Your password' });
      const go = h('button', { type: 'submit', class: 'small-btn danger' }, label);
      const box = h('form', { class: 'row-inline reauth' }, pw, go, h('button', { type: 'button', class: 'small-btn', onclick: () => box.remove() }, 'Cancel'));
      box.onsubmit = async e => {
        e.preventDefault();
        go.disabled = true;
        try { await run(pw.value); msg.textContent = ''; box.remove(); load(); } catch (ex) { fail(ex); } finally { go.disabled = false; }
      };
      row.append(box);
      pw.focus();
    };
    const userRow = u => {
      const me = u.id === a.accountId;
      const row = h('div', { class: 'person' },
        h('div', {}, svg(I.user, 16), ' ', h('b', {}, u.username), me ? h('span', { class: 'tag' }, 'you') : null,
          u.role === 'admin' ? h('span', { class: 'tag' }, 'administrator') : null, u.totpEnabled ? h('span', { class: 'tag' }, 'two-factor') : null),
        h('div', { class: 'muted small' }, `${u.computers} computer${u.computers === 1 ? '' : 's'} · ${u.devices} signed-in device${u.devices === 1 ? '' : 's'} · active ${agoText(u.lastSeen)}`));
      if (!me) {
        row.append(h('div', { class: 'row-inline' },
          h('button', {
            type: 'button', class: 'small-btn', title: 'A link to choose a new password (24 hours, works once). Their devices are signed out when they use it.',
            onclick: async () => {
              try {
                const r = await Account.resetLink(a, u.id);
                showLink(`Password reset link for ${u.username}`, Account.linkFor(a.server, 'reset', r.token), 'Send it to them privately. It works once, for 24 hours; using it signs out their browsers and phones.');
              } catch (e) { fail(e); }
            },
          }, 'Reset password'),
          u.totpEnabled ? h('button', { type: 'button', class: 'small-btn', onclick: () => withPassword(row, 'Turn off their two-factor', pw => Account.resetUserTwoFactor(a, u.id, pw)) }, 'Reset two-factor') : null,
          h('button', {
            type: 'button', class: 'small-btn',
            onclick: () => withPassword(row, u.role === 'admin' ? 'Make regular user' : 'Make administrator', pw => Account.setUserRole(a, u.id, u.role === 'admin' ? 'user' : 'admin', pw)),
          }, u.role === 'admin' ? 'Remove administrator' : 'Make administrator'),
          h('button', { type: 'button', class: 'small-btn danger', onclick: () => withPassword(row, `Delete ${u.username}`, pw => Account.deleteUser(a, u.id, pw)) }, 'Delete')));
      }
      return row;
    };
    const load = async () => {
      try {
        const [us, inv] = await Promise.all([Account.listUsers(a), Account.listInvites(a)]);
        us.sort((x, y) => (x.id === a.accountId ? -1 : y.id === a.accountId ? 1 : x.username.localeCompare(y.username)));
        users.replaceChildren(...us.map(userRow));
        invites.replaceChildren(...(inv.length ? inv.map(x => h('div', { class: 'li-mini' },
          h('div', { class: 'grow' }, h('div', {}, x.note || 'Invite', x.role === 'admin' ? h('span', { class: 'tag' }, 'administrator') : null),
            h('div', { class: 'muted small' }, `expires ${new Date(x.expires).toLocaleDateString()}`)),
          confirmButton('Cancel', 'Cancel invite?', async () => { try { await Account.cancelInvite(a, x.id); load(); } catch (e) { fail(e); } }))) : [h('p', { class: 'muted small' }, 'No open invites.')]));
      } catch (e) {
        if (e.status === 403) { msg.textContent = 'Only administrators can manage people.'; Account.updateAccount({ role: 'user' }); return; }
        fail(e);
      }
    };
    const note = h('input', { type: 'text', placeholder: 'Their name (optional)', 'aria-label': 'Their name' });
    const role = h('select', { 'aria-label': 'Role' }, h('option', { value: 'user' }, 'Regular user'), h('option', { value: 'admin' }, 'Administrator'));
    const create = h('button', { type: 'submit', class: 'small-btn primary' }, 'Create invite link');
    const inviteForm = h('form', { class: 'row-inline' }, note, role, create);
    const adminPw = h('input', { type: 'password', placeholder: 'Your password (to invite an administrator)', autocomplete: 'current-password', hidden: true, 'aria-label': 'Your password' });
    role.onchange = () => { adminPw.hidden = role.value !== 'admin'; };
    inviteForm.onsubmit = async e => {
      e.preventDefault();
      create.disabled = true;
      try {
        const r = await Account.createInvite(a, { role: role.value, note: note.value.trim(), password: adminPw.value || undefined });
        msg.textContent = '';
        note.value = adminPw.value = '';
        showLink(`Invite link${r.role === 'admin' ? ' (administrator)' : ''}`, Account.linkFor(a.server, 'invite', r.token),
          'Send it to the person you\'re inviting. They choose their own username and password. It works once, for 7 days.');
        load();
      } catch (ex) { fail(ex); } finally { create.disabled = false; }
    };
    dlg.append(h('div', { class: 'body' },
      h('h2', {}, 'People'),
      h('p', { class: 'muted small' }, `Accounts on ${a.server.replace(/^https?:\/\//, '')}. Each person has their own computers and devices; nobody sees anyone else's.`),
      h('h3', { class: 'sub-h' }, 'Invite someone'), inviteForm, adminPw, result,
      h('h3', { class: 'sub-h' }, 'Open invites'), invites,
      h('h3', { class: 'sub-h' }, 'Accounts'), users,
      msg,
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => { done(); accountDialog(); } }, 'Back'),
        h('button', { type: 'button', class: 'primary', onclick: () => done() }, 'Done'))));
    load();
  });
}

/** Someone opened an invite link (#invite=…): they choose a username and password and are signed in. */
async function inviteFlow(token) {
  const server = defaultServer();
  let info;
  try { info = await Account.inviteInfo(server, token); } catch (e) {
    toast(e.body?.message || 'This invite link is invalid, used or expired. Ask for a new one.', 8000);
    return;
  }
  if (Account.loadAccount()) await Account.signOut(); // this device joins the new account
  return dialog((dlg, done) => {
    const err = h('div', { class: 'error', role: 'alert' });
    const user = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Username' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Password' });
    const again = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Password again' });
    const submit = h('button', { type: 'submit', class: 'primary' }, 'Create account');
    const form = h('form', {},
      h('h2', {}, 'Create your Headroom account'),
      h('p', { class: 'muted small' }, `${info.from ? `${info.from} invited you` : 'You\'re invited'} to ${server.replace(/^https?:\/\//, '')}${info.role === 'admin' ? ' as an administrator' : ''}. Then add your computers and reach them from any browser.`),
      h('label', { class: 'field' }, 'Username'), user,
      h('p', { class: 'muted small' }, '3–64 letters, digits, dots, dashes or underscores.'),
      h('label', { class: 'field' }, 'Password'), pass,
      h('label', { class: 'field' }, 'Password again'), again, passwordHint(), err,
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => done() }, 'Cancel'), submit));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      err.textContent = '';
      if (pass.value !== again.value) { err.textContent = 'The passwords don\'t match.'; return; }
      submit.disabled = true;
      try {
        await Account.signIn(server, { register: true, invite: token, username: user.value.trim(), password: pass.value, deviceName: deviceLabel(), platform: platformId() });
        done(true);
        await refreshAccount();
        renderHome();
        toast('Account created. Now add your computers: Headroom Server → Settings → Account on each one.', 7000);
      } catch (ex) {
        err.textContent = ex.body?.message || ex.message;
      } finally { submit.disabled = false; }
    });
    dlg.append(form);
    setTimeout(() => user.focus(), 50);
  });
}

/** Someone opened a password reset link (#reset=…) from an administrator. */
async function resetFlow(token) {
  const server = defaultServer();
  let info;
  try { info = await Account.resetInfo(server, token); } catch (e) {
    toast(e.body?.message || 'This reset link is invalid, used or expired. Ask for a new one.', 8000);
    return;
  }
  return dialog((dlg, done) => {
    const err = h('div', { class: 'error', role: 'alert' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
    const again = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password again' });
    const submit = h('button', { type: 'submit', class: 'primary' }, 'Set password');
    const form = h('form', {},
      h('h2', {}, `New password for ${info.username}`),
      h('p', { class: 'muted small' }, 'Your browsers and phones will be signed out; sign in again with the new password.'),
      h('input', { type: 'text', autocomplete: 'username', value: info.username, hidden: true, readonly: true }),
      h('label', { class: 'field' }, 'New password'), pass,
      h('label', { class: 'field' }, 'Again'), again, passwordHint(), err,
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => done() }, 'Cancel'), submit));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      err.textContent = '';
      if (pass.value !== again.value) { err.textContent = 'The passwords don\'t match.'; return; }
      submit.disabled = true;
      try {
        await Account.resetPassword(server, token, pass.value);
        if (Account.loadAccount()?.username === info.username) await Account.signOut();
        try { localStorage.setItem('headroom.lastUsername', info.username); } catch { }
        done(true);
        $('signin-slot').replaceChildren(); // rebuilt with the username filled in
        renderHome();
        toast('Password changed. Sign in with it now.', 6000);
      } catch (ex) {
        err.textContent = ex.body?.message || ex.message;
      } finally { submit.disabled = false; }
    });
    dlg.append(form);
    setTimeout(() => pass.focus(), 50);
  });
}

main();
