// Guarda la página en el celular para que abra aunque no haya datos.
const CACHE = 'checador-v7';
const ARCHIVOS = ['./', 'index.html', 'app.js', 'estilo.css', 'qrcode.js',
  'kiosco.html', 'kiosco.js', 'kiosco.css', 'verif.js', 'kiosco.webmanifest', 'icono-192.png', 'icono-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Primero la red (para recibir actualizaciones); si no hay, lo guardado
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    // no-store: siempre pide a GitHub la versión más nueva (si no hay internet, usa la guardada)
    fetch(e.request, { cache: 'no-store' }).then((r) => {
      const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
