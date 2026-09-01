/* MediCore service worker: installable offline app-shell; the API always uses the network. */
const CACHE = 'medicore-v2';
const SHELL = ['/index.html','/doctor.html','/frontdesk.html','/admin.html','/payer.html',
  '/pharmacy.html','/lab.html','/rider.html','/dispatch.html','/chw.html','/crew.html',
  '/mapkit.js','/refresh.js','/clockkit.js','/clockgate.js','/rtc.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(()=>{})).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/api/')) return;                 // API: network only, never cached
  if (e.request.method !== 'GET') return;
  // network-first so updates always arrive online; fall back to cache offline
  e.respondWith(
    fetch(e.request).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)).catch(()=>{}); return r; })
      .catch(() => caches.match(e.request).then(m => m || caches.match('/index.html')))
  );
});
