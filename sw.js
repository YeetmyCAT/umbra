// Offline support: everything is fetched from the network first and saved; the saved copy is used when offline.
const APP = 'umbra-app-v28', DATA = 'umbra-data';
const FILES = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'js/main.js', 'js/catalog.js', 'js/tracker.js', 'js/worker.js', 'js/sgp.js', 'js/frames.js', 'js/light.js', 'js/sight.js', 'js/shapes.js', 'js/purpose.js',
  'js/models3d.js', 'js/groundview.js', 'js/spaceview.js', 'js/orbitview.js', 'js/earth.js', 'js/sky.js', 'js/glsl.js', 'js/astro.js', 'js/post.js', 'js/clock.js', 'js/planets.js', 'js/eclipse.js',
  'vendor/three.module.min.js', 'vendor/satellite.min.js', 'vendor/astronomy.browser.min.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'data/stars.json', 'data/stars8.bin', 'data/constlines.json', 'data/milkyway.jpg', 'data/moon.jpg', 'data/earth-day.jpg', 'data/earth-lights.jpg', 'data/earth-aux.jpg', 'data/sun-map.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(APP).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n.startsWith('umbra-app') && n !== APP).map(n => caches.delete(n)))).then(() => self.clients.claim())); });
// Network first for everything (the browser's own HTTP cache makes unchanged files cheap to re-check), so a new
// version always shows on the next load; the saved copies are only used offline. (Cache-first kept old files around
// indefinitely, e.g. the large Earth maps, which were never cleared by a version bump.)
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  const store = /\/data\/(gaia|earth-|catalog)/.test(u.pathname) ? DATA : APP;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(store).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
