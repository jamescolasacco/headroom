// Dedicated video worker: decoding off the main thread keeps input and audio smooth, and Safari only
// offers VideoTrackGenerator (its fast path to a <video> element) inside workers. Configs and chunks come from the
// page, or ('port') straight from the connection's socket worker (socket-core.js).
import { DecoderCore } from './decoder-core.js';

let core = null;
let vtg = null;

self.onmessage = e => handle(e.data);

function handle(m) {
  switch (m.type) {
    case 'probe':
      self.postMessage({
        type: 'caps',
        vtg: typeof VideoTrackGenerator !== 'undefined',
        decoder: typeof VideoDecoder !== 'undefined',
      });
      break;
    case 'init':
      if (m.mode === 'vtg') {
        vtg = new VideoTrackGenerator();
        core = new DecoderCore({ kind: 'vtg', writer: vtg.writable.getWriter() }, post);
        self.postMessage({ type: 'track', track: vtg.track }, [vtg.track]);
      } else {
        core = new DecoderCore({ kind: 'canvas', canvas: m.canvas }, post);
      }
      break;
    case 'port':
      m.port.onmessage = ev => { if (ev.data?.type === 'config' || ev.data?.type === 'chunk') handle(ev.data); };
      break;
    case 'config':
      core?.configure(m);
      break;
    case 'chunk':
      core?.decode(m);
      break;
    case 'close':
      core?.close();
      core = null;
      self.close();
      break;
  }
}

function post(msg) { self.postMessage(msg); }
