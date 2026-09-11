const CACHE_NAME = 'camp-travel-map-v2';

// Files that change on every deploy: always try the network first so updates show up
// immediately, only falling back to the cached copy when offline.
const APP_SHELL_NETWORK_FIRST = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './data.js',
  './manifest.json'
];

// Static vendor assets that never change: safe to serve cache-first for speed.
const STATIC_ASSETS = [
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png'
];

const APP_SHELL = APP_SHELL_NETWORK_FIRST.concat(STATIC_ASSETS);

function isNetworkFirstUrl(url) {
  return APP_SHELL_NETWORK_FIRST.some(p => url.endsWith(p.replace('./', '/')) || url.endsWith(p.replace('./', '')));
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = event.request.url;
  const pathname = (() => { try { return new URL(url).pathname; } catch (e) { return url; } })();

  // Map tiles: cache-first so previously viewed areas of the map work offline
  if (url.indexOf('tile.openstreetmap.org') !== -1) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          const fetchPromise = fetch(event.request).then(resp => {
            cache.put(event.request, resp.clone());
            return resp;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // App shell (html/css/js/data/manifest) and page navigations: network-first, so a fresh
  // deploy shows up on the very next load instead of needing a manual cache clear. Falls
  // back to the cached copy only when offline.
  const isAppShell = event.request.mode === 'navigate' ||
    pathname === '/' ||
    APP_SHELL_NETWORK_FIRST.some(p => pathname.endsWith(p.replace('./', '/')));

  if (isAppShell) {
    event.respondWith(
      fetch(event.request).then(resp => {
        if (resp && resp.status === 200 && event.request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (vendor/static assets): cache-first, fall back to network, keep cache fresh
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        if (resp && resp.status === 200 && event.request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
