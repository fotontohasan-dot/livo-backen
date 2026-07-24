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
/**
 * middleware/maintenance.js
 * ---------------------------------------------------------------------------
 * maintenance_mode চালু থাকলে সাধারণ ইউজার-facing সব রুটে ৫০৩ Maintenance পেজ
 * দেখানো হয়। নিচের ক্ষেত্রে কখনো ব্লক হবে না:
 *   - /admin* পাথ            (অ্যাডমিন প্যানেল — লগইন, 2FA, ড্যাশবোর্ড, সেটিংস সব)
 *   - লগইন করা অ্যাডমিন সেশন  (session-এ role='admin' থাকলে যেকোনো পাথে — যাতে
 *                              অ্যাডমিন সাধারণ ইউজার-facing সাইটও স্বাভাবিকভাবে
 *                              ব্রাউজ করতে পারে মেইনটেন্যান্সের সময়ও)
 *   - Allowed IP লিস্টে থাকা IP (settings-এ কমা-সেপারেটেড, IPv4/IPv6)
 *   - Emergency Bypass Token (?maintenance_bypass=TOKEN দিয়ে একবার পাস করলে
 *                              সাইনড কুকিতে মনে রাখা হয়, বারবার টোকেন লাগবে না)
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
const BYPASS_COOKIE = 'mnt_bypass';

function isAlwaysAllowed(path) {
  if (ALWAYS_ALLOWED_EXACT.includes(path)) return true;
  return ALWAYS_ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix));
}

// req.ip প্রক্সির পিছনে থাকলেও (Render ইত্যাদি) app.js-এ 'trust proxy' সেট করা থাকলে সঠিক ক্লায়েন্ট IP দেয়
function isIpAllowed(reqIp, allowedIpsCsv) {
  if (!allowedIpsCsv) return false;
  const clean = String(reqIp || '').replace(/^::ffff:/, ''); // IPv4-mapped IPv6 normalize
  const list = allowedIpsCsv.split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(clean) || list.includes(reqIp);
}

async function maintenanceMiddleware(req, res, next) {
  if (isAlwaysAllowed(req.path)) return next();

  // লগইন করা অ্যাডমিন — সাইট স্বাভাবিকভাবে ব্যবহার করতে পারবে
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();

  try {
    const on = await getSetting('maintenance_mode');
    if (on !== 'true' && on !== true) return next();

    const [message, eta, allowedIps, bypassToken] = await Promise.all([
      getSetting('maintenance_message'),
      getSetting('maintenance_eta'),
      getSetting('maintenance_allowed_ips'),
      getSetting('maintenance_bypass_token'),
    ]);

    // Emergency Bypass Token — query param দিয়ে একবার পাস করলে কুকিতে সেভ থাকবে
    if (bypassToken) {
      const queryToken = req.query.maintenance_bypass;
      if (queryToken && queryToken === bypassToken) {
        res.cookie(BYPASS_COOKIE, bypassToken, {
          maxAge: 12 * 60 * 60 * 1000, // ১২ ঘণ্টা
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
        });
        return next();
      }
      if (req.cookies && req.cookies[BYPASS_COOKIE] === bypassToken) return next();
    }

    // Allowed IP লিস্ট
    if (isIpAllowed(req.ip, allowedIps)) return next();

    return res.status(503).render('maintenance', {
      siteName: 'Livo',
      message: message || 'আমরা সেবার মান উন্নত করার কাজ করছি। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।',
      eta: eta || '',
    });
  } catch (e) {
    console.error('maintenance check error:', e && e.stack ? e.stack : e);
    return next(); // ফেইল-ওপেন
  }
}

module.exports = { maintenanceMiddleware, isAlwaysAllowed, isIpAllowed };
