// App-shell service worker for Audited Accounts.
//
// Caches ONLY the static shell (index.html, manifest, icons) and the Google
// Fonts files. Live ledger data (Apps Script calls) is cross-origin and is
// never touched here — it always goes straight to the network, and the app
// itself keeps its own offline copy + outbox in localStorage.
//
// STRATEGY
//  - Page navigation (the HTML): OFFLINE-FIRST / stale-while-revalidate.
//    A cached shell is returned immediately; a network refresh updates the
//    cached shell in the background for the next launch. This avoids making
//    every PWA reopen wait on a weak/cold connection.
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

const CACHE_NAME = 'audited-accounts-shell-v11';
const FONT_CACHE_NAME = 'audited-accounts-fonts-v2';
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
      caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith('audited-accounts-')).map((n) => caches.delete(n))))
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
    try {
      await cache.put(new Request(new URL(SHELL_PAGE, self.location.href).href), page.clone());
    } catch (err) { /* relative keys above are sufficient on normal hosts */ }

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
          .filter((name) => name.startsWith('audited-accounts-') && name !== CACHE_NAME && name !== FONT_CACHE_NAME)
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

  // OFFLINE-FIRST NAVIGATION: once the shell exists, return it immediately
  // instead of waiting up to NAV_NETWORK_TIMEOUT_MS for the network. The
  // network refresh runs in the background and replaces the cached shell for
  // the next launch. This makes PWA reopen/reload instant in weak-signal
  // areas while still keeping the app shell current when online.
  const refresh = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(SHELL_PAGE, copy.clone());
          cache.put('./', copy);
        }).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  event.waitUntil(refresh);

  return (async () => {
    const cached = await cachedShell_(request);
    if (cached) return cached;
    const first = await refresh;
    return first || Response.error();
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
