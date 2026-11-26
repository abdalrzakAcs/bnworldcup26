/* Service Worker — كاش لفتح سريع حتى على نت ضعيف */
const CACHE = 'wc26-v5';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/config.js',
  './js/app.js',
  './manifest.webmanifest',
  './icon.svg',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // طلبات Supabase + Cloudflare: شبكة فقط (بيانات حية + كابتشا)
  if (url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.cloudflare.com')) return;

  // ملفات الموقع + الخطوط + المكتبات: كاش أولاً مع تحديث بالخلفية
  e.respondWith((async () => {
    const cached = await caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' });
    const net = fetch(e.request)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => null);
    const res = cached || (await net);
    if (res) return res;
    if (e.request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    return Response.error();
  })());
});
