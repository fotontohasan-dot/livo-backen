// routes/api.js
// পাবলিক API (v1) — বাইরের ক্লায়েন্ট/পার্টনারদের জন্য, API Key দিয়ে সুরক্ষিত।
// প্রতিটা এন্ডপয়েন্ট read-only (GET) — এখনো কোনো write/mutating public endpoint ইচ্ছাকৃতভাবে যোগ করা হয়নি।

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const cache = require('../services/cache');
const { apiUsageLogger } = require('../middleware/apiLogger');
const { requireApiKey } = require('../middleware/apiKeyAuth');
const RedisRateLimitStore = require('../services/redisRateLimitStore');

// ==================== গ্লোবাল সেফটি নেট ====================
// key-নির্দিষ্ট rate limit এর আগে একটা IP-ভিত্তিক ঢিলা কড়া লিমিট, যাতে key ছাড়া/অবৈধ key দিয়ে spam করা না যায়
const globalIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: (req) => ({ error: 'rate_limited', message: req.t('api_rate_limited') }),
  store: new RedisRateLimitStore('rl:api:ip:')
});

// key-নির্দিষ্ট rate limit — প্রতিটা API key-এর নিজস্ব কোটা (IP পাল্টালেও same key = same কোটা)
const perKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.apiKey ? `key:${req.apiKey.id}` : req.ip),
  message: (req) => ({ error: 'rate_limited', message: req.t('api_key_rate_limit_exceeded') }),
  store: new RedisRateLimitStore('rl:api:key:')
});

router.use(globalIpLimiter);
router.use(apiUsageLogger); // প্রতিটা রিকোয়েস্ট api_usage_logs টেবিলে লগ হয় (non-blocking)

// ==================== রিকোয়েস্ট ভ্যালিডেশন হেল্পার ====================
function validatePagination(req, res, next) {
  const limit = parseInt(req.query.limit) || 20;
  const offset = parseInt(req.query.offset) || 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: 'invalid_request', message: req.t('api_limit_range') });
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return res.status(400).json({ error: 'invalid_request', message: req.t('api_offset_negative') });
  }
  req.pagination = { limit, offset };
  next();
}

// ==================== v1 এন্ডপয়েন্ট ====================

// GET /api/v1/matches — scope: read:matches
router.get('/v1/matches', requireApiKey('read:matches'), perKeyLimiter, validatePagination, async (req, res) => {
  try {
    const { limit, offset } = req.pagination;
    const status = ['upcoming', 'live', 'completed'].includes(req.query.status) ? req.query.status : null;

    const data = await cache.getOrSet(`api:matches:${status || 'all'}:${limit}:${offset}`, 30, async () => {
      const conditions = [];
      const params = [];
      if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit, offset);
      const result = await pool.query(
        // 'result' নামে matches টেবিলে কোনো কলাম নেই (স্কিমা: score_a/score_b) — আগে এই
        // ক্যোয়ারিটাই "column \"result\" does not exist" দিয়ে ব্যর্থ হতো, ফলে এই পাবলিক
        // এন্ডপয়েন্ট সবসময় 500 ফেরত দিত। আসল স্কোর কলাম দুটোই ফলাফল হিসেবে দেওয়া হচ্ছে।
        `SELECT id, title, team_a, team_b, sport, status, start_time, score_a, score_b
         FROM matches ${where}
         ORDER BY start_time DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      return result.rows;
    });

    res.json({ data, pagination: { limit, offset, count: data.length } });
  } catch (err) {
    console.error('[api] /v1/matches error:', err.message);
    res.status(500).json({ error: 'server_error', message: req.t('api_matches_fetch_failed') });
  }
});

// GET /api/v1/leaderboard — scope: read:leaderboard
router.get('/v1/leaderboard', requireApiKey('read:leaderboard'), perKeyLimiter, validatePagination, async (req, res) => {
  try {
    const { limit, offset } = req.pagination;
    const data = await cache.getOrSet(`api:leaderboard:${limit}:${offset}`, 45, async () => {
      const result = await pool.query(
        // 'predictions' নামে কোনো টেবিল নেই — বাজির টেবিলটার নাম 'bets' (routes/profile.js,
        // routes/adminLeaderboard.js একই টেবিল ব্যবহার করে)। আগে এই সাব-ক্যোয়ারি দুটোর জন্যই
        // এন্ডপয়েন্টটা সবসময় 500 দিত।
        `SELECT id, username, avatar, total_points,
                (SELECT COUNT(*) FROM bets WHERE user_id=users.id AND status='won') as wins,
                (SELECT COUNT(*) FROM bets WHERE user_id=users.id) as total_bets
         FROM users
         WHERE role='user' AND is_banned=false
         ORDER BY total_points DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return result.rows;
    });

    res.json({ data, pagination: { limit, offset, count: data.length } });
  } catch (err) {
    console.error('[api] /v1/leaderboard error:', err.message);
    res.status(500).json({ error: 'server_error', message: req.t('api_leaderboard_fetch_failed') });
  }
});

// GET /api/v1/tournaments — scope: read:tournaments
router.get('/v1/tournaments', requireApiKey('read:tournaments'), perKeyLimiter, validatePagination, async (req, res) => {
  try {
    const { limit, offset } = req.pagination;
    const data = await cache.getOrSet(`api:tournaments:${limit}:${offset}`, 60, async () => {
      const result = await pool.query(
        `SELECT id, name, sport, status, start_date, end_date
         FROM tournaments
         ORDER BY start_date DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return result.rows;
    });

    res.json({ data, pagination: { limit, offset, count: data.length } });
  } catch (err) {
    console.error('[api] /v1/tournaments error:', err.message);
    res.status(500).json({ error: 'server_error', message: req.t('api_tournaments_fetch_failed') });
  }
});

// GET /api/v1/status — key ছাড়াই অ্যাক্সেসযোগ্য health/version endpoint (কোনো সংবেদনশীল ডেটা নেই)
router.get('/v1/status', (req, res) => {
  res.json({ status: 'ok', version: 'v1', time: new Date().toISOString() });
});

module.exports = router;
