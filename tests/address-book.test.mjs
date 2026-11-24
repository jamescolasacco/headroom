import test from 'node:test';
import assert from 'node:assert/strict';

const data = new Map();
globalThis.localStorage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
globalThis.matchMedia = () => ({ matches: false });
globalThis.window = { chrome: { webview: { postMessage() {} } } };
globalThis.location = { hostname: 'app.headroom.local' };
const { accountHosts, loadAccount, reachableUrl } = await import('../web/js/account.js');
const { loadPrefs, savePrefs, DEFAULT_PREFS } = await import('../web/js/store.js');

test('old or interrupted browser storage still opens the viewer', () => {
  for (const invalid of [null, false, [], 'old']) {
    data.set('headroom.account.v2', JSON.stringify(invalid));
    data.set('headroom.prefs.v1', JSON.stringify(invalid));
    assert.deepEqual(accountHosts(), []);
    assert.deepEqual(loadPrefs('device'), DEFAULT_PREFS);
    savePrefs('device', { maxFps: 30 });
    assert.equal(loadPrefs('device').maxFps, 30);
  }
  data.set('headroom.account.v2', JSON.stringify({ server: 'https://service.test', token: 'test' }));
  assert.deepEqual(loadAccount().computers, []);
  assert.deepEqual(accountHosts(), []);
});

test('a stale direct address for a different computer falls back to the matching relay', async t => {
  const direct = 'https://lan.test', relay = 'https://service.test/r/device';
  t.mock.method(globalThis, 'fetch', async url => Response.json({ host: { id: url.startsWith(direct) ? 'previous' : 'requested' } }));
  assert.equal(await reachableUrl({ hostId: 'requested', lastUrl: direct, urls: [], relayUrl: relay, relayOnline: true }), relay);
});

test('a captive portal and offline addresses leave a computer unreachable', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('portal')) return new Response('<html>sign in</html>');
    throw new Error('offline');
  });
  assert.equal(await reachableUrl({ hostId: 'requested', urls: ['https://portal.test', 'https://offline.test'] }), null);
});
