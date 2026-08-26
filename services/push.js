// services/push.js
// ফোন লক থাকলে বা অ্যাডমিন অন্য কোনো অ্যাপে থাকলেও নোটিফিকেশন (সাউন্ডসহ) পাঠানোর জন্য
// Web Push ব্যবহার করা হয়েছে। এটা Socket.io থেকে সম্পূর্ণ আলাদা সিস্টেম —
// অ্যাডমিন একবার সাবস্ক্রাইব করলে ব্রাউজার/সিস্টেম নিজেই এই push ডেলিভার করে,
// পেজ খোলা থাকা লাগে না।

const webpush = require('web-push');
const { pool } = require('../db');

const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:admin@example.com').trim();

// URL-safe base64 (no '=' padding) — ভুল ফরম্যাটের key ঢুকে গেলে যাতে পুরো অ্যাপ ক্র্যাশ না করে,
// তাই web-push-কে দেওয়ার আগেই নিজে যাচাই করে নেওয়া হচ্ছে
function isValidUrlSafeBase64(str, expectedBytes) {
  if (!str || /[+/=]/.test(str) || !/^[A-Za-z0-9\-_]+$/.test(str)) return false;
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64, 'base64');
    return buf.length === expectedBytes;
  } catch (e) {
    return false;
  }
}

let pushConfigured = false;
if (isValidUrlSafeBase64(VAPID_PUBLIC_KEY, 65) && isValidUrlSafeBase64(VAPID_PRIVATE_KEY, 32)) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushConfigured = true;
  } catch (err) {
    console.error('⚠️ VAPID key সেট করতে গিয়ে সমস্যা হয়েছে — Web Push বন্ধ থাকবে:', err.message);
  }
} else if (VAPID_PUBLIC_KEY || VAPID_PRIVATE_KEY) {
  console.warn('⚠️ VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY ফরম্যাট সঠিক নয় (Render Environment Variables চেক করুন) — Web Push বন্ধ থাকবে।');
} else {
  console.warn('⚠️ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY সেট নেই — Web Push বন্ধ থাকবে।');
}

// ===== সাবস্ক্রিপশন সেভ করা (অ্যাডমিন প্রথমবার পারমিশন দিলে) =====
async function saveSubscription(userId, subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    throw new Error('Invalid subscription payload');
  }
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
    [userId, endpoint, keys.p256dh, keys.auth]
  );
}

// ===== সাবস্ক্রিপশন মুছে ফেলা (লগআউট বা পারমিশন বাতিল হলে) =====
async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

// ===== সব অ্যাডমিনের সব ডিভাইসে পুশ পাঠানো =====
// type: 'deposit' | 'withdraw' | 'chat'
async function sendPushToAdmins(type, title, message) {
  if (!pushConfigured) return;
  try {
    const subs = await pool.query(
      `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
       JOIN users u ON u.id = ps.user_id
       WHERE u.role = 'admin'`
    );
    if (subs.rows.length === 0) return;

    const payload = JSON.stringify({
      type,
      title: title || 'Livo অ্যাডমিন',
      message: message || 'নতুন নোটিফিকেশন',
      url: type === 'deposit' ? '/payment/admin/payments?tab=deposit'
         : type === 'withdraw' ? '/payment/admin/payments?tab=withdraw'
         : type === 'chat' ? '/chat/admin'
         : '/admin/dashboard'
    });

    await Promise.all(subs.rows.map(async (row) => {
      const subscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth }
      };
      try {
        await webpush.sendNotification(subscription, payload);
      } catch (err) {
        // 404/410 মানে সাবস্ক্রিপশন আর বৈধ নেই (ব্রাউজার আনইনস্টল/পারমিশন বাতিল) — মুছে ফেলা হচ্ছে
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query(`DELETE FROM push_subscriptions WHERE id = $1`, [row.id]).catch(() => {});
        } else {
          console.error('web-push send error:', err.message);
        }
      }
    }));
  } catch (err) {
    console.error('sendPushToAdmins error:', err.message);
  }
}

module.exports = { saveSubscription, removeSubscription, sendPushToAdmins, VAPID_PUBLIC_KEY, pushConfigured };
