self.addEventListener('push', event => {
  if (!event.data) return;
  const { title, body, tag } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, { body, tag, icon: '/icon-192.png' }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url === new URL('/', self.location.origin).href);
    return existing ? existing.focus() : self.clients.openWindow('/');
  })());
});
