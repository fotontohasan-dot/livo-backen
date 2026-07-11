// public/service-worker.js
const CACHE_NAME = 'livo-cache-v1';
const OFFLINE_URL = '/offline.html';

const PRECACHE_ASSETS = [
  '/',
  '/css/style.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  OFFLINE_URL
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        PRECACHE_ASSETS.map((url) => cache.add(url).catch(() => {}))
      );
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // শুধু GET রিকোয়েস্ট ক্যাশ করা হবে; API/POST কল সরাসরি নেটওয়ার্কে যাবে
  if (req.method !== 'GET') return;

  // অ্যাডমিন প্যানেল ও লাইভ ডেটা কখনো ক্যাশ করা হবে না — সবসময় ফ্রেশ
  const url = new URL(req.url);
  if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match(OFFLINE_URL))
      )
  );
});
