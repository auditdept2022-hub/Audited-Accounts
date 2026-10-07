// App-shell service worker for Audited Accounts.
//
// Caches ONLY the static shell (index.html, manifest, icons) and the Google
// Fonts files. Live ledger data (Apps Script calls) is cross-origin and is
// never touched here — it always goes straight to the network, and the app
// itself keeps its own offline copy + outbox in localStorage.
//
// STRATEGY
//  - Page navigation (the HTML): CACHE-FIRST + background revalidation (v6).
//    The saved page opens instantly on every launch. A conditional request
//    (304 when unchanged, so no 700 KB re-download) checks for a newer
//    index.html in the background; if one exists it is stored and used on the
//    next open, and open pages get a 'SHELL_UPDATED' message. Works with
//    query strings (?_refresh=..., ?utm=..) when offline.
//  - Manifest / icons: CACHE-FIRST (instant), refreshed in the background.
//  - Google Fonts (CSS + font files): STALE-WHILE-REVALIDATE in their own
//    cache, so the app keeps its look when offline.
//  - Everything else same-origin: network, falling back to cache.
//
// v5 FIXES (vs v4)
//  1. Install no longer fails if one icon is missing. cache.addAll() is
//     all-or-nothing: a single 404 (e.g. icon-512.png not uploaded) made the
//     whole install fail => NO service worker => NO offline at all. Now only
//     index.html is mandatory; every other file is best-effort.
//  2. The "is this a cache-first asset?" test was always true (the './' entry
//     became '' and endsWith('') matches every URL), so the cache-first and
//     network-first branches were not what the comments claimed. Replaced
//     with an exact file-name check.
//  3. Offline navigation to a URL with a query string (the Force-refresh
//     reload adds ?_refresh=...) never matched the cache and showed the
//     browser's offline page. Cache lookups now ignore the query string and
//     fall back to index.html.
//  4. Navigations are stored under ONE key, so cache-busting URLs no longer
//     pile up copies of the 600 KB+ shell in Cache Storage.
//  5. Google Fonts are cached for offline use.
//
// Bump CACHE_NAME whenever SHELL_FILES changes. FORCE REFRESH from the app
// (hamburger menu) still works: it unregisters this worker and deletes all
// caches from the page; the 'message' listener below is a second path.

const CACHE_NAME = 'audited-accounts-shell-v6';
const FONT_CACHE_NAME = 'audited-accounts-fonts-v1';

// The one file that MUST be cached for the worker to be worth installing.
const SHELL_PAGE = './index.html';
// Best-effort extras (a missing one must never break install).
const OPTIONAL_FILES = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png'
];

// Exact file names served cache-first.
const CACHE_FIRST_NAMES = new Set([
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon-512-maskable.png',
  'apple-touch-icon.png'
]);

const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

function isCacheable_(response) {
  return !!response && (response.ok || response.type === 'opaque');
}

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'CLEAR_ALL') {
    event.waitUntil(
      caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))))
    );
  } else if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Mandatory: the HTML shell. If this fails the install fails and the
    // previous worker (if any) stays in charge — that's the right outcome.
    const page = await fetch(SHELL_PAGE, { cache: 'reload' });
    if (!page || !page.ok) throw new Error('Shell fetch failed: ' + (page && page.status));
    await cache.put(SHELL_PAGE, page.clone());
    await cache.put('./', page.clone()); // same document, served for the bare folder URL

    // Best-effort: never let a missing icon block the install.
    await Promise.all(OPTIONAL_FILES.map(async (file) => {
      try {
        const res = await fetch(file, { cache: 'reload' });
        if (res && res.ok) await cache.put(file, res);
      } catch (err) { /* offline-at-install or 404 — fine */ }
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME && name !== FONT_CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    ).then(() => self.clients.claim())
  );
});

// Cached shell for any navigation, regardless of query string.
async function cachedShell_(request) {
  const cache = await caches.open(CACHE_NAME);
  return (
    (await cache.match(request, { ignoreSearch: true })) ||
    (await cache.match(SHELL_PAGE)) ||
    (await cache.match('./'))
  );
}

function handleNavigation_(event) {
  const request = event.request;

  // Background check for a newer index.html. cache:'no-cache' makes this a
  // conditional request (If-None-Match / If-Modified-Since): when the file is
  // unchanged the server answers 304 with no body, so a normal open no longer
  // re-downloads the whole 700 KB page.
  const revalidate = fetch(SHELL_PAGE, { cache: 'no-cache' })
    .then(async (response) => {
      if (!response || !response.ok || response.type !== 'basic') return null;
      const cache = await caches.open(CACHE_NAME);
      const old = await cache.match(SHELL_PAGE);
      const oldTag = old && (old.headers.get('etag') || old.headers.get('last-modified'));
      const newTag = response.headers.get('etag') || response.headers.get('last-modified');
      const changed = !old || !oldTag || !newTag || oldTag !== newTag;
      if (changed) {
        await cache.put(SHELL_PAGE, response.clone());
        await cache.put('./', response.clone());
        if (old) {
          // A newer app version is stored; it will be used on the next open.
          const clients = await self.clients.matchAll({ type: 'window' });
          clients.forEach((c) => c.postMessage({ type: 'SHELL_UPDATED' }));
        }
      }
      return response;
    })
    .catch(() => null);

  event.waitUntil(revalidate);

  return (async () => {
    const cached = await cachedShell_(request);

    // First ever visit (nothing cached yet): the network is the only option.
    if (!cached) {
      const first = await fetch(request).catch(() => null);
      return first || Response.error();
    }

    // Cached shell exists: open instantly, no waiting on the network.
    return cached;
  })();
}

function handleCacheFirst_(event) {
  return caches.match(event.request, { ignoreSearch: true }).then((cached) => {
    const refresh = fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => cached);
    if (cached) { event.waitUntil(refresh); return cached; }
    return refresh;
  });
}

function handleFonts_(event) {
  return caches.open(FONT_CACHE_NAME).then((cache) =>
    cache.match(event.request).then((cached) => {
      const refresh = fetch(event.request)
        .then((response) => {
          if (isCacheable_(response)) cache.put(event.request, response.clone()).catch(() => {});
          return response;
        })
        .catch(() => cached);
      if (cached) { event.waitUntil(refresh); return cached; }
      return refresh;
    })
  );
}

function handleOtherSameOrigin_(event) {
  return fetch(event.request).catch(async () => {
    const cached = await caches.match(event.request, { ignoreSearch: true });
    return cached || Response.error();
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Google Fonts: cached for offline look-and-feel.
  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(handleFonts_(event));
    return;
  }

  // Everything else cross-origin (Apps Script API, CDNs): straight to network.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation_(event));
    return;
  }

  const fileName = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  if (CACHE_FIRST_NAMES.has(fileName)) {
    event.respondWith(handleCacheFirst_(event));
    return;
  }

  event.respondWith(handleOtherSameOrigin_(event));
});
