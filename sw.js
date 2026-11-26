// Service worker: deixa o app abrir rápido e funcionar sem internet.
const VERSION = 'agenda-v13';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/bridge-script.js', 'js/store.js', 'js/cloud.js', 'js/gcal.js', 'js/ink.js', 'js/utils.js', 'js/config.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // APIs do Google e Firebase: sempre pela rede
  if (/googleapis\.com$|accounts\.google\.com$|firebaseio|firestore/.test(url.hostname) && !url.hostname.startsWith('fonts.')) return;

  // Arquivos do próprio app: rede primeiro (pega atualizações), cache se offline
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
    );
    return;
  }
  // Fontes e bibliotecas (gstatic): cache primeiro
  if (/fonts\.(googleapis|gstatic)\.com|www\.gstatic\.com/.test(url.hostname)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })));
  }
});
