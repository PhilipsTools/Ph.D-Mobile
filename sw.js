/* offline shell - hospital wifi is unreliable, the app must work with none */
/* CACHE is rewritten on every publish, from a fingerprint of the files
   themselves, so a phone holding the old app stops matching and refetches. */
const CACHE = 'walkaround-38a017ad';
const FILES = ['index.html','app.js','data.js','questions.json','manifest.json',
               'hospitals.json','mark.png','icon-192.png','icon-512.png',
               'icon-maskable-512.png','apple-touch-icon.png','favicon-32.png'];

/* {cache:'reload'} is the point of this line. Without it these come out of the
   browser's own HTTP cache, which the host tells it to keep for ten minutes -
   long enough that a brand new worker installs the very files it was meant to
   replace, and the app looks like it never updated. */
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(f, {cache: 'reload'}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  /* Same reasoning as install: for the app's own files go past the HTTP cache
     and actually ask the server. They are small, and a stale one of these is
     the difference between the app people are using and the app that was
     published. Anything else is left exactly as it was requested. */
  let req = e.request;
  try {
    const url = new URL(e.request.url);
    const leaf = url.pathname.split('/').pop() || 'index.html';
    if (url.origin === self.location.origin && FILES.indexOf(leaf) >= 0)
      req = new Request(e.request.url, {cache: 'no-store'});
  } catch (err) {}
  e.respondWith(
    fetch(req).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
