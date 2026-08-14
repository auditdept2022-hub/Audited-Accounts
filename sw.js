// Minimal app-shell service worker.
// Caches only the static shell (this file, the HTML, manifest, icons) —
// NOT your live ledger data, which always comes fresh from the network.
//
// STRATEGY (this is the fix for "my edits never show up until I reload
// twice"): the HTML shell/navigation request now goes NETWORK-FIRST,
// falling back to cache only when offline. The previous version served
// the CACHED copy instantly on every load and only refreshed the cache
// in the background for next time — so a change made to index.html was
// always one reload behind, and if you kept editing + reloading once,
// you'd never actually see your latest change. Static, rarely-changing
// assets (manifest, icons) still use cache-first, since serving those
// instantly from cache is a pure win and they don't need to be fresh.
//
// Bump CACHE_NAME any time SHELL_FILES itself changes (e.g. you add a
// new icon) so old cached entries for removed files get cleaned up by
// the activate handler below — it's not what fixes staleness of
// index.html's contents though; the network-first fetch handler is.
const CACHE_NAME = 'audited-accounts-shell-v2';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Files that change rarely and are safe to serve instantly from cache
// (falling back to network only on a cache miss).
const CACHE_FIRST_FILES = new Set([
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests for the shell; let everything
  // else (API calls, Google Fonts, etc.) go straight to the network.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname.endsWith('/') ? './' : '.' + url.pathname.slice(url.pathname.lastIndexOf('/'));
  const isNavigation = event.request.mode === 'navigate';
  const isCacheFirstAsset = CACHE_FIRST_FILES.has(path) || SHELL_FILES.some((f) => url.href.endsWith(f.replace('./', '')));

  if (isNavigation || !isCacheFirstAsset) {
    // NETWORK-FIRST: always try to get the latest index.html/JS. Only
    // fall back to whatever's cached if the network request fails
    // (offline, DNS issue, etc.) — this is what makes a fresh edit show
    // up on the very next load instead of one load later.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // CACHE-FIRST for static assets that rarely change (manifest, icons):
  // instant from cache, refreshed in the background for next time.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
