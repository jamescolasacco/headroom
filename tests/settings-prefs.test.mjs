import test from 'node:test';
import assert from 'node:assert/strict';

const data = new Map();
let failWrites = false;
globalThis.localStorage = {
  getItem: k => (data.has(k) ? data.get(k) : null),
  setItem: (k, v) => { if (failWrites) throw new Error('QuotaExceededError'); data.set(k, String(v)); },
  removeItem: k => data.delete(k),
};
const { loadPrefs, savePrefs, DEFAULT_PREFS } = await import('../web/js/store.js');
const PREFS = 'headroom.prefs.v1', VERSION = 'headroom.prefs.version';
const stored = () => JSON.parse(data.get(PREFS));

test('settings are kept per computer, with the typing eye for every computer', () => {
  data.clear();
  assert.deepEqual(loadPrefs('mac'), DEFAULT_PREFS);
  savePrefs('mac', { scaling: 'actual', maxFps: 30 });
  savePrefs('global', { typingHidden: true });
  assert.equal(loadPrefs('mac').scaling, 'actual');
  assert.equal(loadPrefs('mac').maxFps, 30);
  assert.equal(loadPrefs('pc').scaling, 'fit');
  assert.equal(loadPrefs('pc').maxFps, 15);
  assert.equal(loadPrefs('pc').typingHidden, true);
  assert.equal(loadPrefs('mac').typingHidden, true);
});

test('frame rates saved before 15 fps became the default are let go once; later ones stay', () => {
  data.clear();
  data.set(PREFS, JSON.stringify({ global: { maxFps: 60, stats: true }, mac: { maxFps: 30, scaling: 'fill' } }));
  const p = loadPrefs('mac');
  assert.equal(p.maxFps, 15);
  assert.equal(p.stats, true);
  assert.equal(p.scaling, 'fill');
  assert.equal(data.get(VERSION), '2');
  savePrefs('mac', { maxFps: 60 });
  assert.equal(loadPrefs('mac').maxFps, 60);
});

test('saving first still migrates what an older version saved', () => {
  data.clear();
  data.set(PREFS, JSON.stringify({ mac: { maxFps: 30, keyboardProfile: 'mac' } }));
  savePrefs('mac', { stats: true });
  assert.deepEqual(stored().mac, { keyboardProfile: 'mac', stats: true });
  assert.equal(loadPrefs('mac').maxFps, 15);
});

test('a migration that couldn\'t be saved is tried again, and settings never fail to load', () => {
  data.clear();
  data.set(PREFS, JSON.stringify({ mac: { maxFps: 30 } }));
  failWrites = true;
  try {
    assert.equal(loadPrefs('mac').maxFps, 30); // nothing could be written: what's stored still applies
    assert.equal(data.get(VERSION), undefined);
  } finally { failWrites = false; }
  assert.equal(loadPrefs('mac').maxFps, 15);
  assert.equal(data.get(VERSION), '2');
});
