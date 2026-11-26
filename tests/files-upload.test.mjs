import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadFile, uploadError } from '../web/js/api.js';

/** Just enough XMLHttpRequest: `respond(status, body)` finishes the request; abort() ends it as a browser does. */
class FakeXhr {
  static last = null;
  constructor() { this.upload = {}; this.headers = {}; FakeXhr.last = this; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send(body) { this.body = body; }
  respond(status, body) { this.status = status; this.responseText = body; this.onload?.(); this.onloadend?.(); }
  abort() { this.aborted = true; this.onabort?.(); this.onloadend?.(); }
}
globalThis.XMLHttpRequest = FakeXhr;
const host = { url: 'https://host.test', token: 'secret' };
const file = { name: 'résumé 📄.txt' };

test('an upload goes to the folder with the key in a header, and resolves with where it was saved', async () => {
  const up = uploadFile(host, file, '/Users/x/Downloads', null);
  const x = FakeXhr.last;
  assert.equal(x.method, 'POST');
  assert.equal(x.url, `https://host.test/api/files/upload?dir=${encodeURIComponent('/Users/x/Downloads')}&name=${encodeURIComponent(file.name)}`);
  assert.equal(x.headers.Authorization, 'Bearer secret');
  assert.ok(!x.url.includes('secret'));
  x.respond(200, JSON.stringify({ path: '/Users/x/Downloads/résumé 📄 (1).txt', name: 'résumé 📄 (1).txt' }));
  assert.deepEqual(await up, { path: '/Users/x/Downloads/résumé 📄 (1).txt', name: 'résumé 📄 (1).txt' });
});

test('a refused upload says why in words', async () => {
  const cases = [
    [403, { error: 'file transfer isn\'t allowed' }, 'file transfer isn\'t allowed'],
    [403, { error: 'can\'t write there: Permission denied' }, 'that folder can\'t be written to'],
    [401, { error: 'unauthorized' }, 'this session no longer has access'],
    [503, { error: 'stopped' }, 'Headroom Server is stopped'],
    [500, null, 'the computer answered 500'],
  ];
  for (const [status, body, words] of cases) {
    const up = uploadFile(host, file, '', null);
    FakeXhr.last.respond(status, body ? JSON.stringify(body) : '<html>');
    await assert.rejects(up, new RegExp(words.replace(/[()]/g, '\\$&')));
  }
  assert.equal(uploadError(0), 'the connection was lost');
});

test('stopping an upload aborts the request, even before it starts', async () => {
  const ctl = new AbortController();
  const up = uploadFile(host, file, '', null, ctl.signal);
  const x = FakeXhr.last;
  ctl.abort();
  assert.equal(x.aborted, true);
  await assert.rejects(up, e => e.name === 'AbortError');
  FakeXhr.last = null;
  await assert.rejects(uploadFile(host, file, '', null, ctl.signal), e => e.name === 'AbortError');
  assert.equal(FakeXhr.last, null);
});
