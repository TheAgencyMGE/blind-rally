// Service worker: caches the app shell so Blind Rally opens instantly and survives flaky
// connections mid-rally. Third-party requests (map tiles, routing, places) are never
// intercepted — they go straight to the network under each provider's own caching rules.
const VERSION = 'br-v1.2.0';
const SHELL = [
  './',
  './index.html',
  './privacy.html',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/state.js',
  './js/storage.js',
  './js/rally.js',
  './js/arrival.js',
  './js/location.js',
  './js/timer.js',
  './js/geo.js',
  './js/photo.js',
  './js/net.js',
  './js/map.js',
  './js/destinations.js',
  './js/routing.js',
  './vendor/maplibre/maplibre-gl-csp.js',
  './vendor/maplibre/maplibre-gl-csp-worker.js',
  './vendor/maplibre/maplibre-gl.css',
  './fonts/barlow-condensed-latin-500-normal.woff2',
  './fonts/barlow-condensed-latin-700-normal.woff2',
  './fonts/barlow-condensed-latin-800-normal.woff2',
  './icons/icon.svg',
  './icons/icon-192.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Network first so updates land quickly; cached shell when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(url.pathname === './' ? './' : req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))),
    );
    return;
  }

  // Stale-while-revalidate for same-origin static assets.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
