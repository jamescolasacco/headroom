import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const origin = 'https://headroom.test';
const worker = fs.readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
function harness(fetch) {
  const handlers = {}, storage = new Map([['another-app', new Map()], ['headroom-shell-v12', new Map()]]);
  const caches = {
    keys: async () => [...storage.keys()],
    delete: async key => storage.delete(key),
    async open(key) {
      if (!storage.has(key)) storage.set(key, new Map());
      const entries = storage.get(key);
      return {
        async addAll(files) {
          for (const file of files) {
            const path = file === '/' ? '/index.html' : file;
            const bytes = fs.readFileSync(new URL('../web' + path, import.meta.url));
            entries.set(file, new Response(bytes));
          }
        },
        put: async (path, response) => entries.set(path, response),
        match: async path => entries.get(path)?.clone(),
      };
    },
  };
  vm.runInNewContext(worker, { URL, caches, fetch, location: { origin }, self: {
    clients: { claim() {} }, skipWaiting() {}, addEventListener(event, cb) { handlers[event] = cb; },
  } });
  async function fire(event, request) {
    const waits = [];
    let result;
    handlers[event]({ request, waitUntil: p => waits.push(p), respondWith: p => { result = p; } });
    const response = await result;
    await Promise.all(waits);
    return response;
  }
  return { storage, caches, fire };
}

test('offline shell installs all listed assets and activation preserves other apps', async () => {
  const h = harness(async () => { throw new Error('offline'); });
  await h.fire('install');
  await h.fire('activate');
  assert.ok(h.storage.has('another-app'));
  assert.equal(h.storage.has('headroom-shell-v12'), false);
  const offline = await h.fire('fetch', new Request(origin + '/index.html?v=1'));
  assert.match(await offline.text(), /<title>Headroom<\/title>/);
});

test('private and partial requests bypass the offline cache', async () => {
  const h = harness(() => { throw new Error('unexpected interception'); });
  for (const path of ['/api/info', '/r/device/ws', '/c/1234/', '/admin.html', '/shared-app/index.html']) {
    assert.equal(await h.fire('fetch', new Request(origin + path)), undefined);
  }
  for (const headers of [{ Range: 'bytes=0-15' }, { Authorization: 'Bearer example' }]) {
    assert.equal(await h.fire('fetch', new Request(origin + '/index.html', { headers })), undefined);
  }
});

test('an offline visit to / or /index.html gets the copy fetched last for either', async () => {
  let online = true;
  const h = harness(async () => {
    if (!online) throw new Error('offline');
    return new Response('<title>Headroom</title> newer deploy');
  });
  await h.fire('install');
  assert.match(await (await h.fire('fetch', new Request(origin + '/'))).text(), /newer deploy/);
  online = false;
  for (const path of ['/index.html', '/?code=1']) {
    assert.match(await (await h.fire('fetch', new Request(origin + path))).text(), /newer deploy/);
  }
});

test('cache refreshes are scoped to the shell and survive a cache write failure', async () => {
  let reply = new Response('new');
  const h = harness(() => reply.clone());
  await h.fire('install');
  const request = new Request(origin + '/js/app.js');
  assert.equal(await (await h.fire('fetch', request)).text(), 'new');
  const current = [...h.storage.keys()].find(k => k.startsWith('headroom-shell-') && k !== 'headroom-shell-v12');
  reply = new Response('private', { headers: { 'Cache-Control': 'no-store' } });
  await h.fire('fetch', request);
  assert.equal(await h.storage.get(current).get('/js/app.js').text(), 'new');
  reply = new Response('live');
  h.caches.open = async () => { throw new Error('storage unavailable'); };
  assert.equal(await (await h.fire('fetch', request)).text(), 'live');
});
