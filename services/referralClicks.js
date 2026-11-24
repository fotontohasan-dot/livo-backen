// ক্লিক→সাইন-আপ→ডিপোজিট ফানেল: ক্লিক রেকর্ড। কাঁচা IP/UA কোথাও সংরক্ষণ হয় না — শুধু HMAC-SHA256 হ্যাশ।
const crypto = require('crypto');
const { pool } = require('../db');

const CRAWLER_UA = /bot|crawl|spider|slurp|facebookexternalhit|facebot|preview|curl|wget|python|scrapy|headless|phantom|selenium|puppeteer|playwright|libwww|httpclient|okhttp|axios|node-fetch|go-http-client|java\/|ruby|perl|lighthouse|pingdom|uptime|monitor/i;
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

function secret() {
  return process.env.REFERRAL_CLICK_SECRET || process.env.SESSION_SECRET || '';
}

function visitorHash(ip, userAgent) {
  return crypto.createHmac('sha256', secret()).update(`${ip || ''}|${userAgent || ''}`).digest('hex');
}

function isCrawler(userAgent) {
  const ua = String(userAgent || '').trim();
  return !ua || CRAWLER_UA.test(ua);
}

/**
 * ক্লিক রেকর্ড। কখনো throw করে না। রিটার্ন: 'recorded' | 'duplicate' | 'skipped' | 'error'
 */
async function recordReferralClick({ code, ip, userAgent, viewerUserId }) {
  try {
    if (typeof code !== 'string' || !CODE_RE.test(code)) return 'skipped';
    if (isCrawler(userAgent)) return 'skipped';
    if (!secret()) return 'skipped';
    const ref = await pool.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (!ref.rows[0]) return 'skipped';
    const referrerId = ref.rows[0].id;
    if (viewerUserId && Number(viewerUserId) === Number(referrerId)) return 'skipped';
    const r = await pool.query(
      `INSERT INTO referral_clicks (referrer_user_id, visitor_hash, click_day)
       VALUES ($1, $2, (NOW() AT TIME ZONE 'Asia/Dhaka')::date)
       ON CONFLICT (referrer_user_id, visitor_hash, click_day) DO NOTHING`,
      [referrerId, visitorHash(ip, userAgent)]
    );
    return r.rowCount === 1 ? 'recorded' : 'duplicate';
  } catch (e) {
    console.error('recordReferralClick error:', e.message);
    return 'error';
  }
}

/** শুধু নিজের (userId) ফানেল: ক্লিক, সাইন-আপ, অন্তত একটি approved ডিপোজিট। */
async function getReferralFunnel(userId) {
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM referral_clicks WHERE referrer_user_id = $1) AS clicks,
       (SELECT COUNT(*) FROM referrals WHERE referrer_id = $1) AS signups,
       (SELECT COUNT(DISTINCT rf.referred_id) FROM referrals rf
          JOIN payment_requests pr ON pr.user_id = rf.referred_id
         WHERE rf.referrer_id = $1 AND pr.type = 'deposit' AND pr.status = 'approved') AS deposits`,
    [userId]
  );
  const row = r.rows[0] || {};
  return { clicks: Number(row.clicks) || 0, signups: Number(row.signups) || 0, deposits: Number(row.deposits) || 0 };
}

module.exports = { recordReferralClick, getReferralFunnel, visitorHash, isCrawler };
