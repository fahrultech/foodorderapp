/* FoodOrder PWA + browser-push worker. API payload truth stays server-owned. */
const CACHE_NAME = 'foodorder-storefront-v2';
const APP_SHELL = [
  '/',
  '/cart',
  '/offline',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];
const OFFLINE_NAVIGATION_PATHS = new Set(['/', '/cart', '/offline']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
      // Session 141: the offline shell must HYDRATE, not just paint HTML.
      // Extract every /_next/static asset each cached document references
      // (framework chunks + page chunks, hashed names) and pre-cache them,
      // so the offline receipt-restore island's JS runs with zero network
      // even if the user never visited /offline online while in control.
      const assets = new Set();
      for (const url of APP_SHELL.filter((u) => !/\.[a-z0-9]+$/i.test(u))) {
        const doc = await cache.match(url);
        if (!doc) continue;
        const html = await doc.text();
        for (const ref of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)) {
          assets.add(ref[1]);
        }
      }
      await Promise.allSettled([...assets].map((url) => cache.add(url)));
    })(),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    if (!OFFLINE_NAVIGATION_PATHS.has(url.pathname)) {
      event.respondWith(fetch(request).catch(() => caches.match('/offline')));
      return;
    }

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || caches.match(url.pathname) || caches.match('/offline')),
    );
    return;
  }

  const cacheableAsset =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest';
  if (!cacheableAsset) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      });
    }),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'FoodOrder', body: 'Your order has an update.', url: '/' };
  }

  const title = typeof payload.title === 'string' ? payload.title : 'FoodOrder';
  const body = typeof payload.body === 'string' ? payload.body : 'Your order has an update.';
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/';
  const tag = typeof payload.tag === 'string' ? payload.tag : 'foodorder-order-update';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url === target);
      if (existing) return existing.focus();
      return self.clients.openWindow(target);
    }),
  );
});
