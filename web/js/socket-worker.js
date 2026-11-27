// The connection's WebSocket in a dedicated worker (connection.js starts it; socket-core.js does the work).
import { SocketCore } from './socket-core.js';

const core = new SocketCore({ post: (m, transfer) => self.postMessage(m, transfer || []) });
core.onexit = () => self.close();

self.onmessage = e => {
  try {
    core.handle(e.data);
  } catch (err) {
    console.warn('[socket]', err);
  }
  // Disposed: gone once its sockets have closed (their close handshakes go out first), or soon in any case.
  if (e.data?.type === 'dispose') setTimeout(() => self.close(), 3000);
};

self.postMessage({ type: 'ready' });
