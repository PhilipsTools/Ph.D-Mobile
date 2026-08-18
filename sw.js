/* offline shell - hospital wifi is unreliable, the app must work with none */
/* bump the cache name whenever the shell changes, or phones keep serving the
   old app out of the cache they already have */
const CACHE = 'walkaround-8aa4c4ded0';
const FILES = ['index.html','app.js','data.js','questions.json','manifest.json',
               'hospitals.json','mark.png','icon-192.png','icon-512.png',
               'icon-maskable-512.png','apple-touch-icon.png','favicon-32.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
