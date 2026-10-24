// Service worker: guarda la app para abrirla sin conexión.
// Estrategia "red primero": siempre intenta traer la versión nueva y solo usa la copia guardada si no hay red,
// así nunca se queda atascada una versión vieja. Las llamadas a /api no se guardan.
const VERSION = '__V__'; // el servidor lo sustituye por el id del despliegue
const CACHE = `notas-${VERSION}`;
const SHELL = ['./', 'app.css', 'app.js', 'theme.js', 'store.js', 'sync.js', 'manifest.webmanifest']
  .map((f) => (f === './' ? f : `${f}?v=${VERSION}`))
  .concat(['favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png']);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('./') : Response.error()))
  );
});
