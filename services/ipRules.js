// services/ipRules.js
// ---------------------------------------------------------------------------
// Bot Detection System-এর IP Block/Whitelist অংশ। অ্যাডমিন প্যানেল থেকে কোনো IP-কে
// ব্লক বা whitelist করা যায়; সব পাবলিক এন্ট্রি-পয়েন্টে (register/login/forgot-password/
// contact-চ্যাট/public API) এই রুল চেক করা হয়। ফলাফল ৩০ সেকেন্ডের জন্য cache.js দিয়ে
// ক্যাশ করা হয় (Redis থাকলে শেয়ার্ড, না থাকলে per-instance) যাতে প্রতি রিকোয়েস্টে DB না ছুঁতে হয়।
// ---------------------------------------------------------------------------

const { pool } = require('../db');
const cache = require('./cache');

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || (req.connection && req.connection.remoteAddress) || '';
}

/** 'block' | 'whitelist' | null রিটার্ন করে */
async function getIpRule(ip) {
  if (!ip) return null;
  try {
    return await cache.getOrSet(`ip_rule:${ip}`, 30, async () => {
      const r = await pool.query('SELECT type FROM ip_rules WHERE ip = $1 LIMIT 1', [ip]);
      return r.rows[0] ? r.rows[0].type : null;
    });
  } catch (e) {
    console.error('getIpRule error:', e.message);
    return null; // fail-open — ভুল করে সবাইকে ব্লক করে দেওয়ার চেয়ে নিরাপদ
  }
}

async function setIpRule(ip, type, reason, createdBy) {
  await pool.query(
    `INSERT INTO ip_rules (ip, type, reason, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ip) DO UPDATE SET type = $2, reason = $3, created_by = $4, created_at = NOW()`,
    [ip, type, reason || null, createdBy || null]
  );
  await cache.del(`ip_rule:${ip}`);
}

async function removeIpRule(ip) {
  await pool.query('DELETE FROM ip_rules WHERE ip = $1', [ip]);
  await cache.del(`ip_rule:${ip}`);
}

async function listIpRules() {
  const r = await pool.query('SELECT * FROM ip_rules ORDER BY created_at DESC');
  return r.rows;
}

module.exports = { getClientIp, getIpRule, setIpRule, removeIpRule, listIpRules };
