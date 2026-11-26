// The physical keyboard of a PC viewer (Chrome on Windows): what reaches the host.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', maxTouchPoints: 0 },
});
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.window = Object.assign(new EventTarget(), { isSecureContext: true });
globalThis.document = Object.assign(new EventTarget(), { body: {}, activeElement: null });
const { KeyboardInput } = await import('../web/js/input/keyboard.js');
const { StickyModifiers } = await import('../web/js/ui/extrakeys.js');

function fixture(t, hostOs = 'windows') {
  const sent = [], json = [], pushed = [], hotkeys = [], control = { allowed: true };
  const conn = {
    sendBinary(buf) {
      const b = new Uint8Array(buf);
      assert.equal(b[0], 0x14);
      sent.push((b[1] ? '+' : '-') + new TextDecoder().decode(b.slice(3)));
    },
    sendJson(m) { json.push(m); },
  };
  const sink = { focused: 0, focus() { this.focused++; } };
  const kb = new KeyboardInput({ conn, sink, clipboard: { expectRemoteCopy() {}, pushLocal: s => pushed.push(s) },
    inputAllowed: () => control.allowed, onLocalHotkey: code => { hotkeys.push(code); return code === 'KeyM'; } });
  kb.ctx.mods = new StickyModifiers(kb);
  kb.setProfile('auto', hostOs);
  kb.attach();
  t.after(() => kb.detach());
  const held = { Shift: false, Control: false, Alt: false, Meta: false };
  const key = (type, code, num = true) => {
    const m = /^(Shift|Control|Alt|Meta)/.exec(code)?.[1];
    if (m && type === 'keydown') held[m] = true;
    const e = Object.assign(new Event(type, { cancelable: true }), {
      code, key: code, repeat: false, location: 0, getModifierState: k => k === 'NumLock' && num,
      shiftKey: held.Shift, ctrlKey: held.Control, altKey: held.Alt, metaKey: held.Meta,
    });
    if (m && type === 'keyup') held[m] = false;
    window.dispatchEvent(e);
  };
  return {
    kb, json, pushed, key, hotkeys, control, sink,
    /** A key event whose target is one of our own elements (`closest` answers for the selectors it's inside). */
    at(target, type, code) {
      const m = /^(Shift|Control|Alt|Meta)/.exec(code)?.[1];
      if (m && type === 'keydown') held[m] = true;
      const e = { type, target, code, key: code, repeat: false, location: 0, getModifierState: () => false,
        shiftKey: held.Shift, ctrlKey: held.Control, altKey: held.Alt, metaKey: held.Meta, preventDefault() {}, stopPropagation() {} };
      if (m && type === 'keyup') held[m] = false;
      if (type === 'keydown') kb._keydown(e); else kb._keyup(e);
      return sent.splice(0).join(' ');
    },
    keys(...steps) {
      for (const s of steps) key(s[0] === '+' ? 'keydown' : 'keyup', s.slice(1));
      return sent.splice(0).join(' ');
    },
    paste(text) {
      document.dispatchEvent(Object.assign(new Event('paste', { cancelable: true }), { clipboardData: { getData: () => text } }));
    },
    take: () => sent.splice(0).join(' '),
  };
}

test('a quick Ctrl+V (V up before the paste goes out) leaves no key down, and the next Ctrl+V pastes too', async t => {
  const f = fixture(t);
  assert.equal(f.kb.profile, 'pc');
  assert.equal(f.keys('+ControlLeft', '+KeyV'), '+ControlLeft');
  f.paste('first');
  assert.equal(f.keys('-KeyV', '-ControlLeft'), '-ControlLeft');
  await delay(60);
  assert.equal(f.take(), '+ControlLeft +KeyV -KeyV -ControlLeft');
  assert.equal(f.keys('+KeyV', '-KeyV'), '+KeyV -KeyV');
  assert.equal(f.keys('+ControlLeft', '+KeyV'), '+ControlLeft');
  f.paste('second');
  await delay(60);
  assert.equal(f.take(), '+KeyV -KeyV');
  assert.equal(f.keys('-KeyV', '-ControlLeft'), '-ControlLeft');
  assert.deepEqual(f.pushed, ['first', 'second']);
  assert.deepEqual([...f.kb.down], []);
});

test('a Ctrl+V the browser fires no paste for still pastes once, and V is released', async t => {
  const f = fixture(t);
  assert.equal(f.keys('+ControlLeft', '+KeyV'), '+ControlLeft');
  await delay(100);
  assert.equal(f.keys('-KeyV', '-ControlLeft'), '-ControlLeft');
  await delay(80);
  assert.equal(f.take(), '+ControlLeft +KeyV -KeyV -ControlLeft');
  assert.equal(f.keys('+KeyV', '-KeyV'), '+KeyV -KeyV');
});

test('Num Lock follows the PC\'s own; keys captured by Headroom Viewer\'s hook are released on blur', t => {
  const f = fixture(t);
  f.key('keydown', 'KeyA', false); f.key('keyup', 'KeyA', false);
  assert.deepEqual(f.json.filter(m => m.t === 'locks'), [{ t: 'locks', caps: false, num: false }]);
  f.take();
  f.kb.nativeKey('MetaLeft', true); f.kb.nativeKey('KeyE', true);
  assert.equal(f.take(), '+MetaLeft +KeyE');
  window.dispatchEvent(new Event('blur'));
  assert.equal(f.take(), '-MetaLeft -KeyE');
  f.kb.nativeKey('KeyE', false); f.kb.nativeKey('MetaLeft', false);
  assert.equal(f.take(), '');
});

test('watching only (no control): nothing goes to the computer but releases; local hotkeys still work', async t => {
  const f = fixture(t);
  assert.equal(f.keys('+ShiftLeft'), '+ShiftLeft');
  f.kb.nativeKey('MetaLeft', true);
  assert.equal(f.take(), '+MetaLeft');
  f.control.allowed = false; // they turned off control (the session also releases everything then)
  f.json.length = 0;
  // Keys held from before still let go.
  assert.equal(f.keys('-ShiftLeft'), '-ShiftLeft');
  f.kb.nativeKey('MetaLeft', false);
  assert.equal(f.take(), '-MetaLeft');
  // New presses don't go: typing, Enter, Caps Lock, Ctrl+C, Ctrl+Alt+End, keys from Headroom Viewer's hook, the menus' chords.
  assert.equal(f.keys('+KeyA', '-KeyA', '+Enter', '-Enter', '+CapsLock', '-CapsLock'), '');
  assert.equal(f.keys('+ControlLeft', '+KeyC', '-KeyC', '+AltLeft', '+End', '-End', '-AltLeft', '-ControlLeft'), '');
  f.kb.nativeKey('Tab', true); f.kb.nativeKey('Tab', false);
  f.kb.chord(['ControlLeft', 'ShiftLeft', 'Escape']); f.kb.tap('MetaLeft');
  assert.equal(f.take(), '');
  f.keys('+ControlLeft', '+KeyV'); f.paste('secret'); f.keys('-KeyV', '-ControlLeft');
  await delay(60);
  assert.equal(f.take(), '');
  assert.deepEqual(f.json, []);
  // Ctrl+Alt+Shift+M (show the toolbar) is this device's own.
  assert.equal(f.keys('+ControlLeft', '+AltLeft', '+ShiftLeft', '+KeyM', '-KeyM', '-ShiftLeft', '-AltLeft', '-ControlLeft'), '');
  assert.deepEqual(f.hotkeys, ['KeyM']);
  window.dispatchEvent(new Event('blur'));
  assert.deepEqual(f.json, [{ t: 'release' }]);
  // Control again: keys go.
  f.control.allowed = true;
  assert.equal(f.keys('+KeyA', '-KeyA'), '+KeyA -KeyA');
});

/** A toolbar button (`kbd`: the toolbar is being used from the keyboard), or a field in an option sheet. */
const ui = {
  button: kbd => {
    const bar = { classList: { contains: c => kbd && c === 'kbd' } };
    return { tagName: 'BUTTON', closest: sel => (sel.includes('#toolbar') ? bar : null) };
  },
  sheetField: { tagName: 'INPUT', closest: sel => (sel.includes('#sheet') ? {} : null) },
};

test('to a Mac host (Ctrl = ⌘), Ctrl let go in our own UI (Ctrl+Alt+Shift+M moved focus there) lets go of ⌘', t => {
  const f = fixture(t, 'macos');
  assert.equal(f.kb.profile, 'cmdctrl');
  assert.equal(f.keys('+ControlLeft', '+AltLeft', '+ShiftLeft'), '+MetaLeft +AltLeft +ShiftLeft');
  assert.equal(f.at(ui.button(true), 'keyup', 'ShiftLeft'), '-ShiftLeft');
  assert.equal(f.at(ui.button(true), 'keyup', 'AltLeft'), '-AltLeft');
  assert.equal(f.at(ui.button(true), 'keyup', 'ControlLeft'), '-MetaLeft');
  assert.equal(f.keys('+ControlLeft'), '+MetaLeft');
  assert.equal(f.at(ui.sheetField, 'keyup', 'ControlLeft'), '-MetaLeft');
  assert.deepEqual([...f.kb.down], []);
});

test('a toolbar button the pointer left focused doesn\'t keep typing from the computer; used from the keyboard, it does', t => {
  const f = fixture(t);
  assert.equal(f.at(ui.button(false), 'keydown', 'KeyH'), '+KeyH');
  assert.equal(f.at(ui.button(false), 'keyup', 'KeyH'), '-KeyH');
  assert.equal(f.sink.focused, 1, 'focus goes back to the remote screen');
  assert.equal(f.at(ui.button(true), 'keydown', 'ArrowRight'), '');
  assert.equal(f.at(ui.button(true), 'keyup', 'ArrowRight'), '');
  assert.equal(f.at(ui.sheetField, 'keydown', 'KeyH'), '');
  assert.equal(f.sink.focused, 1);
});

test('keys this device\'s own input method composes with go to the computer once, as its text (not as keys too)', t => {
  const f = fixture(t);
  const ime = (type, code, props = {}) => {
    const e = Object.assign(new Event(type, { cancelable: true }), { code, key: 'Process', keyCode: 229, repeat: false, location: 0,
      getModifierState: () => false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...props });
    window.dispatchEvent(e);
    return e;
  };
  assert.ok(!ime('keydown', 'KeyK').defaultPrevented, 'the input method still gets it');
  ime('keyup', 'KeyK', { key: 'k', keyCode: 75 });
  ime('keydown', 'KeyA', { isComposing: true });
  ime('keydown', 'Enter', { isComposing: true });
  assert.equal(f.take(), '');
  assert.equal(f.keys('+KeyB', '-KeyB'), '+KeyB -KeyB');
});

test('a Ctrl+V with more text than can go over pastes nothing (not the other computer\'s old clipboard) and says why', async t => {
  const f = fixture(t);
  const toastEl = { textContent: '', hidden: true, addEventListener() {}, matches: () => false };
  document.getElementById = id => (id === 'toast' ? toastEl : null);
  t.after(() => { delete document.getElementById; });
  f.kb.ctx.clipboard.pushLocal = () => 'too-large';
  assert.equal(f.keys('+ControlLeft', '+KeyV'), '+ControlLeft');
  f.paste('x'.repeat(16));
  await delay(200);
  assert.equal(f.keys('-KeyV', '-ControlLeft'), '-ControlLeft');
  await delay(60);
  assert.equal(f.take(), '', 'no Ctrl+V replayed');
  assert.match(toastEl.textContent, /Too much text to paste/);
  assert.deepEqual([...f.kb.down], []);
  assert.equal(f.keys('+KeyV', '-KeyV'), '+KeyV -KeyV', 'V works normally afterwards');
});

test('a Ctrl held down while focus is in a sheet still counts as a real Ctrl (a Ctrl+wheel then isn\'t a pinch)', t => {
  const f = fixture(t);
  const sheet = { closest: sel => (sel.includes('#sheet') ? {} : null), tagName: 'DIV' };
  f.at(sheet, 'keydown', 'ControlLeft');
  assert.ok(f.kb.physicalControls.has('ControlLeft'), 'tracked although the key stayed local');
  f.at(sheet, 'keyup', 'ControlLeft');
  assert.equal(f.kb.physicalControls.size, 0);
});
