/**
 * middleware/maintenance.js
 * ---------------------------------------------------------------------------
 * maintenance_mode চালু থাকলে সাধারণ ইউজার-facing সব রুটে ৫০৩ Maintenance পেজ
 * দেখানো হয়। নিচের পাথগুলো সবসময় বাদ থাকবে (কখনো ব্লক হবে না):
 *   - /admin*            (অ্যাডমিন প্যানেল — লগইন, 2FA, ড্যাশবোর্ড, সেটিংস সব)
 *   - /payment/sslcommerz/* (পেমেন্ট গেটওয়ে callback — ইউজার সেশন ছাড়াই আসে)
 *   - /telegram-webhook  (Telegram bot webhook)
 *   - /health            (হেলথ-চেক)
 *   - স্ট্যাটিক ফাইল (/public, /uploads)
 *
 * যেকোনো এরর হলে ফেইল-ওপেন (সাইট খোলা থাকবে) — মেইনটেন্যান্স চেক ব্যর্থ হওয়া
 * কখনো পুরো সাইট বন্ধ করে দেওয়ার কারণ হবে না।
 */
const { getSetting } = require('../services/settings');

const ALWAYS_ALLOWED_PREFIXES = [
  '/admin',
  '/payment/sslcommerz/',
  '/telegram-webhook',
  '/public',
  '/uploads',
];
const ALWAYS_ALLOWED_EXACT = ['/health'];

function isAlwaysAllowed(path) {
  if (ALWAYS_ALLOWED_EXACT.includes(path)) return true;
  return ALWAYS_ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix));
}

function maintenanceMiddleware(req, res, next) {
  if (isAlwaysAllowed(req.path)) return next();

  getSetting('maintenance_mode')
    .then(on => {
      if (on !== 'true' && on !== true) return next();
      return res.status(503).render('maintenance', { siteName: 'Livo' });
    })
    .catch(e => {
      console.error('maintenance check error:', e && e.stack ? e.stack : e);
      return next(); // ফেইল-ওপেন
    });
}

module.exports = { maintenanceMiddleware, isAlwaysAllowed };
