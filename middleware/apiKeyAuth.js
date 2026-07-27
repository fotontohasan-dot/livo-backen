// middleware/apiKeyAuth.js
// Public API-এর জন্য API Key authentication। হেডার থেকে key পড়ে, হ্যাশ মিলিয়ে DB-তে যাচাই করে,
// enabled/expiry/scope চেক করে, এবং req.apiKey সেট করে দেয় (যা apiLogger + rate limiter ব্যবহার করে)।
//
// নিরাপত্তা নোট: DB-তে raw key কখনো সংরক্ষণ করা হয় না, শুধু SHA-256 hash — তাই DB leak হলেও
// আসল key উদ্ধার করা যায় না। key একবারই (তৈরির সময়) দেখানো হয়।

const crypto = require('crypto');
const { pool } = require('../db');

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function requireApiKey(requiredScope) {
  return async function (req, res, next) {
    try {
      const header = req.headers['x-api-key'] || req.headers['authorization'];
      const raw = header && header.startsWith('Bearer ') ? header.slice(7) : header;

      if (!raw) {
        return res.status(401).json({ error: 'unauthorized', message: 'X-API-Key হেডার প্রয়োজন।' });
      }

      const hash = hashKey(raw);
      const result = await pool.query(`SELECT * FROM api_keys WHERE key_hash = $1`, [hash]);
      const key = result.rows[0];

      if (!key) {
        return res.status(401).json({ error: 'unauthorized', message: 'অবৈধ API key।' });
      }
      if (!key.enabled) {
        return res.status(403).json({ error: 'forbidden', message: 'এই API key নিষ্ক্রিয়/revoke করা হয়েছে।' });
      }
      if (key.expires_at && new Date(key.expires_at) < new Date()) {
        return res.status(403).json({ error: 'forbidden', message: 'এই API key-এর মেয়াদ শেষ হয়ে গেছে।' });
      }
      if (requiredScope && !(key.scopes || []).includes(requiredScope)) {
        return res.status(403).json({ error: 'forbidden', message: `এই key-এর "${requiredScope}" scope নেই।` });
      }

      req.apiKey = key;

      // last_used আপডেট — non-blocking, রিকোয়েস্ট আটকায় না
      pool.query(`UPDATE api_keys SET last_used = NOW() WHERE id = $1`, [key.id]).catch(() => {});

      next();
    } catch (err) {
      console.error('[apiKeyAuth] error:', err.message);
      res.status(500).json({ error: 'server_error', message: 'API key যাচাই করতে সমস্যা হয়েছে।' });
    }
  };
}

module.exports = { requireApiKey, hashKey };
