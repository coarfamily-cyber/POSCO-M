self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});
self.addEventListener('push', (event) => {
  let payload = { title: '지수 통합 관제 알림', body: '새로운 작업지시 또는 공지사항이 도착했습니다.', url: '/POSCO-M/JISU/' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      payload = Object.assign(payload, parsed);
    }
  } catch (e) {
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './icon-192.png?v=202611151130',
      badge: './icon-192.png?v=202611151130',
      vibrate: [150, 70, 150, 70, 260],
      data: { url: payload.url || '/POSCO-M/JISU/' },
      tag: payload.tag || 'jisu-work-alert',
      renotify: true
    })
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/POSCO-M/JISU/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/POSCO-M/JISU/') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
