import assert from 'node:assert/strict';
import test from 'node:test';
import { ClipboardSync, MAX_CLIP_BYTES, clipTooLarge } from '../web/js/clipboard.js';

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

test('clipboard text says what became of it, and text over the limit is never sent', async () => {
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => false });
  const sent = [];
  let allowed = false;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => 'ü'.repeat(MAX_CLIP_BYTES / 2 + 1) } });
  const clip = new ClipboardSync({ sendJson: m => sent.push(m.text) }, () => allowed);
  try {
    assert.equal(clip.pushLocal('not connected'), 'off');
    allowed = true;
    assert.equal(clip.pushLocal('hello'), 'sent');
    assert.equal(clip.pushLocal('hello'), 'same');
    clip.onRemote('on the host');
    assert.equal(clip.pushLocal('on the host'), 'same');
    // The limit is in UTF-8 bytes: 3-byte characters reach it at a third of the length.
    assert.equal(clipTooLarge('a'.repeat(MAX_CLIP_BYTES)), false);
    assert.equal(clipTooLarge('a'.repeat(MAX_CLIP_BYTES + 1)), true);
    assert.equal(clipTooLarge('中'.repeat(MAX_CLIP_BYTES / 3)), false);
    assert.equal(clipTooLarge('中'.repeat(MAX_CLIP_BYTES / 3 + 1)), true);
    assert.equal(clip.pushLocal('中'.repeat(MAX_CLIP_BYTES / 3 + 1)), 'too-large');
    const r = await clip.readLocalExplicit();
    assert.equal(r.status, 'too-large');
    assert.deepEqual(sent, ['hello']);
  } finally {
    clip.dispose();
    delete navigator.clipboard;
  }
});

test('a reconnect forgets what was waiting to be written', async () => {
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => false });
  const writes = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { writes.push(t); } } });
  const clip = new ClipboardSync({ sendJson() { } }, () => true);
  try {
    clip.onRemote('copied before the connection dropped'); // no focus: kept for the next gesture
    assert.equal(clip.pending, 'copied before the connection dropped');
    clip.clear();
    clip.onUserGesture();
    await Promise.resolve();
    assert.deepEqual(writes, []);
    assert.equal(clip.remote, '');
  } finally {
    clip.dispose();
    delete navigator.clipboard;
  }
});

test('a remote clipboard with no text (nothing copied, an image, over the limit) never wipes this device\'s', async () => {
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true });
  const written = [];
  Object.defineProperties(navigator, {
    clipboard: { configurable: true, value: { writeText: async t => { written.push(t); } } },
  });
  const clip = new ClipboardSync({ sendJson() {} }, () => true);
  try {
    clip.onRemote('');            // Refresh while the other computer holds no text
    clip.onUserGesture();         // a later tap must not flush an empty write either
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(written, []);
    assert.equal(clip.remote, '', 'the sheet still shows what the other computer has');
    clip.onRemote('real text');
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(written, ['real text']);
  } finally {
    clip.dispose();
    delete navigator.clipboard;
  }
});
