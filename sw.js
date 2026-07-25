// Firebase Messaging SW
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCde38yMmqtxA0RPUivfI1iT5o56ZYqWF0",
  projectId: "peakmarketing-3f3a3",
  messagingSenderId: "901027878178",
  appId: "1:901027878178:web:7c12ebb7c431cef973817b"
});

const messaging = firebase.messaging();

// 백그라운드 푸시 수신
messaging.onBackgroundMessage(payload => {
  const notification = payload.notification || {};
  const data = payload.data || {};
  const title = notification.title || data.title;

  if (!title) return;

  // FCM notification/webpush payload가 이미 있으면 브라우저 기본 표시를 사용하고,
  // data-only 메시지일 때만 수동으로 알림을 띄워 중복 표시를 막는다.
  if (notification.title || notification.body) return;

  self.registration.showNotification(title, {
    body: notification.body || data.body || '',
    icon: notification.icon || '/icon-192.png',
    badge: notification.badge || '/icon-192.png',
    tag: notification.tag || data.tag || undefined,
    renotify: true,
    requireInteraction: true,
    silent: false,
    timestamp: Date.now(),
    actions: [
      { action: 'open', title: '열기' }
    ],
    data: {
      url: data.link || '/'
    }
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin) {
          const normalizedTargetUrl = new URL(targetUrl, self.location.origin);
          if (clientUrl.pathname === normalizedTargetUrl.pathname && clientUrl.search === normalizedTargetUrl.search) {
            return client.focus();
          }
          if ('navigate' in client) {
            return client.navigate(targetUrl).then(navigatedClient => {
              if (navigatedClient && 'focus' in navigatedClient) return navigatedClient.focus();
              return client.focus();
            });
          }
          return client.focus();
        }
      }

      return clients.openWindow(targetUrl);
    })
  );
});

// ── PWA 캐시 ──
// Bump when shipping changes that HAVE to reach every client
// immediately — e.g. checklist completion visibility fix (v21).
// Activate handler purges every non-matching cache, and skipWaiting +
// clients.claim() take over open tabs on next fetch.
const CACHE_NAME = 'peak-marketing-v35';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
