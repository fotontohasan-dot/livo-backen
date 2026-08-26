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

// ===== Web Push হ্যান্ডলার =====
// ফোন লক থাকলে বা ব্রাউজার/অ্যাপ ব্যাকগ্রাউন্ডে থাকলেও এই ইভেন্ট ট্রিগার হয়
// (এটা সার্ভিস ওয়ার্কারের নিজস্ব প্রসেস, পেজ খোলা থাকা লাগে না) — এখান থেকেই
// সিস্টেম নোটিফিকেশন (আইকন, সাউন্ড, ভাইব্রেশন সহ) দেখানো হয়।
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}

  const LABELS = {
    deposit: 'নতুন ডিপোজিট রিকোয়েস্ট',
    withdraw: 'নতুন উইথড্র রিকোয়েস্ট',
    chat: 'নতুন সাপোর্ট মেসেজ'
  };

  const title = data.title || LABELS[data.type] || 'Livo অ্যাডমিন';
  const options = {
    body: data.message || 'নতুন নোটিফিকেশন এসেছে',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [150, 60, 150, 60, 150],
    tag: 'livo-admin-alert', // একই টাইপের একাধিক নোটিফিকেশন স্ট্যাক না হয়ে আপডেট হবে
    renotify: true,
    data: { url: data.url || '/admin/dashboard' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// নোটিফিকেশনে ট্যাপ করলে সরাসরি সংশ্লিষ্ট অ্যাডমিন পেজে নিয়ে যাওয়া
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin/dashboard';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (clients.length > 0 && 'focus' in clients[0]) {
        clients[0].navigate(url);
        return clients[0].focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // শুধু GET রিকোয়েস্ট ক্যাশ করা হবে; API/POST কল সরাসরি নেটওয়ার্কে যাবে
  if (req.method !== 'GET') return;

  // ব্যক্তিগত/প্রমাণীকৃত পেইজ কখনো ক্যাশ করা হবে না।
  //
  // আগে শুধু /admin, /api আর /socket.io বাদ দেওয়া হতো। ফলে /profile,
  // /wallet, /payment, /kyc, /history — সব ব্যক্তিগত পেইজ ক্যাশে জমা হতো।
  // দুটো সমস্যা: (১) শেয়ার করা ডিভাইসে লগ-আউটের পরও আগের ইউজারের ব্যালেন্স,
  // লেনদেন ও KYC তথ্য ক্যাশ থেকে দেখা যেত; (২) ক্যাশ করা পেইজে পুরনো CSRF
  // টোকেন থাকায় ফর্ম সাবমিট ব্যর্থ হতো।
  const url = new URL(req.url);

  // অন্য অরিজিনের রিকোয়েস্ট আমাদের ক্যাশে ঢুকবে না
  if (url.origin !== self.location.origin) return;

  const PRIVATE_PREFIXES = [
    '/admin', '/api', '/socket.io',
    '/profile', '/wallet', '/payment', '/payments', '/kyc',
    '/history', '/transactions', '/withdraw', '/deposit',
    '/games', '/bets', '/notifications', '/chat',
    '/login', '/register', '/reset-password', '/verify-email', '/logout'
  ];
  if (PRIVATE_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) {
    return;
  }

  // সার্ভার নিজে no-store বললে সেটাই চূড়ান্ত — প্রিফিক্স তালিকা ভবিষ্যতে
  // অসম্পূর্ণ থাকলেও এই যাচাইটা ধরে ফেলবে।
  const cacheControl = req.headers.get('Cache-Control') || '';
  if (cacheControl.includes('no-store')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // রেসপন্স নিজে no-store/private বললে ক্যাশ করা হবে না — এটা শেষ প্রতিরক্ষা,
        // কারণ কোন পেইজ ব্যক্তিগত সেটা সার্ভারই সবচেয়ে ভালো জানে।
        const resCacheControl = res.headers.get('Cache-Control') || '';
        const cacheable = res.ok
          && res.type === 'basic'
          && !resCacheControl.includes('no-store')
          && !resCacheControl.includes('private');
        if (cacheable) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || caches.match(OFFLINE_URL))
      )
  );
});
