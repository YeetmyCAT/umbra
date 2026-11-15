// Offline support: app files cached (bump APP when they change); orbital data always tried from the network first.
const APP = 'umbra-app-v18', DATA = 'umbra-data';
const FILES = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'js/main.js', 'js/catalog.js', 'js/tracker.js', 'js/worker.js', 'js/sgp.js', 'js/frames.js', 'js/light.js', 'js/sight.js', 'js/shapes.js', 'js/purpose.js',
  'js/models3d.js', 'js/groundview.js', 'js/spaceview.js', 'js/orbitview.js', 'js/earth.js', 'js/sky.js', 'js/glsl.js', 'js/astro.js', 'js/post.js', 'js/clock.js', 'js/planets.js', 'js/eclipse.js',
  'vendor/three.module.min.js', 'vendor/satellite.min.js', 'vendor/astronomy.browser.min.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'data/stars.json', 'data/stars8.bin', 'data/constlines.json', 'data/milkyway.jpg', 'data/moon.jpg', 'data/earth-day.jpg', 'data/earth-lights.jpg', 'data/earth-aux.jpg', 'data/sun-map.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(APP).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n.startsWith('umbra-app') && n !== APP).map(n => caches.delete(n)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.endsWith('/data/catalog.json')) {   // network first, cached copy when offline
    e.respondWith(fetch(e.request).then(r => { if (r.ok && e.request.method === 'GET') { const c = r.clone(); caches.open(DATA).then(x => x.put(e.request, c)); } return r; }).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(res => { if (res.ok && /\/data\/gaia/.test(u.pathname)) { const c = res.clone(); caches.open(DATA).then(x => x.put(e.request, c)); } return res; })));
});
