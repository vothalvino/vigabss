// =============================================================================
// VigaBSS — Portal Service Worker (§11.5 PWA)
// =============================================================================
// Provides basic offline support (network-first with cache fallback) and
// handles Web Push notifications for outage / billing / ticket events.
// =============================================================================

// Changing the cache name retires every older cache in the activate handler
// below, so existing installations move over cleanly.
const CACHE_NAME = 'vigabss-portal-v3';

// Shell assets to cache on install (Vite build outputs vary; keep minimal)
const PRECACHE_URLS = [
  '/',
  '/portal',
  '/portal/login',
  '/manifest.webmanifest',
  '/icons/vigabss.svg',
];

// ---------------------------------------------------------------------------
// Install — pre-cache shell
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use ignoreSearch to avoid query-string mismatches
      return Promise.allSettled(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => null)),
      );
    }),
  );
  self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Activate — remove old caches
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

// ---------------------------------------------------------------------------
// Fetch — network-first, cache fallback for navigation requests
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Pass through non-GET and API requests
  if (request.method !== 'GET') return;
  if (request.url.includes('/api/')) return;
  // Requests to other sites (map tiles) are left to the browser. Fetching them
  // from here is refused by this site's content security policy
  // (connect-src 'self' governs a worker's fetches, not img-src), and the
  // fallback below then answered every tile with a cached page, so every map
  // had a grey background.
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          // Only a page may fall back to the cached shell. An image, script
          // or style that cannot be fetched must fail as itself, not arrive
          // as an HTML page with status 200.
          if (request.mode === 'navigate') return caches.match('/portal').then((shell) => shell || Response.error());
          return Response.error();
        }),
      ),
  );
});

// ---------------------------------------------------------------------------
// Push — handle Web Push notifications
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'VigaBSS', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'VigaBSS';
  const options = {
    body: data.body || '',
    icon: '/icons/vigabss.svg',
    badge: '/icons/vigabss.svg',
    data: { url: data.url || '/portal' },
    tag: data.tag || 'vigabss',
    requireInteraction: data.requireInteraction || false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ---------------------------------------------------------------------------
// Notification click — open the portal URL
// ---------------------------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/portal';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((c) => c.url.includes('/portal'));
        if (existing) {
          existing.focus();
          existing.navigate(targetUrl);
        } else {
          self.clients.openWindow(targetUrl);
        }
      }),
  );
});
