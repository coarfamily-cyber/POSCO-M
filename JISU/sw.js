/* jisu-sw 202611210935 — 알림 클릭: ?openPhoto=구역:사진id 는 사진 확대창을 바로 연다 */
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
    Promise.all([
      self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: './icon-192.png?v=202611151130',
        badge: './icon-192.png?v=202611151130',
        vibrate: [150, 70, 150, 70, 260],
        data: { url: payload.url || '/POSCO-M/JISU/' },
        tag: payload.tag || 'jisu-work-alert',
        renotify: true
      }),
      (typeof navigator !== 'undefined' && typeof navigator.setAppBadge === 'function')
        ? navigator.setAppBadge(typeof payload.badge === 'number' && payload.badge > 0 ? payload.badge : 1).catch(() => {})
        : Promise.resolve()
    ])
  );
});
/* 사진 알림을 눌렀을 때: 이미 열린 관리자 창에 'JISU_OPEN_PHOTO' 를 보내 사진을 바로 띄운다.
   창이 그 메시지를 못 받으면(예전 화면) 그 창을 사진 주소로 이동시킨다. */
function openPhotoInClient(client, targetUrl, openPhoto) {
  /* 사진 알림이 아니면 예전처럼 창만 앞으로 가져온다 */
  if (!openPhoto) {
    return ('focus' in client) ? Promise.resolve(client.focus()).catch(() => true) : Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let acked = false;
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { acked = true; };
      client.postMessage({ type: 'JISU_OPEN_PHOTO', openPhoto: openPhoto, url: targetUrl }, [ch.port2]);
    } catch (_) {}
    const focus = ('focus' in client) ? Promise.resolve(client.focus()).catch(() => {}) : Promise.resolve();
    focus.then(() => {
      setTimeout(() => {
        if (acked) return resolve(true);
        if (client.navigate) {
          client.navigate(targetUrl).then(() => resolve(true)).catch(() => resolve(true));
        } else {
          resolve(true);
        }
      }, 900);
    });
  });
}
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || '/POSCO-M/JISU/';
  let targetUrl = new URL(rawUrl, self.location.origin).href;
  // 다른 사이트로 가는 알림 클릭은 막고 기본 페이지로 연다
  if (new URL(targetUrl).origin !== self.location.origin) targetUrl = new URL('/POSCO-M/JISU/', self.location.origin).href;
  const target = new URL(targetUrl);
  const targetZone = target.searchParams.get('zone');
  const openPhoto = target.searchParams.get('openPhoto') || '';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (!client.url.includes('/POSCO-M/JISU/') || !('focus' in client)) continue;
        const cz = new URL(client.url).searchParams.get('zone');
        /* 사진 알림은 관리자 화면(?zone= 없는 창)에서만 연다. 구역 작업자 창에는 띄우지 않는다. */
        if (openPhoto ? !cz : (targetZone ? cz === targetZone : !cz)) {
          return openPhotoInClient(client, targetUrl, openPhoto);
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
