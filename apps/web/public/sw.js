/* FoodOrder browser-push worker. Payload truth is produced by the API. */
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
