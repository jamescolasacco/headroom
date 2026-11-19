// Headroom web client — entry point. Signed out: "Got a code?" and sign in / create account. Signed in: your
// devices (every device that has signed in with Headroom Server) and your Account page. Then sessions.
import { Session } from './session.js';
import { h, svg, dialog, toast, announce, field, busy, nextId, plural, trackWindowFront } from './ui/dom.js';
import { I } from './ui/icons.js';
import { lightOf } from './ui/light.js';
import { qrSvg } from './qr.js';
import { deviceLabel, platformId, secure, hasWebCodecs, isStandalone, isIOS, nativeViewer, postNative, onNative } from './platform.js';
import * as Account from './account.js';
import { DEFAULT_ACCOUNT_SERVER, DOWNLOAD_URL } from './config.js';
import { UpdateCorner } from './ui/updates.js';

const $ = id => document.getElementById(id);
let session = null;
let server = DEFAULT_ACCOUNT_SERVER; // the Headroom service: this page's own origin when it serves the app
let info = null;                     // its /api/info (sign-up open, Turnstile site key)
let signedOutNotice = '';            // shown once on the sign-in card (after deleting the account, …)

const CHEVRON = '<path d="m9 6 6 6-6 6"/>';
const EXTERNAL = '<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>';

async function main() {
  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(e => console.warn('[sw]', e));
  }
  Account.forgetOldData();
  $('btn-code').addEventListener('click', () => codeFlow());
  if (nativeViewer) { watchForUpdates(); trackWindowFront(); }
  // Never create history entries: iOS standalone edge-swipe "back" would leave the app.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname);
  // A code link opened in a tab that's already showing Headroom.
  addEventListener('hashchange', () => {
    const code = new URLSearchParams(location.hash.slice(1)).get('code');
    history.replaceState(null, '', location.pathname);
    if (code && !session) codeFlow(code);
  });

  const own = !nativeViewer && await Account.serverInfo(location.origin);
  if (own) { server = location.origin; info = own; }
  renderHome();
  // Headroom Viewer learns the service's details a moment later: "Create account" shows or hides in place.
  if (!info) Account.serverInfo(server).then(i => { info = i; applyInfo(); });

  const refreshed = refreshAccount();
  // Keep the devices (online state) fresh while the home screen is showing.
  const idleRefresh = () => { if (!session && document.visibilityState === 'visible') refreshAccount(); };
  setInterval(idleRefresh, 20000);
  document.addEventListener('visibilitychange', idleRefresh);

  // A guest link: https://<server>/#code=123456789
  if (hash.get('code')) { codeFlow(hash.get('code')); return; }
  // "Open in Safari" from Firefox's Add to Home Screen steps: https://<server>/#install shows Safari's steps here.
  if (hash.has('install') && isIOS && !isStandalone && !nativeViewer) homeScreenSteps();
  // Headroom Viewer's "Open in new window": #connect=<device id>
  if (hash.get('connect')) {
    await refreshed;
    const host = Account.accountHosts().find(x => x.id === hash.get('connect'));
    if (host) connect(host);
  }
  return hash;
}

async function refreshAccount() {
  if (!Account.loadAccount()) return;
  const before = snapshot();
  const a = await Account.refreshComputers();
  if (a === undefined) return; // signed out (or in again) here meanwhile
  if (!a) {
    signedOutNotice = 'You were signed out: from another device, or because your password changed.';
    if (!session) { rebuildSignIn(); renderHome(); }
    return;
  }
  if (!session && snapshot() !== before) renderHome();
}
const snapshot = () => JSON.stringify([Account.loadAccount()?.error, Account.accountHosts().map(x => [x.id, x.name, x.online, x.relayOnline, x.lastSeen])]);

// ---------------------------------------------------------------------------------------------- updates

/**
 * Headroom Viewer checks for updates and downloads them by itself; the download button in the home screen's corner
 * checks now, shows a download, and becomes Restart to update once one is ready (ui/updates.js).
 */
function watchForUpdates() {
  const slot = $('update-corner');
  const corner = new UpdateCorner(slot, { app: 'Headroom Viewer', post: postNative }); // installing asks first mid-session
  slot.hidden = false;
  onNative(m => { if (m?.cmd === 'update') corner.set(m); });
  postNative({ cmd: 'getUpdate' });
}

// ---------------------------------------------------------------------------------------------- home

function renderHome() {
  $('viewer').hidden = true;
  $('home').hidden = false;
  const acct = Account.loadAccount();
  $('signed-out').hidden = !!acct;
  $('signed-in').hidden = !acct;
  const chip = $('account-chip');
  chip.hidden = !acct;
  if (acct) {
    chip.replaceChildren(svg(I.user, 16), h('span', {}, acct.email), ...(acct.error ? [h('span', { class: 'chip-note' }, '· offline')] : []));
    chip.setAttribute('aria-label', `Account: ${acct.email}${acct.error ? ' (offline)' : ''}`);
    chip.title = acct.email; // the chip cuts a long email short
    chip.onclick = () => accountPage();
    $('signin-slot').replaceChildren();
    renderDevices(acct);
  } else {
    // Kept across re-renders so typing isn't lost.
    if (!$('code-slot').firstChild) $('code-slot').append(codeForm({ inline: true }));
    if (!$('signin-slot').firstChild) $('signin-slot').append(authCard());
  }
  renderInstall(acct);
  const hint = [];
  if (cantShow()) hint.push(cantShow());
  $('home-hint').textContent = hint.join(' ');
}

// ---------------------------------------------------------------------------------------- the app on your phone

// Chrome and Edge (Android, Windows, Mac) offer to install the website as an app: the install button here asks them.
let installPrompt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; renderInstall(); });
addEventListener('appinstalled', () => { installPrompt = null; renderInstall(); });

/**
 * "Install app" under your devices, while this is a website in a browser tab: Chrome's and Edge's own install dialog,
 * or on an iPhone or iPad, the steps for Add to Home Screen (a website can't open that for you there; the share sheet a
 * page can open doesn't even list it).
 */
function renderInstall(acct = Account.loadAccount()) {
  const slot = $('install-slot');
  const ios = isIOS && !nativeViewer;
  const show = !!acct && !isStandalone && (!!installPrompt || ios);
  slot.hidden = !show;
  if (!show) { slot.replaceChildren(); return; }
  const btn = h('button', { type: 'button', class: 'small-btn' }, svg(I.addHome, 18), installPrompt ? 'Install app' : 'Add to Home Screen');
  btn.onclick = async () => {
    if (!installPrompt) { homeScreenSteps(); return; }
    const p = installPrompt;
    installPrompt = null; // each offer can be shown once; the browser makes a new one if you say no
    await p.prompt().catch(() => { });
    renderInstall();
  };
  slot.replaceChildren(btn);
}

/**
 * iPhone and iPad: Add to Home Screen, in the browser you're in. Firefox puts a letter on the icon whatever the site
 * declares (mozilla-mobile/firefox-ios#33663: touch icons, manifest icons and favicons all ignored), so in Firefox it
 * leads with "Open in Safari" (x-safari-https: opens a page in Safari from another browser, iOS 15 and 17 on), which
 * opens this page there with Safari's steps showing (#install): the same app, with Headroom's icon.
 */
function homeScreenSteps() {
  const ua = navigator.userAgent;
  const firefox = /FxiOS/.test(ua);
  const glyph = path => h('span', { class: 'glyph', 'aria-hidden': 'true' }, svg(path, 17));
  if (firefox) {
    const safari = `x-safari-https://${location.host}/#install`;
    dialog(dlg => {
      dlg.append(h('div', { class: 'body' },
        h('h2', {}, 'Add Headroom to your Home Screen'),
        h('p', { class: 'muted' }, 'Firefox puts a letter on the icon. Safari uses Headroom\'s.'),
        h('div', { class: 'actions' }, h('a', { class: 'button primary', href: safari }, 'Open in Safari')),
        h('p', { class: 'muted small' }, `Didn't open? Go to ${location.host} in Safari.`)));
    });
    return;
  }
  const first = /CriOS/.test(ua) ? ['Tap Share ', glyph(I.share), ' in the address bar.']
    : /EdgiOS/.test(ua) ? ['Tap the menu ', glyph(I.more), ', then Share.']
    : ['Tap Share ', glyph(I.share), '. In the newest Safari it\'s in the ', glyph(I.more), ' menu.'];
  dialog(dlg => {
    dlg.append(h('div', { class: 'body' },
      h('h2', {}, 'Add Headroom to your Home Screen'),
      h('ol', { class: 'steps' },
        h('li', {}, ...first),
        h('li', {}, 'Tap Add to Home Screen ', glyph(I.addHome), '. Not in the list? Tap View More first.'),
        h('li', {}, 'Tap Add. Then open Headroom from your Home Screen and sign in once more there.'))));
  });
}

/** Starts the sign-in card over (it's kept between renders so typing isn't lost). */
function rebuildSignIn() { $('signin-slot').replaceChildren(); }

/** The service's details arrived after the card was drawn: show "Create account" only when sign-up is open. */
function applyInfo() {
  const link = $('signin-slot').querySelector('[data-signup]');
  if (link) link.hidden = !!info && !info.signup;
}

/** Why this browser can't show a remote screen ('' when it can). */
const cantShow = () => !secure ? 'This page isn\'t on a secure (HTTPS) connection, so it can\'t show a remote screen.'
  : !hasWebCodecs ? 'This browser can\'t show a remote screen. Use Safari 16.4 or later, Chrome or Edge 94+, or Firefox 130+.' : '';

function renderDevices(acct) {
  const hosts = Account.accountHosts(acct).sort((a, b) =>
    (b.online - a.online) || (b.lastConnected - a.lastConnected) || a.name.localeCompare(b.name));
  // Keep focus on the same device when the list redraws (it refreshes every 20 s).
  const focused = document.activeElement?.closest?.('.host')?.dataset.id;
  $('host-list').replaceChildren(...hosts.map(hostCard));
  if (focused) $('host-list').querySelector(`.host[data-id="${CSS.escape(focused)}"] .host-main`)?.focus({ preventScroll: true });
  const empty = $('home-empty');
  empty.hidden = hosts.length > 0;
  if (!empty.querySelector('.empty-actions')) {
    empty.querySelector('.empty-text').append(h('div', { class: 'empty-actions' },
      h('a', { class: 'button primary', href: DOWNLOAD_URL, target: '_blank', rel: 'noopener' }, 'Get Headroom Server', svg(EXTERNAL, 16))));
  }
}

const ago = d => {
  if (!d) return 'never';
  const sec = (Date.now() - new Date(d)) / 1000;
  return sec < 90 ? 'just now' : sec < 3600 ? `${Math.round(sec / 60)} min ago` : sec < 86400 ? `${Math.round(sec / 3600)} h ago` : new Date(d).toLocaleDateString();
};

/** A device is its screen: lit in its own light while it's online, dark glass while it isn't. */
function hostCard(host) {
  const status = host.online ? 'Online' : `Offline, last seen ${ago(host.lastSeen)}`;
  const face = h('span', { class: 'face', 'aria-hidden': 'true' }, svg(host.os === 'macos' ? I.apple : I.windows, 28));
  // Named with its status too ("Studio Mac, Online"); the tooltip shows a name the caption had to cut short.
  const main = h('button', { class: 'host-main', type: 'button', title: host.name, 'aria-label': `${host.name}, ${status}` },
    face,
    h('span', { class: 'host-text' },
      h('span', { class: 'name' }, host.name, host.viewOnly ? h('span', { class: 'tag' }, 'view only') : null),
      h('span', { class: 'addr' }, h('span', { class: `dot ${host.online ? 'online' : 'offline'}`, 'aria-hidden': 'true' }), status)));
  main.addEventListener('click', () => connect(host, face));
  return h('div', { class: `host${host.online ? '' : ' offline'}`, role: 'listitem', 'data-id': host.id, 'data-light': lightOf(host.id) }, main,
    nativeViewer && host.online ? h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': `Open ${host.name} in a new window`, title: 'Open in a new window',
      onclick: () => postNative({ cmd: 'newWindow', url: `${location.origin}/index.html#connect=${encodeURIComponent(host.id)}` }),
    }, svg(EXTERNAL)) : null);
}

/**
 * The one authored motion: the screen you tap grows into the session, and shrinks back into its tile when you
 * leave (View Transitions, where the browser has them and motion is welcome; otherwise it simply cuts).
 */
function morph(update, { from = null, to = () => null, leaving = false } = {}) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { update(); return Promise.resolve(); }
  const root = document.documentElement;
  root.classList.toggle('leaving', leaving);
  if (from) from.style.viewTransitionName = 'screen';
  const t = document.startViewTransition(() => {
    if (from) from.style.viewTransitionName = '';
    update();
    const target = to();
    if (target) target.style.viewTransitionName = 'screen';
  });
  t.finished.catch(() => { }).finally(() => {
    root.classList.remove('leaving');
    const target = to();
    if (target) target.style.viewTransitionName = '';
  });
  return t.updateCallbackDone.catch(() => { }); // the new state is in the page (a frame from now)
}
const tileOf = id => id && $('host-list').querySelector(`.host[data-id="${CSS.escape(id)}"] .face`);

/**
 * A computer that's asleep (or off) isn't refused: the session waits for it. A sleeping Mac wakes for a moment every
 * few minutes and reaches Headroom's relay then: the session starts at that moment, and starting it wakes the Mac up.
 * Resolves with where to reach it once it's there (`host` is brought up to date), `{ gone }` if it left your
 * account, `{ signedOut }` if this device did, `{}` if it isn't back within 10 minutes or you left.
 */
async function waitForComputer(host, left) {
  const until = Date.now() + 10 * 60_000;
  while (!left() && Date.now() < until) {
    await new Promise(r => setTimeout(r, 3000));
    if (left()) return {};
    const a = await Account.refreshComputers();
    if (!a) return { signedOut: true };
    const now = Account.accountHosts(a).find(x => x.id === host.id);
    if (!now) { if (!a.error) return { gone: true }; continue; } // (a.error: no list this time, the phone is offline)
    if (!now.online && !now.relayOnline) continue;
    Object.assign(host, now);
    const url = await Account.reachableUrl(host);
    if (url) return { url };
  }
  return {};
}

const ASLEEP = {
  macos: 'It\'s asleep or offline.',
  other: 'It\'s asleep or off.',
};

function connect(host, face = null) {
  if (session) return;
  if (cantShow()) { toast(cantShow()); return; }
  const s = session = new Session(host, {
    // Leaving: the session shrinks back into its tile (the code box has no tile: it just cuts).
    leaveWith: finish => morph(finish, { to: () => (host.computerId ? tileOf(host.id) : null), leaving: true }),
    onExit: () => {
      session = null;
      renderHome();
      refreshAccount();
      // Back where you were: on the device you left, or on the code box.
      const card = host.computerId && $('host-list').querySelector(`.host[data-id="${CSS.escape(host.id)}"] .host-main`);
      (card || (Account.loadAccount() ? $('devices-heading') : document.querySelector('#code-slot input')))?.focus({ preventScroll: true });
    },
    onUnauthorized: () => refreshAccount(),
  });
  globalThis.__headroomSession = s; // handy for debugging from the console
  s.unlockFromGesture(); // audio must be unlocked inside this tap (iOS): before any await
  // At once: the screen wakes up while the connection is found (and nothing changes the page before it has).
  const shown = morph(() => s.prepare(), { from: face });
  (async () => {
    await shown;
    if (session !== s) return;
    if (host.account) {
      // Not reachable now (asleep, off, or it just dozed off and the list doesn't know yet): wait for it.
      let url = host.online || host.relayOnline ? await Account.reachableUrl(host) : null;
      if (session !== s) return;
      if (!url) {
        s.waitingFor(ASLEEP[host.os === 'macos' ? 'macos' : 'other']);
        const back = await waitForComputer(host, () => session !== s);
        if (session !== s) return;
        if (!back.url) {
          s.stop();
          if (back.gone) toast(`${host.name} isn't in your account anymore.`);
          else if (!back.signedOut) toast(`${host.name} didn't come online in 10 minutes. Try again when it's on.`);
          return;
        }
        url = back.url;
      }
      host.url = url;
      Account.noteConnected(host.computerId, url);
    }
    await s.start();
  })().catch(e => {
    console.error(e);
    toast(`Couldn't start: ${e.message}`);
    s.stop();
  });
}

// ---------------------------------------------------------------------------------------------- guest codes

const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k) || ''; if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { } return ''; };
const formError = () => h('p', { class: 'form-error', role: 'alert' });
const errorText = ex => {
  const b = ex.body || {};
  if (b.error === 'rate-limited') return `Too many attempts. Try again in ${b.retryAfter || 60} seconds.`;
  return b.message || ex.message;
};

/**
 * "Got a code?": someone at another computer clicked "Let someone connect" and gave you a 9-digit code (or a
 * link with it). No account needed; they accept you on their screen.
 */
function codeForm({ inline = false, code = '', onDone } = {}) {
  const err = formError();
  const codeIn = h('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', name: 'guest-code', placeholder: '123 456 789', class: 'code-input',
    value: Account.prettyCode(code), spellcheck: 'false',
  });
  codeIn.addEventListener('input', () => { codeIn.value = Account.prettyCode(codeIn.value); err.textContent = ''; });
  const codeField = field('Code', codeIn);
  const nameIn = h('input', { type: 'text', value: pref('headroom.guestName'), name: 'name', placeholder: 'Alex', autocomplete: 'name', maxlength: '40' });
  const nameField = field('Your name', nameIn);
  // On the signed-out page it's a compact row (signing in is that page's main action); in its dialog, the main one.
  const submit = h('button', { type: 'submit', class: inline ? '' : 'primary' }, 'Connect');
  const [codeLabel, , , codeErr] = codeField.nodes;
  const [nameLabel, , nameHint, nameErr] = nameField.nodes;
  const codeRow = h('div', { class: 'code-row' }, codeIn, submit);
  const nameRow = h('div', { class: 'code-row' }, nameIn);
  const nameWrap = inline ? h('div', { hidden: true }, nameLabel, nameRow, nameHint, nameErr) : h('div', {}, ...nameField.nodes);
  // The name appears once you start on the code, and Connect moves down to follow it: code, name, Connect.
  const revealName = () => {
    if (!nameWrap.hidden) return;
    nameWrap.hidden = false;
    nameRow.append(submit);
  };
  if (inline) { codeLabel.classList.add('sr-only'); codeIn.addEventListener('focus', revealName); }
  const form = h('form', { class: inline ? 'code-screen' : 'code-screen code-dialog', novalidate: true },
    h('h2', {}, 'Got a code?'),
    ...(inline ? [codeLabel, codeRow, codeErr] : codeField.nodes), nameWrap, err,
    inline ? null : h('div', { class: 'actions' }, submit)); // (the dialog's own close button cancels)
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    const why = cantShow();
    if (why) { err.textContent = why; return; }
    const c = codeIn.value.replace(/\D/g, '');
    if (c.length !== 9) { codeField.error('Enter all 9 digits of the code.'); codeIn.focus(); return; }
    const name = nameIn.value.trim();
    // They decide whether to let you in by this name, so it's needed (never this browser's own name).
    if (!name) { if (inline) revealName(); nameField.error('Enter your name, so they know who\'s asking.'); nameIn.focus(); return; }
    const restore = busy(submit, 'Connecting…');
    if (!restore) return;
    try {
      const { url, info: hi } = await Account.lookUpCode(server, c);
      pref('headroom.guestName', name);
      onDone?.();
      codeIn.value = '';
      // A one-off: nothing is saved. Once accepted, the session continues with a key only it holds.
      connect({
        id: `guest:${c.slice(0, 4)}`, hostId: hi.host?.id, name: hi.host?.name || 'Remote computer', os: hi.host?.os, url, online: true,
        support: { code: c, name },
      });
    } catch (ex) {
      if (/code/i.test(ex.message)) { codeField.error(ex.message); codeIn.focus(); } else err.textContent = ex.message;
    } finally { restore(); }
  });
  form.focusFirst = () => (code ? (nameIn.value ? submit : nameIn) : codeIn).focus();
  return form;
}

function codeFlow(code = '') {
  return dialog((dlg, done) => {
    const form = codeForm({ code, onDone: () => done(true) });
    (code ? (form.querySelector('input[name=name]').value ? form.querySelector('button[type=submit]') : form.querySelector('input[name=name]')) : form.querySelector('.code-input')).autofocus = true;
    dlg.append(form);
  });
}

// ---------------------------------------------------------------------------------------------- signing in

/** Cloudflare Turnstile (when the server uses it) on the forms that send email. */
let turnstileScript = null;
function humanCheck() {
  const sitekey = info?.turnstile;
  const el = h('div', { class: 'turnstile', hidden: !sitekey });
  let id = null, token = '';
  if (sitekey) {
    turnstileScript ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => { turnstileScript = null; reject(new Error('Couldn\'t load the human check. Check your connection and reload.')); };
      document.head.append(s);
    });
    turnstileScript.then(t => {
      id = t.render(el, {
        sitekey, theme: 'auto', size: 'flexible',
        callback: tk => { token = tk; }, 'expired-callback': () => { token = ''; }, 'error-callback': () => { token = ''; },
      });
    }).catch(e => { el.textContent = e.message; });
  }
  return {
    el,
    /** The check's token (single use), waiting a little for it to finish. */
    async token() {
      if (!sitekey) return '';
      for (let i = 0; i < 40 && !token; i++) await new Promise(r => setTimeout(r, 250));
      if (!token) throw new Error('Complete the check above the button, then try again.');
      const t = token;
      token = '';
      try { window.turnstile.reset(id); } catch { }
      return t;
    },
  };
}

const PASSWORD_HINT = 'At least 12 characters';

/**
 * The second box of a new password ("Confirm password"), so a typo can't lock you out. `check()` says what's
 * wrong beside it and returns false when it doesn't match `pass` exactly.
 */
function confirmField(pass, label = 'Confirm password') {
  const again = h('input', { type: 'password', name: 'confirm-password', autocomplete: 'new-password' });
  const f = field(label, again);
  f.check = () => {
    if (again.value === pass.value) return true;
    f.error(again.value ? 'The passwords don\'t match. Type the same password in both boxes.' : 'Type the password again to confirm it.');
    again.focus();
    return false;
  };
  return f;
}

/**
 * The signed-out card: sign in, create an account (email, password, then the emailed code), or reset a
 * forgotten password (emailed code). One card that changes step; focus follows the step.
 */
function authCard() {
  const card = h('div', { class: 'signin-card' });
  const show = (step, opts = {}, { focus = true } = {}) => {
    card.replaceChildren(step(show, opts));
    if (!focus) return;
    card.querySelector('input:not([type=hidden])')?.focus({ preventScroll: true });
    // Focus lands on the first field; say which step this is too ("Check your email. We sent a code…").
    announce([card.querySelector('h2')?.textContent, card.querySelector('h2 + p')?.textContent].filter(Boolean).join('. '));
  };
  show(signInStep, { notice: signedOutNotice }, { focus: false });
  if (signedOutNotice) announce(signedOutNotice);
  signedOutNotice = '';
  return card;
}

function signInStep(show, { email = pref('headroom.lastEmail'), notice = '' } = {}) {
  const err = formError();
  const emailIn = h('input', { type: 'email', name: 'email', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', value: email });
  const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password' });
  const totp = h('input', { type: 'text', name: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxlength: '6' });
  const emailF = field('Email', emailIn), passF = field('Password', pass), totpF = field('Code from your authenticator app', totp);
  const totpWrap = h('div', { hidden: true }, ...totpF.nodes);
  const submit = h('button', { type: 'submit', class: 'primary wide' }, 'Sign in');
  // Headroom Viewer can't show the human check: sign-up and password resets happen on the website.
  const web = path => () => window.open(`${server}/${path}`, '_blank', 'noopener');
  const form = h('form', { novalidate: true },
    h('h2', {}, 'Sign in'),
    notice ? h('p', { class: 'notice' }, notice) : null,
    ...emailF.nodes, ...passF.nodes, totpWrap, err, submit,
    h('div', { class: 'row-center links' },
      h('button', { type: 'button', class: 'link', 'data-signup': '', hidden: !!info && !info.signup, onclick: () => nativeViewer && info?.turnstile ? web('#signup')() : show(signUpStep, { email: emailIn.value.trim() }) }, 'Create account'),
      h('span', { 'aria-hidden': 'true' }, ' · '),
      h('button', { type: 'button', class: 'link', onclick: () => nativeViewer && info?.turnstile ? web('#forgot')() : show(forgotStep, { email: emailIn.value.trim() }) }, 'Forgot password?')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    if (!emailIn.value.trim()) { emailF.error('Enter your email.'); emailIn.focus(); return; }
    if (!pass.value) { passF.error('Enter your password.'); pass.focus(); return; }
    const restore = busy(submit, 'Signing in…');
    if (!restore) return;
    try {
      await Account.signIn(server, { email: emailIn.value.trim(), password: pass.value, totp: totp.value.trim() || undefined, deviceName: deviceLabel(), platform: platformId() });
      restore();
      await signedIn();
    } catch (ex) {
      restore();
      const b = ex.body || {};
      if (b.error === 'totp-required') { totpWrap.hidden = false; totpF.error(''); announce('Two-factor sign-in is on: enter the 6-digit code from your authenticator app.'); totp.focus(); }
      else if (b.error === 'bad-totp') { totpF.error('That code didn\'t work. Wait for the next one and try again.'); totp.focus(); }
      else if (b.error === 'bad-credentials') { passF.error('Wrong email or password.'); pass.select(); pass.focus(); }
      else err.textContent = errorText(ex);
    }
  });
  return form;
}

function signUpStep(show, { email = '' } = {}) {
  const err = formError();
  const emailIn = h('input', { type: 'email', name: 'email', autocomplete: 'email', autocapitalize: 'off', spellcheck: 'false', value: email });
  const pass = h('input', { type: 'password', name: 'new-password', autocomplete: 'new-password' });
  const emailF = field('Email', emailIn), passF = field('Password', pass, { hint: PASSWORD_HINT }), againF = confirmField(pass);
  const check = humanCheck();
  const submit = h('button', { type: 'submit', class: 'primary wide' }, 'Create account');
  const form = h('form', { novalidate: true },
    h('h2', {}, 'Create your account'),
    ...emailF.nodes, ...passF.nodes, ...againF.nodes, check.el, err, submit,
    h('div', { class: 'row-center links' }, h('button', { type: 'button', class: 'link', onclick: () => show(signInStep, { email: emailIn.value.trim() }) }, 'I have an account')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    const em = emailIn.value.trim();
    if (!em) { emailF.error('Enter your email.'); emailIn.focus(); return; }
    if (!pass.value) { passF.error('Choose a password.'); pass.focus(); return; }
    if (!againF.check()) return;
    const restore = busy(submit, 'Sending code…');
    if (!restore) return;
    try {
      await Account.signUp(server, { email: em, password: pass.value, turnstile: await check.token() });
      show(codeStep, {
        email: em, kind: 'signup', title: 'Check your email', what: 'to finish creating your account', button: 'Create account',
        run: code => Account.confirmSignUp(server, { email: em, code, password: pass.value, deviceName: deviceLabel(), platform: platformId() }).then(signedIn),
        back: () => show(signUpStep, { email: em }),
      });
    } catch (ex) {
      const b = ex.body || {};
      if (b.error === 'bad-email') { emailF.error(errorText(ex)); emailIn.focus(); }
      else if (b.error === 'weak-password') { passF.error(errorText(ex)); pass.focus(); }
      else err.textContent = errorText(ex);
    } finally { restore(); }
  });
  return form;
}

function forgotStep(show, { email = '' } = {}) {
  const err = formError();
  const emailIn = h('input', { type: 'email', name: 'email', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', value: email });
  const emailF = field('Email', emailIn);
  const check = humanCheck();
  const submit = h('button', { type: 'submit', class: 'primary wide' }, 'Email me a code');
  const form = h('form', { novalidate: true },
    h('h2', {}, 'Forgot your password?'),
    ...emailF.nodes, check.el, err, submit,
    h('div', { class: 'row-center links' }, h('button', { type: 'button', class: 'link', onclick: () => show(signInStep, { email: emailIn.value.trim() }) }, 'Back to sign in')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    const em = emailIn.value.trim();
    if (!em) { emailF.error('Enter your email.'); emailIn.focus(); return; }
    const restore = busy(submit, 'Sending code…');
    if (!restore) return;
    try {
      await Account.forgotPassword(server, { email: em, turnstile: await check.token() });
      const pass = h('input', { type: 'password', name: 'new-password', autocomplete: 'new-password' });
      const passF = field('New password', pass, { hint: PASSWORD_HINT }), againF = confirmField(pass, 'Confirm new password');
      show(codeStep, {
        email: em, kind: 'reset', title: 'Check your email', what: 'if this email has an account', button: 'Set new password',
        extra: {
          nodes: [...passF.nodes, ...againF.nodes],
          check: () => {
            if (!pass.value) { passF.error('Choose a new password.'); pass.focus(); return false; }
            return againF.check();
          },
          weak: ex => { passF.error(errorText(ex)); pass.focus(); },
        },
        run: async code => {
          await Account.resetPassword(server, { email: em, code, password: pass.value });
          await Account.signIn(server, { email: em, password: pass.value, deviceName: deviceLabel(), platform: platformId() })
            .then(signedIn)
            .catch(ex => {
              if (ex.body?.error !== 'totp-required') throw ex;
              show(signInStep, { email: em, notice: 'Password changed. Sign in with it now.' });
            });
        },
        back: () => show(forgotStep, { email: em }),
      });
    } catch (ex) {
      if (ex.body?.error === 'bad-email') { emailF.error(errorText(ex)); emailIn.focus(); } else err.textContent = errorText(ex);
    } finally { restore(); }
  });
  return form;
}

/** "Enter the code we emailed": the second step of sign-up and password resets, with a real "Send a new code". */
function codeStep(show, { email, kind, title, what, button, extra, run, back }) {
  const err = formError();
  const code = h('input', { type: 'text', name: 'one-time-code', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxlength: '7', class: 'code-input' });
  const codeF = field('Code', code);
  const submit = h('button', { type: 'submit', class: 'primary wide' }, button);
  const status = h('p', { class: 'muted small', role: 'status' });
  const resend = h('button', { type: 'button', class: 'link' }, 'Send a new code');
  let wait = 0, timer = 0;
  const cooldown = secs => {
    wait = secs;
    clearInterval(timer);
    const tick = () => {
      resend.textContent = wait > 0 ? `Send a new code (${wait} s)` : 'Send a new code';
      resend.setAttribute('aria-disabled', String(wait > 0));
      if (wait-- <= 0) clearInterval(timer);
    };
    tick();
    timer = setInterval(tick, 1000);
  };
  cooldown(30);
  resend.onclick = async () => {
    if (wait > 0) return;
    try {
      await Account.resendCode(server, { email, kind });
      status.textContent = 'We sent a new code. The old one no longer works.';
      cooldown(60);
    } catch (ex) { err.textContent = errorText(ex); }
  };
  const form = h('form', { novalidate: true },
    h('h2', {}, title),
    h('p', { class: 'muted small' }, 'We sent a 6-digit code to ', h('b', {}, email), ` ${what}.`),
    ...codeF.nodes, ...(extra?.nodes || []), err, submit,
    h('div', { class: 'row-center links' }, resend, h('span', { 'aria-hidden': 'true' }, ' · '), h('button', { type: 'button', class: 'link', onclick: () => { clearInterval(timer); back(); } }, 'Change email')),
    status);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    const c = code.value.replace(/\D/g, '');
    if (c.length !== 6) { codeF.error('Enter the 6-digit code from the email.'); code.focus(); return; }
    if (extra && !extra.check()) return;
    const restore = busy(submit, 'Checking…');
    if (!restore) return;
    try { await run(c); clearInterval(timer); } catch (ex) {
      const b = ex.body || {};
      if (b.error === 'bad-code') { codeF.error(errorText(ex)); code.focus(); }
      else if (b.error === 'weak-password' && extra) extra.weak(ex);
      else err.textContent = errorText(ex);
    } finally { restore(); }
  });
  return form;
}

async function signedIn() {
  rebuildSignIn();
  await refreshAccount();
  renderHome();
  const a = Account.loadAccount();
  const n = Account.accountHosts().length;
  // Focus where the next step is: your devices, or (none yet) "Get Headroom Server".
  (n ? $('devices-heading') : $('home-empty').querySelector('.empty-actions a'))?.focus({ preventScroll: true });
  toast(a?.passwordWeak
    ? 'Signed in. Choose a stronger password: open Account at the top.'
    : n ? `Signed in · ${plural(n, '1 device', `${n} devices`)}` : 'Signed in');
}

// ---------------------------------------------------------------------------------------------- the Account page

/**
 * Your account: where you're signed in, your devices, and one row per task (password, two-factor, email,
 * delete) that opens just that task's form, each with its result shown right there.
 */
function accountPage() {
  const a = Account.loadAccount();
  if (!a) return;
  return dialog((dlg, done) => {
    const loadErr = formError();
    const signins = h('ul', { class: 'mini-list', 'aria-label': 'Where you\'re signed in' }, h('li', { class: 'muted small' }, 'Loading…'));
    const devices = h('ul', { class: 'mini-list', 'aria-label': 'Your devices' });
    const tasks = h('div', { class: 'task-list' });
    let totpOn = false;
    let openTask = '';

    const load = async () => {
      try {
        const [list, me] = await Promise.all([Account.listDevices(a), Account.me(a)]);
        totpOn = me.account.totpEnabled;
        const views = list.filter(d => d.kind === 'viewer').sort((x, y) => (y.current - x.current) || ((Date.parse(y.lastSeen) || 0) - (Date.parse(x.lastSeen) || 0)));
        signins.replaceChildren(...views.map(d => h('li', { class: 'li-mini' },
          h('div', { class: 'grow' },
            h('div', {}, d.name, d.current ? h('span', { class: 'tag' }, 'this browser') : null),
            h('div', { class: 'muted small' }, `${d.current ? 'Now' : `Last used ${ago(d.lastSeen)}`}${d.lastAddress ? ` · ${d.lastAddress}` : ''}`)),
          d.current ? null : confirmButton('Sign out', `Sign out ${d.name}?`, async () => {
            await Account.removeDevice(a, d.id);
            toast(`Signed out ${d.name}`);
            load();
          }, `Sign out ${d.name}`))));
        const comps = list.filter(d => d.kind === 'computer').sort((x, y) => x.name.localeCompare(y.name));
        devices.replaceChildren(...(comps.length ? comps.map(d => h('li', { class: 'li-mini' },
          h('div', { class: 'grow' },
            h('div', {}, svg(d.platform === 'macos' ? I.apple : d.platform === 'windows' ? I.windows : I.monitor, 16), ' ', d.name),
            h('div', { class: 'muted small' }, d.online ? 'Online' : `Last seen ${ago(d.lastSeen)}`)),
          confirmButton('Remove', `Remove ${d.name}?`, async () => {
            await Account.removeDevice(a, d.id);
            toast(`Removed ${d.name}. Sign in again in Headroom Server on it to add it back.`);
            load();
            refreshAccount();
          }, `Remove ${d.name}`))) : [h('li', { class: 'muted small' }, 'None yet.')]));
        drawTasks();
      } catch (e) {
        if (e.status === 401) { done(); Account.forget(); renderHome(); return; }
        loadErr.textContent = errorText(e);
      }
    };

    // ---- the task rows
    const panels = {
      password: panelPassword, totp: panelTotp, email: panelEmail, delete: panelDelete,
    };
    function drawTasks() {
      const row = (id, name, value, { danger, attention } = {}) => {
        const panel = h('div', { class: 'task-panel', id: `task-${id}`, hidden: openTask !== id });
        const btn = h('button', {
          type: 'button', class: `task-row${danger ? ' danger' : ''}`, 'aria-expanded': String(openTask === id), 'aria-controls': panel.id,
        }, h('span', { class: 'task-name' }, name), h('span', { class: `task-value${attention ? ' stop-text' : ''}` }, value || ''), svg(CHEVRON, 16));
        btn.onclick = () => {
          openTask = openTask === id ? '' : id;
          drawTasks();
          const opened = tasks.querySelector(`#task-${id}`);
          if (openTask === id) (opened.querySelector('input, button') || opened).focus({ preventScroll: false });
          else tasks.querySelector(`[aria-controls="task-${id}"]`)?.focus();
        };
        if (openTask === id) panel.append(...panels[id]().filter(Boolean));
        return [btn, panel];
      };
      tasks.replaceChildren(
        ...row('password', 'Password', a.passwordWeak ? 'Needs changing' : 'Change', { attention: a.passwordWeak }),
        ...row('totp', 'Two-factor sign-in', totpOn ? 'On' : 'Off'),
        ...row('email', 'Email', a.email),
        ...row('delete', 'Delete account', '', { danger: true }));
    }
    // A task's result stays in its panel when the panels redraw (the lists reload after a change).
    const results = {};
    const taskStatus = id => h('p', { class: 'task-status', role: 'status' }, results[id] || '');

    function panelPassword() {
      const cur = h('input', { type: 'password', name: 'current-password', autocomplete: 'current-password' });
      const nw = h('input', { type: 'password', name: 'new-password', autocomplete: 'new-password' });
      const curF = field('Current password', cur), nwF = field('New password', nw, { hint: PASSWORD_HINT });
      const againF = confirmField(nw, 'Confirm new password');
      const err = formError(), status = taskStatus('password');
      const submit = h('button', { type: 'submit', class: 'primary' }, 'Change password');
      const form = h('form', { novalidate: true },
        a.passwordWeak ? h('p', { class: 'small stop-text' }, 'Your password doesn\'t meet the current rules (not a common or breached password).') : null,
        ...curF.nodes, ...nwF.nodes, ...againF.nodes, err, h('div', { class: 'actions' }, submit), status);
      form.onsubmit = async e => {
        e.preventDefault();
        err.textContent = ''; status.textContent = results.password = '';
        if (!cur.value) { curF.error('Enter your current password.'); cur.focus(); return; }
        if (!nw.value) { nwF.error('Choose a new password.'); nw.focus(); return; }
        if (!againF.check()) return;
        const restore = busy(submit, 'Changing…');
        if (!restore) return;
        try {
          const r = await Account.changePassword(a, cur.value, nw.value);
          cur.value = nw.value = againF.input.value = '';
          Account.updateAccount({ passwordWeak: false });
          a.passwordWeak = false;
          status.textContent = results.password = r.signedOut ? plural(r.signedOut, 'Password changed. Signed out 1 other browser.', `Password changed. Signed out ${r.signedOut} other browsers.`) : 'Password changed.';
          load();
        } catch (ex) {
          const b = ex.body || {};
          if (b.error === 'bad-credentials') { curF.error('That\'s not your current password.'); cur.focus(); }
          else if (b.error === 'weak-password') { nwF.error(errorText(ex)); nw.focus(); }
          else err.textContent = errorText(ex);
        } finally { restore(); }
      };
      return [form];
    }

    function panelTotp() {
      const err = formError(), status = taskStatus();
      if (totpOn) {
        const pw = h('input', { type: 'password', name: 'current-password', autocomplete: 'current-password' });
        const pwF = field('Password', pw);
        const submit = h('button', { type: 'submit' }, 'Turn off two-factor');
        const form = h('form', { novalidate: true },
          ...pwF.nodes, err, h('div', { class: 'actions' }, submit), status);
        form.onsubmit = async e => {
          e.preventDefault();
          err.textContent = '';
          const restore = busy(submit, 'Turning off…');
          if (!restore) return;
          try { await Account.totpDisable(a, pw.value); totpOn = false; toast('Two-factor sign-in is off'); drawTasks(); }
          catch (ex) { if (ex.body?.error === 'bad-credentials') { pwF.error('Wrong password.'); pw.focus(); } else err.textContent = errorText(ex); }
          finally { restore(); }
        };
        return [form];
      }
      const start = h('button', { type: 'button', class: 'primary' }, 'Set up two-factor');
      const box = h('div', {}, h('div', { class: 'actions' }, start), err);
      start.onclick = async () => {
        const restore = busy(start, 'Starting…');
        if (!restore) return;
        try {
          const setup = await Account.totpSetup(a);
          const code = h('input', { type: 'text', name: 'totp', inputmode: 'numeric', maxlength: '6', placeholder: '123456', autocomplete: 'one-time-code' });
          const codeF = field('Code from the app', code);
          const qr = h('div', { class: 'qr-mini', role: 'img', 'aria-label': 'QR code for your authenticator app' });
          qr.innerHTML = qrSvg(setup.uri, { border: 2 });
          const on = h('button', { type: 'submit', class: 'primary' }, 'Turn on');
          const form = h('form', { novalidate: true }, qr,
            h('p', { class: 'small' }, 'Key: ', h('span', { class: 'mono' }, setup.secret)),
            ...codeF.nodes, err, h('div', { class: 'actions' }, on), status);
          form.onsubmit = async e => {
            e.preventDefault();
            err.textContent = '';
            const r2 = busy(on, 'Checking…');
            if (!r2) return;
            try { await Account.totpEnable(a, code.value.trim()); totpOn = true; toast('Two-factor sign-in is on'); drawTasks(); }
            catch (ex) { codeF.error(errorText(ex)); code.focus(); }
            finally { r2(); }
          };
          box.replaceChildren(form);
          code.focus();
        } catch (ex) { err.textContent = errorText(ex); restore(); }
      };
      return [box];
    }

    function panelEmail() {
      const nwE = h('input', { type: 'email', name: 'email', autocomplete: 'email', autocapitalize: 'off', spellcheck: 'false' });
      const pw = h('input', { type: 'password', name: 'current-password', autocomplete: 'current-password' });
      const nwF = field('New email', nwE), pwF = field('Password', pw);
      const err = formError(), status = taskStatus();
      const submit = h('button', { type: 'submit', class: 'primary' }, 'Send code');
      const box = h('div');
      const form = h('form', { novalidate: true }, h('p', { class: 'small' }, `Now: ${a.email}. We'll email a code to the new address.`),
        ...nwF.nodes, ...pwF.nodes, err, h('div', { class: 'actions' }, submit), status);
      form.onsubmit = async e => {
        e.preventDefault();
        err.textContent = '';
        const em = nwE.value.trim();
        if (!em) { nwF.error('Enter the new email.'); nwE.focus(); return; }
        const restore = busy(submit, 'Sending code…');
        if (!restore) return;
        try {
          await Account.changeEmail(a, pw.value, em);
          const code = h('input', { type: 'text', name: 'one-time-code', inputmode: 'numeric', maxlength: '7', placeholder: '123456', autocomplete: 'one-time-code', class: 'code-input' });
          const codeF = field('Code', code);
          const confirm = h('button', { type: 'submit', class: 'primary' }, 'Confirm new email');
          const form2 = h('form', { novalidate: true }, h('p', { class: 'small' }, 'Enter the code we sent to ', h('b', {}, em), '.'),
            ...codeF.nodes, err, h('div', { class: 'actions' }, confirm), status);
          form2.onsubmit = async ev => {
            ev.preventDefault();
            err.textContent = '';
            const r2 = busy(confirm, 'Checking…');
            if (!r2) return;
            try {
              const r = await Account.confirmEmail(a, code.value.replace(/\D/g, ''));
              Account.updateAccount({ email: r.email });
              a.email = r.email;
              pref('headroom.lastEmail', r.email);
              toast(`Your email is now ${r.email}`);
              renderHome();
              dlg.querySelector('.acct-email').textContent = r.email;
              drawTasks();
            } catch (ex) { codeF.error(errorText(ex)); code.focus(); }
            finally { r2(); }
          };
          box.replaceChildren(form2);
          code.focus();
        } catch (ex) {
          const b = ex.body || {};
          if (b.error === 'bad-credentials') { pwF.error('Wrong password.'); pw.focus(); }
          else if (b.error === 'bad-email' || b.error === 'exists') { nwF.error(errorText(ex)); nwE.focus(); }
          else err.textContent = errorText(ex);
        } finally { restore(); }
      };
      box.append(form);
      return [box];
    }

    function panelDelete() {
      const pw = h('input', { type: 'password', name: 'current-password', autocomplete: 'current-password' });
      const pwF = field('Password', pw);
      const err = formError();
      const needPassword = () => {
        if (pw.value) return true;
        pwF.error('Enter your password to delete the account.');
        pw.focus();
        return false;
      };
      const go = confirmButton('Delete account', 'Delete for good?', async () => {
        try {
          await Account.deleteAccount(a, pw.value);
          Account.forget();
          pref('headroom.lastEmail', '');
          signedOutNotice = 'Your account was deleted. Headroom Server on your computers was signed out.';
          done();
          rebuildSignIn();
          renderHome();
          $('signin-slot').querySelector('h2')?.setAttribute('tabindex', '-1');
          $('signin-slot').querySelector('h2')?.focus();
        } catch (ex) {
          if (ex.body?.error === 'bad-credentials') { pwF.error('Wrong password.'); pw.focus(); } else err.textContent = errorText(ex);
        }
      }, 'Delete account', { primaryDanger: true, check: needPassword });
      // A form, so Enter in the password field presses the button (once to arm it, again to delete).
      const form = h('form', { novalidate: true },
        h('p', { class: 'small' }, 'Deletes your account and its list of devices for good. Headroom Server on your computers is signed out; codes keep working on them.'),
        ...pwF.nodes, err, h('div', { class: 'actions' }, go));
      form.onsubmit = e => { e.preventDefault(); go.click(); };
      return [form];
    }

    dlg.append(h('div', { class: 'body acct' },
      h('h2', {}, 'Account'),
      h('p', { class: 'small' }, 'Signed in as ', h('b', { class: 'acct-email' }, a.email)),
      loadErr,
      h('h3', { class: 'sub-h' }, 'Where you\'re signed in'), signins,
      h('h3', { class: 'sub-h' }, 'Your devices'),
      devices,
      h('h3', { class: 'sub-h' }, 'Settings'), tasks,
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: async () => { done(); await Account.signOut(); signedOutNotice = 'Signed out.'; rebuildSignIn(); renderHome(); $('signin-slot').querySelector('input')?.focus(); } }, 'Sign out'))));
    if (a.passwordWeak) openTask = 'password';
    drawTasks();
    load();
  });
}

/**
 * A button that asks "are you sure?" in place: the first press arms it (and says so), the second (within 5 s)
 * runs it. `name` is its full accessible name when the visible label is shared by several buttons.
 */
function confirmButton(label, question, run, name, { primaryDanger = false, check } = {}) {
  let armed = 0;
  const b = h('button', { type: 'button', class: primaryDanger ? 'danger-fill' : 'small-btn danger', 'aria-label': name || null }, label);
  b.onclick = async () => {
    if (b.getAttribute('aria-disabled') === 'true') return;
    if (!armed) {
      if (check && !check()) return; // something's missing: say what, don't ask "are you sure?"
      b.textContent = question;
      if (name) b.setAttribute('aria-label', `${question} Press again to confirm.`);
      announce(`${question} Press again to confirm.`);
      armed = setTimeout(() => {
        armed = 0;
        b.textContent = label;
        if (name) b.setAttribute('aria-label', name);
        if (document.activeElement === b) announce('Not confirmed, so nothing changed.');
      }, 5000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    const restore = busy(b, 'Working…');
    try { await run(); } catch (e) { toast(errorText(e)); } finally {
      restore?.();
      if (b.isConnected) { b.textContent = label; if (name) b.setAttribute('aria-label', name); }
    }
  };
  return b;
}

// Sign-up and password resets from Headroom Viewer open here: https://<server>/#signup or #forgot.
const startHash = location.hash;
main().then(() => {
  if (Account.loadAccount()) return;
  const card = $('signin-slot').firstChild;
  if (!card) return;
  if (startHash === '#signup') card.querySelector('.links button')?.click();
  if (startHash === '#forgot') card.querySelectorAll('.links button')[1]?.click();
});
