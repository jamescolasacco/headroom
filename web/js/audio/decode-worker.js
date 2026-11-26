// Opus decoding off the main thread (audio priority): packets come from the page; the decoded sound goes straight to
// the AudioWorklet through the MessagePort the page hands over, so a busy main thread (video, layout, GC) can delay
// a packet's arrival but not its decoding and delivery.
//   {type: 'init', port} -> replies {type: 'ready', opus} (and says hello to the worklet through the port)
//   {type: 'packet', codec, seq, timeUs, data}
import { AudioFeed, OPUS_CONFIG } from './feed.js';

let feed = null;

self.onmessage = async e => {
  const m = e.data;
  if (m.type === 'init') {
    const port = m.port;
    let opus = false;
    try { opus = typeof AudioDecoder !== 'undefined' && !!(await AudioDecoder.isConfigSupported(OPUS_CONFIG)).supported; } catch { }
    feed = new AudioFeed((msg, transfer) => port.postMessage(msg, transfer), { opus });
    port.postMessage({ type: 'hello' });
    self.postMessage({ type: 'ready', opus });
  } else if (m.type === 'packet') {
    feed?.packet(m);
  }
};
