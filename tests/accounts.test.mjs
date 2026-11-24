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
