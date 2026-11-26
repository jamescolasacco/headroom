import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store, passwordProblem } from '../account-server/server.mjs';

function database(t, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headroom-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(data));
  return dir;
}

const empty = { accounts: [], devices: [], computers: [] };

test('unsupported or damaged databases remain in place, byte for byte', t => {
  for (const data of [{ version: 3, ...empty }, { accounts: {} }, null, false, { ...empty, accounts: [{ email: 'a@example.test' }] }]) {
    const dir = database(t, data);
    assert.throws(() => new Store(dir), /database/);
    assert.deepEqual(fs.readdirSync(dir), ['db.json']);
    assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), JSON.stringify(data));
  }
});

test('both historical username formats migrate and existing email databases reopen', t => {
  for (const version of [1, undefined]) {
    const old = { version, ...empty, accounts: [{ username: 'sam' }] };
    const dir = database(t, old);
    const store = new Store(dir);
    store.save();
    const backup = fs.readdirSync(dir).find(name => name.startsWith('db.v1-'));
    assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), JSON.stringify(old));
    const reopened = new Store(dir);
    assert.deepEqual(reopened.data, store.data);
    assert.deepEqual(reopened.key, store.key);
  }
});

test('a damaged server key is reported without replacing it', t => {
  const dir = database(t, { version: 2, ...empty });
  const file = path.join(dir, 'secret.key');
  fs.writeFileSync(file, 'damaged');
  assert.throws(() => new Store(dir), /secret.key/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'damaged');
});

test('the maximum passphrase length counts normalized Unicode characters', async () => {
  const phrase = '🌙🚲🎹🪴'.repeat(64);
  assert.equal(await passwordProblem(phrase, '', { breach: false }), null);
  assert.match(await passwordProblem(phrase + 'x', '', { breach: false }), /256/);
});

// The web client's choice of account server (web/js/account.js serverInfo): the page's own server when it is a
// Headroom account server; undefined when it can't be reached (opened from the offline cache: stay with it, so a
// self-hosted page never sends sign-ins or codes to the public service); null for anything else that answers.
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia ??= () => ({ matches: false });
globalThis.window ??= {};
globalThis.location ??= { hostname: 'headroom.test' };
const { serverInfo } = await import('../web/js/account.js');

test('the web client keeps to its own server when it can\'t be reached, and only takes a real account server', async t => {
  const answer = { fn: null };
  t.mock.method(globalThis, 'fetch', async (...a) => answer.fn(...a));
  answer.fn = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await serverInfo('https://self.test'), undefined, 'unreachable');
  answer.fn = async (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = serverInfo('https://self.test');
  t.mock.timers.tick(5000);
  assert.equal(await slow, undefined, 'timed out');
  t.mock.timers.reset();
  answer.fn = async () => new Response('<html>a page</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  assert.equal(await serverInfo('https://static.test'), null, 'something else answered (not JSON)');
  answer.fn = async () => Response.json({ error: 'boom' }, { status: 500 });
  assert.equal(await serverInfo('https://self.test'), null, 'an HTTP error');
  answer.fn = async () => Response.json({ host: { id: 'computer' } });
  assert.equal(await serverInfo('https://computer.test'), null, 'a computer, not an account server');
  answer.fn = async () => Response.json({ service: 'headroom-account-server', signup: true });
  assert.equal((await serverInfo('https://self.test'))?.signup, true, 'an account server');
});
