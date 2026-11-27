// Offline-capable app shell. Network-first so an update is picked up immediately; the cache lets the home-screen
// app open when the network is flaky.
const PREFIX = 'headroom-shell-';
const CACHE = PREFIX + 'v15';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest', '/css/app.css',
  '/js/app.js', '/js/account.js', '/js/config.js', '/js/qr.js', '/js/api.js', '/js/store.js', '/js/platform.js', '/js/protocol.js', '/js/connection.js',
  '/js/session.js', '/js/viewport.js', '/js/cursor.js', '/js/clipboard.js',
  '/js/video/presenter.js', '/js/video/decoder-core.js', '/js/video/video-worker.js',
  '/js/audio/player.js', '/js/audio/worklet.js', '/js/audio/playout.js', '/js/audio/feed.js', '/js/audio/decode-worker.js',
  '/js/audio/worklet-bundle.js',
  '/js/input/keyboard.js', '/js/input/keymap.js', '/js/input/mouse.js', '/js/input/touch.js', '/js/input/softkbd.js',
  '/js/ui/dom.js', '/js/ui/icons.js', '/js/ui/light.js', '/js/ui/toolbar.js', '/js/ui/stats.js', '/js/ui/extrakeys.js', '/js/ui/typing.js', '/js/ui/updates.js',
  '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/icon.svg', '/icons/icon-192.png', '/icons/apple-touch-icon.png',
  '/fonts/FunnelSans-latin-ext.woff2', '/fonts/FunnelDisplay-latin-ext.woff2', '/fonts/FunnelSans-latin.woff2', '/fonts/FunnelDisplay-latin.woff2', '/fonts/AtkinsonHyperlegibleMono-latin.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Only public shell assets belong in this cache. Other apps may share the origin.
  if (!SHELL.includes(url.pathname) || e.request.headers.has('range') || e.request.headers.has('authorization')) return;
  // '/' and '/index.html' are one page: one copy, so an offline visit to either gets the newest.
  const key = url.pathname === '/index.html' ? '/' : url.pathname;
  e.respondWith((async () => {
    let fresh;
    try {
      fresh = await fetch(e.request);
    } catch (networkError) {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(key);
      if (cached) return cached;
      throw networkError;
    }
    if (fresh.ok && fresh.status !== 206 && !fresh.redirected && !/\bno-store\b/i.test(fresh.headers.get('cache-control') || '')) {
      const copy = fresh.clone();
      // The network response remains usable even if storage is full or private browsing refuses the write.
      e.waitUntil(caches.open(CACHE).then(cache => cache.put(key, copy)).catch(() => {}));
    }
    return fresh;
  })());
});
