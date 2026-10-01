// Key tables shared by the physical keyboard, soft keyboard and extra-keys bar.

/** US-layout character -> {code, shift}. Used when a key event has no usable `code` (iOS soft keyboard,
 *  some iPad keys) and for sticky-modifier chords typed on the soft keyboard. */
const CHAR_CODES = (() => {
  const m = new Map();
  for (let i = 0; i < 26; i++) {
    const lc = String.fromCharCode(97 + i), uc = lc.toUpperCase(), code = `Key${uc}`;
    m.set(lc, { code, shift: false });
    m.set(uc, { code, shift: true });
  }
  const digits = ')!@#$%^&*(';
  for (let i = 0; i < 10; i++) {
    m.set(String(i), { code: `Digit${i}`, shift: false });
    m.set(digits[i], { code: `Digit${i}`, shift: true });
  }
  const pairs = [
    ['-', '_', 'Minus'], ['=', '+', 'Equal'], ['[', '{', 'BracketLeft'], [']', '}', 'BracketRight'],
    ['\\', '|', 'Backslash'], [';', ':', 'Semicolon'], ["'", '"', 'Quote'], ['`', '~', 'Backquote'],
    [',', '<', 'Comma'], ['.', '>', 'Period'], ['/', '?', 'Slash'],
  ];
  for (const [a, b, code] of pairs) { m.set(a, { code, shift: false }); m.set(b, { code, shift: true }); }
  m.set(' ', { code: 'Space', shift: false });
  m.set('\n', { code: 'Enter', shift: false });
  m.set('\t', { code: 'Tab', shift: false });
  return m;
})();

export function charToCode(ch) { return CHAR_CODES.get(ch) || null; }

/** Named keys whose `code` may arrive as "Unidentified" (iPadOS hardware keyboards). */
const KEY_TO_CODE = {
  Delete: 'Delete', Insert: 'Insert', PrintScreen: 'PrintScreen', ScrollLock: 'ScrollLock', Pause: 'Pause',
  ContextMenu: 'ContextMenu', Escape: 'Escape', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', CapsLock: 'CapsLock',
  Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft', Meta: 'MetaLeft', AltGraph: 'AltRight',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};

export function codeFromEvent(e) {
  let code = e.code;
  if (!code || code === 'Unidentified') {
    if (e.key === 'Enter' && e.location === 3) return 'NumpadEnter';
    code = KEY_TO_CODE[e.key] || (e.key && e.key.length === 1 ? charToCode(e.key)?.code : null) || null;
  }
  return code;
}

export const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);
export const isModifier = code => MODIFIER_CODES.has(code);

/**
 * Mac-style shortcuts on a Windows host (what Jump Desktop / Microsoft's Windows App do by default).
 * Applied while Cmd is held. Each value is the chord to send instead (codes pressed in order).
 * Unlisted Cmd+key combos go through as Win+key (Cmd+E = Explorer, Cmd+D = desktop, Cmd+R = Run...).
 */
const CMD_TO_CTRL = new Set('ABCFGHIKLNOPSTUVWXYZ'.split('').map(c => `Key${c}`).concat(['Equal', 'Minus', 'Digit0', 'Slash', 'Enter', 'Comma', 'Period']));

export function macCmdTranslation(code, { shift }) {
  if (code === 'KeyZ' && shift) return ['-Shift', 'ControlLeft', 'KeyY']; // Cmd+Shift+Z = redo (Shift must not be held)
  if (code === 'KeyQ') return ['AltLeft', 'F4'];                          // quit
  if (CMD_TO_CTRL.has(code)) return ['ControlLeft', code];
  switch (code) {
    case 'ArrowLeft': return ['Home'];
    case 'ArrowRight': return ['End'];
    case 'ArrowUp': return ['ControlLeft', 'Home'];
    case 'ArrowDown': return ['ControlLeft', 'End'];
    case 'Backspace': return ['ShiftLeft', 'Home', '+Backspace'];          // delete to line start
    case 'BracketLeft': return ['AltLeft', 'ArrowLeft'];                   // back
    case 'BracketRight': return ['AltLeft', 'ArrowRight'];                 // forward
  }
  return null;
}

/** Option+key (Mac) -> Windows word-navigation equivalents. */
export function macOptionTranslation(code) {
  switch (code) {
    case 'ArrowLeft': return ['ControlLeft', 'ArrowLeft'];
    case 'ArrowRight': return ['ControlLeft', 'ArrowRight'];
    case 'Backspace': return ['ControlLeft', 'Backspace'];
    case 'Delete': return ['ControlLeft', 'Delete'];
  }
  return null;
}
