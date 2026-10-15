const CACHE_PREFIX = 'team1833-scouting-portal-';
const CACHE = CACHE_PREFIX + 'v5';
const SHELL = ['/scouting/', '/scouting/index.html', '/scouting/styles.css', '/scouting/brand.css', '/scouting/app.js', '/scouting/model.js', '/scouting/manifest.webmanifest', '/scouting/icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache API, portal, logout, admin or unrelated tool requests.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      // A login redirect or forbidden response must never replace the offline shell.
      if (response.ok && !response.redirected) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') return caches.match('/scouting/index.html');
      throw error;
    }
  })());
});
