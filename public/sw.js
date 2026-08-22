const CACHE = 'kompakt-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.svg', '/icons/icon-512.svg'];
const DEVELOPMENT = location.port && !['80', '443'].includes(location.port);

self.addEventListener('install', event => {
  event.waitUntil((DEVELOPMENT ? Promise.resolve() : caches.open(CACHE).then(cache => cache.addAll(SHELL))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  if (DEVELOPMENT) {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => {
    const fresh = fetch(event.request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => cached || caches.match('/index.html'));
    return cached || fresh;
  }));
});
