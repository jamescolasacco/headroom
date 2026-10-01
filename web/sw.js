// Offline-capable app shell. Network-first so a host update is picked up immediately; the cache
// lets the home-screen app open (and reach *other* computers) even when this host is off.
const CACHE = 'headroom-shell-v1';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest', '/css/app.css',
  '/js/app.js', '/js/api.js', '/js/store.js', '/js/platform.js', '/js/protocol.js', '/js/connection.js',
  '/js/session.js', '/js/viewport.js', '/js/cursor.js', '/js/clipboard.js',
  '/js/video/presenter.js', '/js/video/decoder-core.js', '/js/video/video-worker.js',
  '/js/audio/player.js', '/js/audio/worklet.js',
  '/js/input/keyboard.js', '/js/input/keymap.js', '/js/input/mouse.js', '/js/input/touch.js', '/js/input/softkbd.js',
  '/js/ui/dom.js', '/js/ui/icons.js', '/js/ui/toolbar.js', '/js/ui/stats.js', '/js/ui/extrakeys.js',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/headroom-ca')) return;
  e.respondWith((async () => {
    try {
      const fresh = await fetch(e.request);
      if (fresh.ok) {
        const c = await caches.open(CACHE);
        c.put(e.request, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(e.request, { ignoreSearch: true });
      if (cached) return cached;
      if (e.request.mode === 'navigate') return caches.match('/index.html');
      throw new Error('offline');
    }
  })());
});
