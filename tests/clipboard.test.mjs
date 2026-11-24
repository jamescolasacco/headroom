import assert from 'node:assert/strict';
import test from 'node:test';
import { ClipboardSync } from '../web/js/clipboard.js';

test('clipboard sync respects permission changes during a browser read', async () => {
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => false });
  const sent = [];
  let allowed = false, reads = 0, finish;
  Object.defineProperties(navigator, {
    permissions: { configurable: true, value: { query: async () => ({ state: 'granted' }) } },
    clipboard: { configurable: true, value: { readText() { reads++; return new Promise(r => { finish = r; }); } } },
  });
  const clip = new ClipboardSync({ sendJson: m => sent.push(m.text) }, () => allowed);
  try {
    await clip._readLocalIfGranted();
    clip.pushLocal('before acceptance');
    assert.equal(reads, 0);
    allowed = true;
    const read = clip.readLocalExplicit();
    allowed = false;
    finish('after revocation');
    await assert.rejects(read, /unavailable/);
    assert.deepEqual(sent, []);
    allowed = true;
    clip.pushLocal('first');
    clip.onRemote('second');
    clip.pushLocal('first');
    assert.deepEqual(sent, ['first', 'first']);
  } finally {
    clip.dispose();
    delete navigator.permissions;
    delete navigator.clipboard;
  }
});
