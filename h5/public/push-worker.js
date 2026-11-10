self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));

self.addEventListener('push', event => {
  if (!event.data) return;
  const { title, body, tag, path } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, { body, tag, data: path, icon: '/icon-192.png' }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const home = new URL('/', self.location.origin);
    const link = new URL(event.notification.data || '/', home);
    const target = link.origin === home.origin ? link.href : home.href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url === target);
    return existing ? existing.focus() : self.clients.openWindow(target);
  })());
});
