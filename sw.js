// sw.js — Service worker: cachea el app shell y Chart.js para uso offline.
// IMPORTANTE: sube VERSION en cada publicación para que los iPhone descarguen la nueva versión.
const VERSION = '1.0.4';
const CACHE = `gastos-${VERSION}`;
const CHART_URL = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'sync.js', 'charts.js', 'utils.js', 'csv.js',
  'manifest.json', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([
    // cache: 'reload' evita guardar copias antiguas de la caché HTTP de GitHub Pages.
    ...SHELL.map((url) => new Request(url, { cache: 'reload' })),
    new Request(CHART_URL, { mode: 'cors' }),
  ])));
});

// Borra cachés de versiones anteriores y toma el control.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('gastos-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') event.ports[0]?.postMessage(VERSION);
});

// Cache-first para el app shell y Chart.js; el resto (Apps Script) va siempre a la red.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && url.href !== CHART_URL) return;

  if (req.mode === 'navigate') {
    event.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((cached) => cached || fetch(req).then((res) => {
    if (res.ok && sameOrigin) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  })));
});
