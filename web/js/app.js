// Headroom web client — entry point. Signed out: "Got a code?" and sign in / create account. Signed in: your
// devices (every device that has signed in with Headroom Server) and your Account page. Then sessions.
import { Session } from './session.js';
import { h, svg, dialog, toast } from './ui/dom.js';
import { I } from './ui/icons.js';
import { qrSvg } from './qr.js';
import { deviceLabel, platformId, secure, hasWebCodecs, isStandalone, isIOS, isMac, nativeViewer, postNative } from './platform.js';
import * as Account from './account.js';
import { DEFAULT_ACCOUNT_SERVER } from './config.js';

const $ = id => document.getElementById(id);
let session = null;
let server = DEFAULT_ACCOUNT_SERVER; // the Headroom service: this page's own origin when it serves the app
let info = null;                     // its /api/info (sign-up open, Turnstile site key)

async function main() {
  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(e => console.warn('[sw]', e));
  }
  Account.forgetOldData();
  $('btn-code').addEventListener('click', () => codeFlow());
  // Never create history entries: iOS standalone edge-swipe "back" would leave the app.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname);

  const own = !nativeViewer && await Account.serverInfo(location.origin);
  if (own) { server = location.origin; info = own; }
  renderHome();
  if (!info) Account.serverInfo(server).then(i => { info = i; if (!Account.loadAccount()) renderHome(); });

  const refreshed = refreshAccount();
  // Keep the devices (online state) fresh while the home screen is showing.
  const idleRefresh = () => { if (!session && document.visibilityState === 'visible') refreshAccount(); };
  setInterval(idleRefresh, 20000);
  document.addEventListener('visibilitychange', idleRefresh);

  // A guest link: https://<server>/#code=123456789
  if (hash.get('code')) { codeFlow(hash.get('code')); return; }
  // Headroom Viewer's "Open in new window": #connect=<device id>
  if (hash.get('connect')) {
    await refreshed;
    const host = Account.accountHosts().find(x => x.id === hash.get('connect'));
    if (host) connect(host);
  }
}

async function refreshAccount() {
  if (!Account.loadAccount()) return;
  const before = snapshot();
  const a = await Account.refreshComputers();
  if (!a) {
    toast('You were signed out (from another device, or your password changed).', 6000);
    if (!session) renderHome();
    return;
  }
  if (!session && snapshot() !== before) renderHome();
}
const snapshot = () => JSON.stringify([Account.loadAccount()?.error, Account.accountHosts().map(x => [x.id, x.name, x.online, x.relayOnline, x.lastSeen])]);

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
    chip.replaceChildren(svg(I.user, 16), h('span', {}, acct.email), ...(acct.error ? [h('span', { class: 'warn-text' }, '· offline')] : []));
    chip.title = 'Your account';
    chip.onclick = () => accountPage();
    $('signin-slot').replaceChildren();
    renderDevices(acct);
  } else {
    // Kept across re-renders so typing isn't lost.
    if (!$('code-slot').firstChild) $('code-slot').append(codeForm({ inline: true }));
    if (!$('signin-slot').firstChild) $('signin-slot').append(authCard());
  }
  const hint = [];
  if (!secure) hint.push('Not a secure connection: video needs HTTPS.');
  else if (!hasWebCodecs) hint.push('This browser lacks WebCodecs (needs Safari 16.4+, Chrome/Edge 94+, Firefox 130+).');
  if (acct && isIOS && !isStandalone) hint.push('Tip: Share → Add to Home Screen for a full-screen app (sign in again inside it).');
  if (acct && nativeViewer) hint.push(isMac
    ? 'Tip: ⌘Tab, ⌘Space and other system shortcuts go to the remote computer while its window is focused.'
    : 'Tip: Win, Alt+Tab and PrtScn go to the remote computer while its window is focused. Ctrl+Alt+End sends Ctrl+Alt+Del.');
  $('home-hint').textContent = hint.join(' ');
}

function renderDevices(acct) {
  const hosts = Account.accountHosts(acct).sort((a, b) =>
    (b.online - a.online) || (b.lastConnected - a.lastConnected) || a.name.localeCompare(b.name));
  $('host-list').replaceChildren(...hosts.map(hostCard));
  $('home-empty').hidden = hosts.length > 0;
}

const ago = d => {
  if (!d) return 'never';
  const sec = (Date.now() - new Date(d)) / 1000;
  return sec < 90 ? 'just now' : sec < 3600 ? `${Math.round(sec / 60)} min ago` : sec < 86400 ? `${Math.round(sec / 3600)} h ago` : new Date(d).toLocaleDateString();
};

function hostCard(host) {
  const card = h('div', { class: `host${host.online ? '' : ' offline'}`, role: 'button', tabindex: '0', 'aria-label': `Connect to ${host.name}` },
    h('div', { class: 'os' }, svg(host.os === 'macos' ? I.apple : I.windows, 24)),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'name' }, host.name, host.viewOnly ? h('span', { class: 'tag' }, 'view only') : null),
      h('div', { class: 'addr' }, h('span', { class: `dot ${host.online ? 'online' : 'offline'}` }), host.online ? 'Online' : `Offline · last seen ${ago(host.lastSeen)}`)),
    nativeViewer && host.online ? h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Open in new window', title: 'Open in new window',
      onclick: e => { e.stopPropagation(); postNative({ cmd: 'newWindow', url: `${location.origin}/index.html#connect=${encodeURIComponent(host.id)}` }); },
    }, svg('<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>')) : null);
  const go = () => connect(host);
  card.addEventListener('click', go);
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  return card;
}

function connect(host) {
  if (session) return;
  if (!host.online && !host.support) { toast(`${host.name} is offline. Start Headroom Server on it, then try again.`, 6000); return; }
  const s = session = new Session(host, {
    onExit: () => { session = null; renderHome(); refreshAccount(); },
    onUnauthorized: () => refreshAccount(),
  });
  globalThis.__headroomSession = s; // handy for debugging from the console
  s.unlockFromGesture(); // audio must be unlocked inside this tap (iOS): before any await
  (async () => {
    if (host.account) {
      const url = await Account.reachableUrl(host);
      if (session !== s) return;
      if (!url) {
        s.stop();
        toast(`Can't reach ${host.name} right now. It may have just gone offline; try again in a moment.`, 7000);
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

// ---------------------------------------------------------------------------------------------- guest codes

const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k) || ''; localStorage.setItem(k, v); } catch { } return ''; };

/**
 * "Got a code?": someone at another computer clicked "Let someone connect" and gave you a 9-digit code (or a
 * link with it). No account needed; they accept you on their screen.
 */
function codeForm({ inline = false, code = '', onDone, onCancel } = {}) {
  const err = h('div', { class: 'error', role: 'alert' });
  const codeIn = h('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '123 456 789', class: 'code-input',
    value: Account.prettyCode(code), 'aria-label': 'Code',
  });
  codeIn.addEventListener('input', () => { codeIn.value = Account.prettyCode(codeIn.value); });
  const nameIn = h('input', { type: 'text', value: pref('headroom.guestName'), placeholder: 'So they know who you are', autocomplete: 'name', maxlength: '40', 'aria-label': 'Your name' });
  const nameWrap = h('div', { hidden: inline && !code }, h('label', { class: 'field' }, 'Your name'), nameIn);
  codeIn.addEventListener('focus', () => { nameWrap.hidden = false; });
  const submit = h('button', { type: 'submit', class: inline ? 'primary wide' : 'primary' }, 'Connect');
  const form = h('form', { class: inline ? 'signin-card' : null },
    h('h2', {}, 'Got a code?'),
    h('p', { class: 'muted small' }, 'Enter the code from the person at the other computer. They\'ll be asked to accept.'),
    codeIn, nameWrap, err,
    inline ? submit : h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => onCancel?.() }, 'Cancel'), submit));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    const c = codeIn.value.replace(/\D/g, '');
    if (c.length !== 9) { err.textContent = 'The code has 9 digits.'; codeIn.focus(); return; }
    const name = nameIn.value.trim();
    if (!name && nameWrap.hidden) { nameWrap.hidden = false; nameIn.focus(); return; }
    submit.disabled = true;
    try {
      const { url, info: hi } = await Account.lookUpCode(server, c);
      if (name) pref('headroom.guestName', name);
      onDone?.();
      codeIn.value = '';
      // A one-off: nothing is saved. Once accepted, the session continues with a key only it holds.
      connect({
        id: `guest:${c.slice(0, 4)}`, name: hi.host?.name || 'Remote computer', os: hi.host?.os, url, online: true,
        support: { code: c, name: name || deviceLabel() },
      });
    } catch (ex) {
      err.textContent = ex.message;
    } finally { submit.disabled = false; }
  });
  form.focusFirst = () => (code ? (nameIn.value ? submit : nameIn) : codeIn).focus();
  return form;
}

function codeFlow(code = '') {
  return dialog((dlg, done) => {
    const form = codeForm({ code, onDone: () => done(true), onCancel: () => done() });
    dlg.append(form);
    setTimeout(() => form.focusFirst(), 50);
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
      if (!token) throw new Error('Please complete the check above the button.');
      const t = token;
      token = '';
      try { window.turnstile.reset(id); } catch { }
      return t;
    },
  };
}

const passwordHint = () => h('p', { class: 'muted small' }, 'At least 12 characters. A few random words make a strong, easy one; spaces are fine.');
const errorText = ex => {
  const b = ex.body || {};
  if (b.error === 'rate-limited') return `Too many attempts. Try again in ${b.retryAfter || 60} s.`;
  return b.message || ex.message;
};

/**
 * The signed-out card: sign in, create an account (email, password, then the emailed code), or reset a
 * forgotten password (emailed code). One card that changes step.
 */
function authCard() {
  const card = h('div', { class: 'signin-card' });
  const show = (step, opts = {}) => { card.replaceChildren(step(show, opts)); card.querySelector('input:not([hidden])')?.focus({ preventScroll: true }); };
  show(signInStep);
  return card;
}

function signInStep(show, { email = pref('headroom.lastEmail') } = {}) {
  const err = h('div', { class: 'error', role: 'alert' });
  const emailIn = h('input', { type: 'email', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', value: email, 'aria-label': 'Email' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const totp = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxlength: '6', 'aria-label': 'Authenticator code' });
  const totpWrap = h('div', { hidden: true }, h('label', { class: 'field' }, 'Code from your authenticator app'), totp);
  const submit = h('button', { type: 'submit', class: 'primary wide' }, 'Sign in');
  // Headroom Viewer can't show the human check: sign-up and password resets happen on the website.
  const web = path => () => window.open(`${server}/${path}`, '_blank', 'noopener');
  const form = h('form', {},
    h('h2', {}, 'Sign in'),
    h('p', { class: 'muted small' }, 'See and connect to your devices.'),
    h('label', { class: 'field' }, 'Email'), emailIn,
    h('label', { class: 'field' }, 'Password'), pass, totpWrap, err, submit,
    h('div', { class: 'row-center links' },
      h('button', { type: 'button', class: 'link', hidden: info && !info.signup, onclick: nativeViewer && info?.turnstile ? web('#signup') : () => show(signUpStep, { email: emailIn.value.trim() }) }, 'Create account'),
      h('span', { 'aria-hidden': 'true' }, ' · '),
      h('button', { type: 'button', class: 'link', onclick: nativeViewer && info?.turnstile ? web('#forgot') : () => show(forgotStep, { email: emailIn.value.trim() }) }, 'Forgot password?')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      await Account.signIn(server, { email: emailIn.value.trim(), password: pass.value, totp: totp.value.trim() || undefined, deviceName: deviceLabel(), platform: platformId() });
      await signedIn();
    } catch (ex) {
      const b = ex.body || {};
      if (b.error === 'totp-required') { totpWrap.hidden = false; totp.focus(); err.textContent = 'Two-factor sign-in is on: enter the 6-digit code from your authenticator app.'; }
      else if (b.error === 'bad-totp') err.textContent = 'That code didn\'t work. Wait for the next one and try again.';
      else err.textContent = errorText(ex);
    } finally { submit.disabled = false; }
  });
  return form;
}

function signUpStep(show, { email = '' } = {}) {
  const err = h('div', { class: 'error', role: 'alert' });
  const emailIn = h('input', { type: 'email', autocomplete: 'email', autocapitalize: 'off', spellcheck: 'false', value: email, 'aria-label': 'Email' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Password' });
  const check = humanCheck();
  const submit = h('button', { type: 'submit', class: 'primary wide' }, 'Create account');
  const form = h('form', {},
    h('h2', {}, 'Create your account'),
    h('p', { class: 'muted small' }, 'Free. Then sign in with this email in Headroom Server on each of your computers.'),
    h('label', { class: 'field' }, 'Email'), emailIn,
    h('label', { class: 'field' }, 'Password'), pass, passwordHint(), check.el, err, submit,
    h('div', { class: 'row-center links' }, h('button', { type: 'button', class: 'link', onclick: () => show(signInStep, { email: emailIn.value.trim() }) }, 'I have an account')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      const em = emailIn.value.trim();
      await Account.signUp(server, { email: em, password: pass.value, turnstile: await check.token() });
      show(codeStep, {
        email: em, title: 'Check your email', what: 'to finish creating your account', button: 'Create account',
        run: code => Account.confirmSignUp(server, { email: em, code, password: pass.value, deviceName: deviceLabel(), platform: platformId() }).then(signedIn),
        back: () => show(signUpStep, { email: em }),
      });
    } catch (ex) {
      err.textContent = errorText(ex);
    } finally { submit.disabled = false; }
  });
  return form;
}

function forgotStep(show, { email = '' } = {}) {
  const err = h('div', { class: 'error', role: 'alert' });
  const emailIn = h('input', { type: 'email', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', value: email, 'aria-label': 'Email' });
  const check = humanCheck();
  const submit = h('button', { type: 'submit', class: 'primary wide' }, 'Email me a code');
  const form = h('form', {},
    h('h2', {}, 'Forgot your password?'),
    h('p', { class: 'muted small' }, 'We\'ll email you a code to choose a new one.'),
    h('label', { class: 'field' }, 'Email'), emailIn, check.el, err, submit,
    h('div', { class: 'row-center links' }, h('button', { type: 'button', class: 'link', onclick: () => show(signInStep, { email: emailIn.value.trim() }) }, 'Back to sign in')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      const em = emailIn.value.trim();
      await Account.forgotPassword(server, { email: em, turnstile: await check.token() });
      const pass = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
      show(codeStep, {
        email: em, title: 'Check your email', what: 'if this email has an account', button: 'Set new password',
        extra: [h('label', { class: 'field' }, 'New password'), pass, passwordHint()],
        run: async code => {
          await Account.resetPassword(server, { email: em, code, password: pass.value });
          await Account.signIn(server, { email: em, password: pass.value, deviceName: deviceLabel(), platform: platformId() })
            .then(signedIn)
            .catch(ex => { if (ex.body?.error === 'totp-required') { show(signInStep, { email: em }); toast('Password changed. Sign in with it now.', 6000); } else throw ex; });
        },
        back: () => show(forgotStep, { email: em }),
      });
    } catch (ex) {
      err.textContent = errorText(ex);
    } finally { submit.disabled = false; }
  });
  return form;
}

/** "Enter the code we emailed": the second step of sign-up and password resets. */
function codeStep(show, { email, title, what, button, extra = [], run, back }) {
  const err = h('div', { class: 'error', role: 'alert' });
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxlength: '7', class: 'code-input', 'aria-label': 'Code' });
  const submit = h('button', { type: 'submit', class: 'primary wide' }, button);
  const form = h('form', {},
    h('h2', {}, title),
    h('p', { class: 'muted small' }, 'We sent a 6-digit code to ', h('b', {}, email), ` ${what}. It works for 15 minutes; check spam if it doesn't arrive.`),
    h('label', { class: 'field' }, 'Code'), code, ...extra, err, submit,
    h('div', { class: 'row-center links' }, h('button', { type: 'button', class: 'link', onclick: back }, 'Send a new code')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try { await run(code.value.replace(/\D/g, '')); } catch (ex) { err.textContent = errorText(ex); } finally { submit.disabled = false; }
  });
  return form;
}

async function signedIn() {
  $('signin-slot').replaceChildren();
  await refreshAccount();
  renderHome();
  const a = Account.loadAccount();
  const n = Account.accountHosts().length;
  toast(a?.passwordWeak
    ? 'Signed in. Please choose a stronger password (tap your email at the top).'
    : n ? `Signed in · ${n} device${n === 1 ? '' : 's'}` : 'Signed in. Now sign in with this email in Headroom Server on each of your computers.', 7000);
}

// ---------------------------------------------------------------------------------------------- the Account page

/** Your account: email, password, two-factor, where you're signed in, your devices, delete, sign out. */
function accountPage() {
  const a = Account.loadAccount();
  if (!a) return;
  return dialog((dlg, done) => {
    const msg = h('div', { class: 'error', role: 'alert' });
    const fail = e => { msg.textContent = e.body?.error === 'bad-credentials' ? 'Wrong password.' : errorText(e); };
    const ok = text => { msg.textContent = ''; toast(text, 5000); };
    const signins = h('div', { class: 'list-mini' }, h('p', { class: 'muted small' }, 'Loading…'));
    const devices = h('div', { class: 'list-mini' });
    const totpBox = h('div');
    const emailLine = h('b', {}, a.email);

    const load = async () => {
      try {
        const [list, info2] = await Promise.all([Account.listDevices(a), Account.me(a)]);
        const views = list.filter(d => d.kind === 'viewer').sort((x, y) => (y.current - x.current) || ((Date.parse(y.lastSeen) || 0) - (Date.parse(x.lastSeen) || 0)));
        signins.replaceChildren(...views.map(d => h('div', { class: 'li-mini' },
          h('div', { class: 'grow' },
            h('div', {}, d.name, d.current ? h('span', { class: 'tag' }, 'this one') : null),
            h('div', { class: 'muted small' }, `${d.current ? 'now' : `last used ${ago(d.lastSeen)}`}${d.lastAddress ? ` · ${d.lastAddress}` : ''}`)),
          d.current ? null : confirmButton('Sign out', 'Sign it out?', async () => {
            try { await Account.removeDevice(a, d.id); load(); } catch (e) { fail(e); }
          }))));
        const comps = list.filter(d => d.kind === 'computer').sort((x, y) => x.name.localeCompare(y.name));
        devices.replaceChildren(...(comps.length ? comps.map(d => h('div', { class: 'li-mini' },
          h('div', { class: 'grow' },
            h('div', {}, svg(I.monitor, 16), ' ', d.name),
            h('div', { class: 'muted small' }, d.online ? 'online' : `last seen ${ago(d.lastSeen)}`)),
          confirmButton('Remove', 'Remove it?', async () => {
            try { await Account.removeDevice(a, d.id); load(); refreshAccount(); } catch (e) { fail(e); }
          }))) : [h('p', { class: 'muted small' }, 'None yet. Sign in with this email in Headroom Server on a computer.')]));
        drawTotp(info2.account.totpEnabled);
      } catch (e) {
        if (e.status === 401) { done(); Account.forget(); renderHome(); return; }
        fail(e);
      }
    };

    const drawTotp = enabled => {
      if (enabled) {
        const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
        totpBox.replaceChildren(h('p', { class: 'small' }, h('b', {}, 'Two-factor sign-in is on.'), ' Signing in asks for a code from your authenticator app.'),
          h('div', { class: 'row-inline' }, pw, h('button', {
            type: 'button', class: 'small-btn', onclick: async () => { try { await Account.totpDisable(a, pw.value); ok('Two-factor sign-in turned off.'); drawTotp(false); } catch (e) { fail(e); } },
          }, 'Turn off')));
        return;
      }
      totpBox.replaceChildren(h('p', { class: 'small muted' }, 'Optional: also ask for a code from an authenticator app when signing in.'),
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
                  type: 'button', class: 'small-btn primary', onclick: async () => { try { await Account.totpEnable(a, code.value.trim()); ok('Two-factor sign-in is on.'); drawTotp(true); } catch (e) { fail(e); } },
                }, 'Turn on')));
              code.focus();
            } catch (e) { fail(e); }
          },
        }, 'Set up two-factor'));
    };

    // Change email: password + new address, then the code sent there.
    const emailBox = h('div');
    const drawEmail = () => {
      const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });
      const nw = h('input', { type: 'email', placeholder: 'New email', autocomplete: 'email', autocapitalize: 'off', 'aria-label': 'New email' });
      emailBox.replaceChildren(h('div', { class: 'row-inline' }, nw, pw, h('button', {
        type: 'button', class: 'small-btn', onclick: async () => {
          try {
            await Account.changeEmail(a, pw.value, nw.value.trim());
            msg.textContent = '';
            const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: '7', placeholder: '123456', autocomplete: 'one-time-code', 'aria-label': 'Code' });
            emailBox.replaceChildren(h('p', { class: 'small' }, 'Enter the code we sent to ', h('b', {}, nw.value.trim()), '.'),
              h('div', { class: 'row-inline' }, code, h('button', {
                type: 'button', class: 'small-btn primary', onclick: async () => {
                  try {
                    const r = await Account.confirmEmail(a, code.value.replace(/\D/g, ''));
                    Account.updateAccount({ email: r.email });
                    a.email = r.email;
                    emailLine.textContent = r.email;
                    ok('Email changed.');
                    drawEmail();
                    renderHome();
                  } catch (e) { fail(e); }
                },
              }, 'Confirm')));
            code.focus();
          } catch (e) { fail(e); }
        },
      }, 'Change email')));
    };
    drawEmail();

    const cur = h('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password', 'aria-label': 'Current password' });
    const nw = h('input', { type: 'password', placeholder: 'New password', autocomplete: 'new-password', 'aria-label': 'New password' });
    const weak = a.passwordWeak ? h('div', { class: 'callout small' }, h('b', {}, 'Please choose a stronger password.'),
      ' Yours doesn\'t meet the current rules (at least 12 characters, not a common or breached password). A few random words work well.') : null;
    const delPw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' });

    dlg.append(h('div', { class: 'body' },
      h('h2', {}, 'Account'),
      h('p', { class: 'small' }, 'Signed in as ', emailLine),
      h('h3', { class: 'sub-h' }, 'Where you\'re signed in'), signins,
      h('h3', { class: 'sub-h' }, 'Your devices'),
      h('p', { class: 'muted small' }, 'Computers signed in with Headroom Server. Rename one in Headroom Server on it.'), devices,
      h('h3', { class: 'sub-h' }, 'Password'), weak,
      h('div', { class: 'row-inline' }, cur, nw, h('button', {
        type: 'button', class: 'small-btn', onclick: async () => {
          try {
            const r = await Account.changePassword(a, cur.value, nw.value);
            cur.value = nw.value = '';
            Account.updateAccount({ passwordWeak: false });
            weak?.remove();
            ok(r.signedOut ? `Password changed. Signed out ${r.signedOut} other browser${r.signedOut === 1 ? '' : 's'}.` : 'Password changed.');
            load();
          } catch (e) { fail(e); }
        },
      }, 'Change password')),
      h('h3', { class: 'sub-h' }, 'Two-factor sign-in'), totpBox,
      h('h3', { class: 'sub-h' }, 'Email'), emailBox,
      h('h3', { class: 'sub-h' }, 'Delete account'),
      h('p', { class: 'muted small' }, 'Deletes your account and its list of devices. Headroom Server on your computers is signed out.'),
      h('div', { class: 'row-inline' }, delPw, confirmButton('Delete account', 'Delete for good?', async () => {
        try { await Account.deleteAccount(a, delPw.value); Account.forget(); done(); renderHome(); toast('Your account was deleted.', 6000); } catch (e) { fail(e); }
      })),
      msg,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'danger', onclick: async () => { done(); await Account.signOut(); renderHome(); toast('Signed out'); } }, 'Sign out'),
        h('button', { type: 'button', class: 'primary', onclick: () => done() }, 'Done'))));
    load();
  });
}

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

// Sign-up and password resets from Headroom Viewer open here: https://<server>/#signup or #forgot.
const startHash = location.hash;
main().then(() => {
  if (Account.loadAccount()) return;
  const card = $('signin-slot').firstChild;
  if (!card) return;
  if (startHash === '#signup') card.querySelector('.links button')?.click();
  if (startHash === '#forgot') card.querySelectorAll('.links button')[1]?.click();
});
