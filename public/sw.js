/* MediCore service worker: app shell works offline; the API is never cached. */
const CACHE = 'medicore-v2.5.0';
const SHELL = ['/assets/mc.css', '/assets/mc.js', '/assets/fonts/atkinson-hyperlegible-latin-400-normal.woff2', '/assets/fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  '/index.html', '/register.html', '/frontdesk.html', '/doctor.html', '/pharmacy.html', '/rider.html', '/dispatch.html', '/crew.html', '/lab.html', '/chw.html', '/payer.html', '/admin.html', '/group.html', '/hq.html',
  '/apps/patient.js', '/apps/register.js', '/apps/frontdesk.js', '/apps/doctor.js', '/apps/pharmacy.js', '/apps/rider.js', '/apps/dispatch.js', '/apps/crew.js', '/apps/lab.js', '/apps/chw.js', '/apps/payer.js', '/apps/admin.js', '/apps/group.js', '/assets/referrals.js', '/assets/whatsapp.js', '/assets/caretools.js', '/assets/patient-market.js', '/apps/hq-config.js', '/apps/hq.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || u.pathname.startsWith('/api/') || e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(m => m || new Response('<!doctype html><meta charset=utf-8><title>Offline</title><p style="font-family:sans-serif;padding:24px">You are offline and this page has not been saved on this device yet. Connect to the internet and try again.</p>', { headers: { 'Content-Type': 'text/html' } }))));
});
