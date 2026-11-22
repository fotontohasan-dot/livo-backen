// services/referralClicks.js
// রেফারেল লিংকের ক্লিক গণনা (GET /register?ref=CODE)। ওয়ালেট/ডিপোজিট/বেটিংয়ের সাথে সম্পর্ক নেই।
// • কাঁচা IP/UA সংরক্ষণ নয় — শুধু HMAC-SHA256 হ্যাশ। • একই দর্শক+রেফারার+দিন = একটাই সারি (ডুপ্লিকেট ক্লিক গোনা হয় না)।
// • লিংক-প্রিভিউ ক্রলার (WhatsApp/Telegram/Facebook ইত্যাদি) ও বট/প্রিফেচ গোনা হয় না; রেফারার নিজের লিংকে ঢুকলেও নয়।
// • ব্যর্থ হলে রেজিস্ট্রেশন পাতা আটকায় না (কলার fire-and-forget)।
const crypto = require('crypto');
const { pool } = require('../db');

const NON_HUMAN_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|facebot|whatsapp|telegram|twitter|discord|curl|wget|python-requests|headless|monitor/i;

function visitorHash(ip, ua) {
  const secret = process.env.SESSION_SECRET || 'referral-click-salt';
  return crypto.createHmac('sha256', secret).update(String(ip || '') + '|' + String(ua || '')).digest('hex');
}

// true = নতুন ক্লিক গোনা হয়েছে; false = বাদ (ডুপ্লিকেট/বট/অবৈধ কোড/নিজের লিংক)
async function recordReferralClick({ code, ip, userAgent, purpose, viewerId }) {
  const ref = String(code == null ? '' : code).trim();
  if (!ref || ref.length > 64) return false;
  const ua = String(userAgent || '');
  if (!ua || NON_HUMAN_UA.test(ua)) return false;
  if (/prefetch|preview/i.test(String(purpose || ''))) return false;
  const r = await pool.query(
    `INSERT INTO referral_clicks (referrer_id, visitor_hash)
     SELECT u.id, $2 FROM users u WHERE u.referral_code = $1 AND u.id IS DISTINCT FROM $3::int
     ON CONFLICT ON CONSTRAINT referral_clicks_dedup DO NOTHING`,
    [ref, visitorHash(ip, ua), Number.isInteger(viewerId) ? viewerId : null]
  );
  return r.rowCount === 1;
}

module.exports = { recordReferralClick, visitorHash };
