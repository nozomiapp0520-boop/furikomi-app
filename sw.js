/* Service Worker：オフライン表示とプッシュ通知 */
const CACHE = 'furikomi-v1';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // アプリ本体はネット優先、取れなければキャッシュ
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});

self.addEventListener('push', (e) => {
  let data = { title: '振込予定', body: '', url: './' };
  try { data = { ...data, ...e.data.json() }; } catch (_) { if (e.data) data.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: './icons/icon-192.png', badge: './icons/icon-192.png', data: { url: data.url }, tag: data.tag || undefined }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => { const c = cs.find((x) => 'focus' in x); if (c) return c.focus(); return self.clients.openWindow(e.notification.data && e.notification.data.url || './'); }));
});
