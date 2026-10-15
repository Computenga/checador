// El kiosco se dio de baja: este service worker borra lo guardado y se desinstala.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((k) => Promise.all(k.map((n) => caches.delete(n))))
    .then(() => self.registration.unregister())
    .then(() => self.clients.matchAll()).then((cs) => cs.forEach((c) => c.navigate(c.url)))
));
