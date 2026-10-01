// Dedicated video worker: decoding off the main thread keeps input and audio smooth, and Safari only
// offers VideoTrackGenerator (its fast path to a <video> element) inside workers.
import { DecoderCore } from './decoder-core.js';

let core = null;
let vtg = null;

self.onmessage = e => {
  const m = e.data;
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
};

function post(msg) { self.postMessage(msg); }
