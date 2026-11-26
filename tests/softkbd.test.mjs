// The phone keyboard's state against what the page can see. These replay the event sequences recorded from iOS 26
// Safari, the Home Screen app and a bare WKWebView (focus/blur/visibility/visualViewport) through the real
// SoftKeyboard; they prove the state logic, not what a real keyboard does (that was checked on the iOS Simulator).
import assert from 'node:assert/strict';
import test from 'node:test';

const ZWSP = '​', WJ = '⁠';
const EMPTY = ZWSP.repeat(12) + WJ.repeat(12);

class Viewport extends EventTarget {
  constructor() { super(); this.width = 402; this.height = 714; this.offsetTop = 0; }
}

function page() {
  const vv = new Viewport();
  globalThis.window = { innerHeight: 714, visualViewport: vv };
  globalThis.document = { activeElement: null, visibilityState: 'visible' };
  const body = { id: 'body' };
  document.activeElement = body;
  const calls = [];
  const sink = new EventTarget();
  sink.value = '';
  sink.setSelectionRange = () => {};
  // Like a browser: focusing the focused element, or blurring one that isn't, fires nothing.
  sink.focus = () => { calls.push('focus'); if (document.activeElement === sink) return; document.activeElement = sink; sink.dispatchEvent(new Event('focus')); };
  sink.blur = () => { calls.push('blur'); if (document.activeElement !== sink) return; document.activeElement = body; sink.dispatchEvent(new Event('blur')); };
  return { vv, sink, body, calls };
}

async function keyboardFor(t, { allowed = () => true } = {}) {
  const p = page();
  const { SoftKeyboard } = await import('../web/js/input/softkbd.js');
  const sent = [], keys = [], echoed = [];
  const life = new AbortController();
  t.after(() => life.abort());
  const sk = new SoftKeyboard({
    sink: p.sink, signal: life.signal, touch: true, inputAllowed: allowed,
    conn: { sendJson: m => sent.push(m) },
    keyboard: { tap: code => keys.push(code), chord: c => keys.push(c.join('+')), ctx: {} },
    echo: { text: s => echoed.push(s), back: n => echoed.push(-n) },
  });
  const changes = [];
  sk.addEventListener('change', () => changes.push(sk.open));
  // The page's own wiring (session.js): every change of the visible area goes through viewportChanged first.
  const resize = (height) => { p.vv.height = height; sk.viewportChanged?.(); };
  const type = (text) => {
    p.sink.value = ZWSP.repeat(12) + text + WJ.repeat(12);
    p.sink.dispatchEvent(Object.assign(new Event('input'), { inputType: 'insertText', isComposing: false }));
  };
  return { ...p, sk, sent, keys, echoed, changes, resize, type };
}

/** The user taps Keyboard and the keyboard comes up (iOS: the visible area goes from 714 to 404 px). */
function openByTap(k) {
  k.sk.toggle();
  k.resize(404);
}

/** The app goes to the background: iOS blurs the field, then hides the page (seen in every recorded sequence). */
function leave(k) {
  k.sink.dispatchEvent(new Event('blur'));
  document.visibilityState = 'hidden';
  k.sk.suspend?.();
}

/** The app comes back: the visible area is whole again and iOS gives the field its focus back (twice). */
function returnWithFocus(k) {
  document.visibilityState = 'visible';
  k.vv.height = 714;
  k.sink.dispatchEvent(new Event('focus'));
  k.sink.dispatchEvent(new Event('focus'));
  k.sk.viewportChanged?.();
}

test('a field that gets its focus back without a keyboard is not typing, and one tap on Keyboard brings one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const k = await keyboardFor(t);
  openByTap(k);
  k.type('before');
  assert.equal(k.sk.open, true);
  leave(k);
  assert.equal(k.sk.open, false);
  returnWithFocus(k); // the platform restores the focus, not the keyboard
  t.mock.timers.tick(2000);
  assert.equal(k.sk.open, false, 'the dock and the toolbar show "not typing" while no keyboard is up');
  assert.equal(document.activeElement, k.sink, 'the field kept its focus (the state the report describes)');
  // One tap on Keyboard: not a hide of a keyboard that's already gone, but a fresh focus inside the tap.
  k.calls.length = 0;
  k.sk.toggle();
  assert.deepEqual(k.calls, ['blur', 'focus']);
  assert.equal(k.sk.open, true);
  assert.deepEqual(k.changes.slice(-1), [true]);
  k.resize(404);
  k.type('after');
  assert.deepEqual(k.sent.map(m => m.s), ['before', 'after'], 'each word reached the computer once');
});

test('a visible area scrolled past the page (iOS Home Screen app, as a session opens) is not a keyboard', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const k = await keyboardFor(t);
  window.innerHeight = 874;
  // Recorded in the Home Screen app: as the session screen took over a scrolled page, one scroll event reported the
  // visual viewport 111 px down at full height (874 + 111 > the page's 874).
  k.vv.height = 874; k.vv.offsetTop = 111; k.sk.viewportChanged?.();
  k.vv.offsetTop = 0; k.sk.viewportChanged?.();
  openByTap(k);
  k.resize(498);
  leave(k);
  document.visibilityState = 'visible';
  k.vv.height = 874;
  k.sink.dispatchEvent(new Event('focus'));
  k.sk.viewportChanged?.();
  assert.equal(k.sk.open, false, 'no keyboard is up yet');
  k.resize(498);
  assert.equal(k.sk.open, true);
});

test('a keyboard the platform brings back brings typing back with it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const k = await keyboardFor(t);
  openByTap(k);
  leave(k);
  returnWithFocus(k);
  assert.equal(k.sk.open, false, 'not before the keyboard is there');
  k.resize(404); // ~200 ms later on iOS 26: the keyboard is back
  assert.equal(k.sk.open, true);
  t.mock.timers.tick(2000);
  assert.equal(k.sk.open, true, 'it stays: the keyboard is up');
  k.type('a');
  assert.deepEqual(k.sent.map(m => m.s), ['a']);
  assert.deepEqual(k.changes, [true, false, true]);
});

test('a keyboard closed before leaving stays closed on return', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const k = await keyboardFor(t);
  openByTap(k);
  k.sk.toggle(); // Hide keyboard
  k.resize(714);
  assert.equal(k.sk.open, false);
  assert.equal(document.activeElement, k.body);
  document.visibilityState = 'hidden';
  k.sk.suspend?.();
  document.visibilityState = 'visible';
  k.sk.viewportChanged?.(); // no focus comes back: nothing had it
  t.mock.timers.tick(2000);
  assert.equal(k.sk.open, false);
  assert.ok(!k.changes.slice(1).includes(true), 'nothing reopened it');
});

test('a keyboard that goes away while the field keeps its focus ends typing; the next tap opens one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const k = await keyboardFor(t);
  openByTap(k);
  k.resize(712); // Android's Back, a hardware keyboard: no blur, just no keyboard (712: the form bar alone)
  assert.equal(k.sk.open, true, 'not at once: it may be turning or changing layouts');
  t.mock.timers.tick(699);
  assert.equal(k.sk.open, true);
  t.mock.timers.tick(1);
  assert.equal(k.sk.open, false);
  k.calls.length = 0;
  k.sk.toggle();
  assert.deepEqual(k.calls, ['blur', 'focus'], 'a fresh focus, so the phone shows its keyboard');
  assert.equal(k.sk.open, true);
});

test('a keyboard that only resizes (emoji, rotation) keeps typing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const k = await keyboardFor(t);
  openByTap(k);
  k.resize(714);   // turning: gone for a moment...
  t.mock.timers.tick(150);
  k.resize(380);   // ...and back, taller
  t.mock.timers.tick(2000);
  assert.equal(k.sk.open, true);
  assert.deepEqual(k.changes, [true]);
});

test('turning the phone (several sizes without a keyboard, even a negative one) keeps typing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const k = await keyboardFor(t);
  openByTap(k);
  // Recorded in Safari turning to landscape with the keyboard up: no keyboard for a while, then a height of -8 px.
  for (const h of [714, 402, 380, 402]) { k.resize(h); t.mock.timers.tick(500); }
  k.resize(-8);
  t.mock.timers.tick(2000);
  assert.equal(k.sk.open, true);
  assert.deepEqual(k.changes, [true], 'never closed on the way');
});

test('with a hardware keyboard (no on-screen keyboard ever shows) typing stays open until it is closed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const k = await keyboardFor(t);
  k.sk.toggle();
  k.resize(658); // the form bar only
  t.mock.timers.tick(2000);
  assert.equal(k.sk.open, true);
  k.sk.toggle();
  assert.equal(k.sk.open, false);
  assert.equal(document.activeElement, k.body);
});

test('the first character after coming back goes once, as text, also before the keyboard is seen', async t => {
  const k = await keyboardFor(t);
  openByTap(k);
  leave(k);
  returnWithFocus(k);
  // Typed in the ~200 ms before the visible area says the keyboard is back: its keydown belongs to the text path,
  // so the key path (keyboard.js) leaves it alone and nothing goes twice.
  assert.equal(k.sk.handles({ key: 'x' }), true);
  k.type('x');
  assert.deepEqual(k.sent.map(m => m.s), ['x']);
  assert.deepEqual(k.keys, []);
  assert.equal(k.sink.value, EMPTY, 'nothing left over for the next keystroke');
});

test('nothing typed while the computer takes no input is sent or shown as sent', async t => {
  let allowed = false;
  const k = await keyboardFor(t, { allowed: () => allowed });
  openByTap(k);
  k.type('lost');
  k.sink.value = ZWSP.repeat(11) + WJ.repeat(12); // a Backspace
  k.sink.dispatchEvent(Object.assign(new Event('input'), { inputType: 'deleteContentBackward', isComposing: false }));
  assert.deepEqual(k.sent, []);
  assert.deepEqual(k.keys, []);
  assert.deepEqual(k.echoed, []);
  assert.equal(k.sink.value, EMPTY);
  allowed = true;
  k.type('ok');
  assert.deepEqual(k.sent.map(m => m.s), ['ok']);
  assert.deepEqual(k.echoed, ['ok']);
});

test('a word composed when the app leaves goes at most once, and nothing stale follows', async t => {
  const k = await keyboardFor(t);
  openByTap(k);
  k.sink.dispatchEvent(new Event('compositionstart'));
  k.sink.value = ZWSP.repeat(12) + 'にほ' + WJ.repeat(12);
  k.sink.dispatchEvent(Object.assign(new Event('input'), { inputType: 'insertCompositionText', isComposing: true }));
  assert.deepEqual(k.sent, [], 'a draft is not sent');
  leave(k);
  // iOS commits the draft as the field loses its focus.
  k.sink.value = ZWSP.repeat(12) + 'にほ' + WJ.repeat(12);
  k.sink.dispatchEvent(new Event('compositionend'));
  returnWithFocus(k);
  k.resize(404);
  k.type('ん');
  assert.deepEqual(k.sent.map(m => m.s), ['にほ', 'ん']);
});
