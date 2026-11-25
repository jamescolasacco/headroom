// Exercise Chromium's gesture recognizer and DOM routing with the production input layer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';

const page = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>body {margin:0} #layer {width:100vw;height:100vh;touch-action:none}</style><div id="layer"></div>
<script type="module">
import {MouseInput} from '/js/input/mouse.js';
const layer = document.getElementById('layer');
window.packets = [];
new MouseInput({layer, conn:{sendBinary(buf){window.packets.push(Array.from(new Uint8Array(buf)))}},
  viewport:{toRemote:(x,y)=>({nx:x/innerWidth,ny:y/innerHeight})}, cursor:{setMode(){}},
  inputAllowed:()=>true, pinchTarget:()=>'remote'}).attach();
window.ready = true;
</script>`;
const server = createServer(async (req, res) => {
  if (req.url === '/') return res.end(page);
  if (!['/js/input/mouse.js', '/js/protocol.js'].includes(req.url)) {
    res.writeHead(404); return res.end();
  }
  res.setHeader('Content-Type', 'text/javascript');
  res.end(await readFile(new URL('../web' + req.url, import.meta.url)));
});
const dir = await mkdtemp(join(tmpdir(), 'headroom-pinch-browser-'));
let chrome, ws;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  chrome = spawn(process.argv[2] || 'google-chrome', ['--headless', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=0', '--user-data-dir=' + dir, 'http://127.0.0.1:' + server.address().port], { stdio: 'ignore' });
  const launched = once(chrome, 'spawn');
  const exited = once(chrome, 'exit');
  await launched;
  async function until(read, what) {
    for (let n = 0; n < 120; n++) {
      if (chrome.exitCode !== null || chrome.signalCode) throw new Error('Chromium exited: ' + (chrome.exitCode ?? chrome.signalCode));
      const value = await read();
      if (value) return value;
      await delay(100);
    }
    throw new Error('Timed out waiting for ' + what);
  }
  const port = await until(async () => {
    try { return (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch {}
  }, 'Chromium');
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await once(ws, 'open');
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data), request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id);
    if (msg.error) request.reject(new Error(msg.error.message)); else request.resolve(msg.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  await until(() => evaluate('window.ready'), 'the viewer input layer');
  for (const scaleFactor of [1.6, 0.65]) {
    await evaluate('window.packets.length = 0');
    await call('Input.synthesizePinchGesture', { x: 200, y: 150, scaleFactor, relativeSpeed: 400, gestureSourceType: 'mouse' });
    const packets = await until(async () => {
      const list = await evaluate('window.packets');
      return list.some(p => p[0] === 0x13) && list;
    }, 'remote zoom');
    let ctrl = false, steps = 0;
    for (const p of packets) {
      if (p[0] === 0x14) { assert.equal(String.fromCharCode(...p.slice(3)), 'ControlLeft'); ctrl = !!p[1]; }
      if (p[0] === 0x13) {
        assert.ok(ctrl);
        assert.equal(new DataView(Uint8Array.from(p).buffer).getInt16(3, true), 120 * Math.sign(scaleFactor - 1));
        steps++;
      }
    }
    assert.ok(steps >= 1); assert.equal(ctrl, false);
    assert.equal(await evaluate('visualViewport.scale'), 1);
    console.log('Browser pinch', scaleFactor, 'delivered', steps, 'remote zoom steps');
  }
  ws.close();
  chrome.kill(); await exited;
} finally {
  ws?.close(); chrome?.kill();
  server.closeAllConnections(); server.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
