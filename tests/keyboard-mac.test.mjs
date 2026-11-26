// The physical keyboard of a Mac viewer (Chrome on macOS): what reaches the host. macOS never delivers the keyup of a key
// released while ⌘ is held, so those presses get no keyup here either.
import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', maxTouchPoints: 0 },
});
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.window = Object.assign(new EventTarget(), { isSecureContext: true });
globalThis.document = Object.assign(new EventTarget(), { body: {}, activeElement: null });
const { KeyboardInput } = await import('../web/js/input/keyboard.js');
const { StickyModifiers } = await import('../web/js/ui/extrakeys.js');

function fixture(t, hostOs) {
  const sent = [], locks = [], hotkeys = [];
  const conn = {
    sendBinary(buf) {
      const b = new Uint8Array(buf);
      assert.equal(b[0], 0x14);
      sent.push((b[1] ? '+' : '-') + new TextDecoder().decode(b.slice(3)));
    },
    sendJson(m) { if (m.t === 'locks') locks.push(m); },
  };
  const kb = new KeyboardInput({ conn, sink: { focus() {} }, clipboard: { expectRemoteCopy() {}, pushLocal() {} },
    onLocalHotkey: code => { hotkeys.push(code); return code === 'KeyM'; } });
  kb.ctx.mods = new StickyModifiers(kb);
  kb.setProfile('auto', hostOs);
  kb.attach();
  t.after(() => kb.detach());
  const held = { Shift: false, Control: false, Alt: false, Meta: false };
  const send = (type, code) => {
    const m = /^(Shift|Control|Alt|Meta)/.exec(code)?.[1];
    if (m && type === 'keydown') held[m] = true;
    const e = Object.assign(new Event(type, { cancelable: true }), {
      code, key: code, repeat: false, location: 0, getModifierState: () => false,
      shiftKey: held.Shift, ctrlKey: held.Control, altKey: held.Alt, metaKey: held.Meta,
    });
    if (m && type === 'keyup') held[m] = false;
    window.dispatchEvent(e);
  };
  return {
    kb, locks, hotkeys,
    /** '+X' presses X, '-X' releases it; a key (not a modifier) released while ⌘ is held gets no keyup, as on macOS. */
    keys(...steps) {
      for (const s of steps) {
        const code = s.slice(1);
        if (s[0] === '+') send('keydown', code);
        else if (!held.Meta || /^(Shift|Control|Alt|Meta)/.test(code)) send('keyup', code);
      }
      return sent.splice(0).join(' ');
    },
  };
}

test('to a Windows host, ⌘C copies every time and a c typed between two of them is released', t => {
  const f = fixture(t, 'windows');
  assert.equal(f.kb.profile, 'mac');
  assert.equal(f.keys('+MetaLeft', '+KeyC', '-KeyC', '-MetaLeft'), '+ControlLeft +KeyC -KeyC -ControlLeft');
  assert.equal(f.keys('+KeyC', '-KeyC'), '+KeyC -KeyC');
  assert.equal(f.keys('+MetaLeft', '+KeyC', '-KeyC', '-MetaLeft'), '+ControlLeft +KeyC -KeyC -ControlLeft');
  assert.equal(f.keys('+MetaLeft', '+KeyE', '-KeyE', '-MetaLeft'), '+MetaLeft +KeyE -KeyE -MetaLeft');
  assert.equal(f.keys('+KeyE', '-KeyE'), '+KeyE -KeyE');
  assert.deepEqual([...f.kb.down], []);
});

test('to a Mac host, a key typed after a ⌘ shortcut on it is released', t => {
  const f = fixture(t, 'macos');
  assert.equal(f.kb.profile, 'pc');
  assert.equal(f.keys('+MetaLeft', '+KeyC', '-KeyC', '-MetaLeft'), '+MetaLeft +KeyC -KeyC -MetaLeft');
  assert.equal(f.keys('+KeyC', '-KeyC'), '+KeyC -KeyC');
  assert.deepEqual([...f.kb.down], []);
});

test('⌘⇧ and ⌥⇧ shortcuts reach a Windows host without Win or Alt, in either order', t => {
  const f = fixture(t, 'windows');
  const redo = '+ShiftLeft -ShiftLeft +ControlLeft +KeyY -KeyY -ControlLeft +ShiftLeft -ShiftLeft';
  assert.equal(f.keys('+MetaLeft', '+ShiftLeft', '+KeyZ', '-KeyZ', '-ShiftLeft', '-MetaLeft'), redo);
  assert.equal(f.keys('+ShiftLeft', '+MetaLeft', '+KeyZ', '-KeyZ', '-MetaLeft', '-ShiftLeft'), redo);
  assert.equal(f.keys('+MetaLeft', '+ShiftLeft', '+KeyT', '-KeyT', '-ShiftLeft', '-MetaLeft'), '+ShiftLeft +ControlLeft +KeyT -KeyT -ControlLeft -ShiftLeft');
  assert.equal(f.keys('+AltLeft', '+ShiftLeft', '+ArrowLeft', '-ArrowLeft', '-ShiftLeft', '-AltLeft'), '+ShiftLeft +ControlLeft +ArrowLeft -ArrowLeft -ControlLeft -ShiftLeft');
  assert.equal(f.keys('+MetaLeft', '+ShiftLeft', '+ArrowRight', '-ArrowRight', '-ShiftLeft', '-MetaLeft'), '+ShiftLeft +End -End -ShiftLeft');
  // Not translated: ⌘ goes down as Win for it.
  assert.equal(f.keys('+MetaLeft', '+ShiftLeft', '+Digit4', '-Digit4', '-ShiftLeft', '-MetaLeft'), '+ShiftLeft +MetaLeft +Digit4 -Digit4 -ShiftLeft -MetaLeft');
  // ⌘ alone still opens Start; ⌘⇧ alone taps nothing.
  assert.equal(f.keys('+MetaLeft', '-MetaLeft'), '+MetaLeft -MetaLeft');
  assert.equal(f.keys('+MetaLeft', '+ShiftLeft', '-ShiftLeft', '-MetaLeft'), '+ShiftLeft -ShiftLeft');
  // ⌘⇧-click: Ctrl+Shift+click.
  f.keys('+MetaLeft', '+ShiftLeft');
  f.kb.prepareClick();
  assert.equal(f.keys('-ShiftLeft', '-MetaLeft'), '+ControlLeft -ShiftLeft -ControlLeft');
});

test('a local hotkey typed with Option leaves no tap of Alt on a Windows host', t => {
  const f = fixture(t, 'windows');
  assert.equal(f.keys('+ControlLeft', '+ShiftLeft', '+AltLeft', '+KeyM', '-KeyM', '-ControlLeft', '-ShiftLeft', '-AltLeft'), '+ControlLeft +ShiftLeft -ControlLeft -ShiftLeft');
  assert.deepEqual(f.hotkeys, ['KeyM']);
  // ⌥ alone is still a tap of Alt.
  assert.equal(f.keys('+AltLeft', '-AltLeft'), '+AltLeft -AltLeft');
});

test('a Mac keyboard keeps a PC\'s Num Lock on (its keypad types digits)', t => {
  const f = fixture(t, 'windows');
  f.keys('+KeyA', '-KeyA');
  assert.deepEqual(f.locks, [{ t: 'locks', caps: false, num: true }]);
});
