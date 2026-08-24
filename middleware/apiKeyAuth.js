// middleware/apiKeyAuth.js
// Public API-এর জন্য API Key authentication। হেডার থেকে key পড়ে, হ্যাশ মিলিয়ে DB-তে যাচাই করে,
// enabled/expiry/scope চেক করে, এবং req.apiKey সেট করে দেয় (যা apiLogger + rate limiter ব্যবহার করে)।
//
// নিরাপত্তা নোট: DB-তে raw key কখনো সংরক্ষণ করা হয় না, শুধু SHA-256 hash — তাই DB leak হলেও
// আসল key উদ্ধার করা যায় না। key একবারই (তৈরির সময়) দেখানো হয়।

const crypto = require('crypto');
const { pool } = require('../db');
const { tr } = require('../utils/i18n');

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function requireApiKey(requiredScope) {
  return async function (req, res, next) {
    try {
      const header = req.headers['x-api-key'] || req.headers['authorization'];
      const raw = header && header.startsWith('Bearer ') ? header.slice(7) : header;

      if (!raw) {
        return res.status(401).json({ error: 'unauthorized', message: tr(req, 'api_key_header_required') });
      }

      const hash = hashKey(raw);
      const result = await pool.query(`SELECT * FROM api_keys WHERE key_hash = $1`, [hash]);
      const key = result.rows[0];

      if (!key) {
        return res.status(401).json({ error: 'unauthorized', message: tr(req, 'api_key_invalid') });
      }
      if (!key.enabled) {
        return res.status(403).json({ error: 'forbidden', message: tr(req, 'api_key_revoked') });
      }
      if (key.expires_at && new Date(key.expires_at) < new Date()) {
        return res.status(403).json({ error: 'forbidden', message: tr(req, 'api_key_expired') });
      }
      if (requiredScope && !(key.scopes || []).includes(requiredScope)) {
        return res.status(403).json({ error: 'forbidden', message: tr(req, 'api_key_missing_scope').replace('{value}', requiredScope) });
      }

      req.apiKey = key;

      // last_used আপডেট — non-blocking, রিকোয়েস্ট আটকায় না
      pool.query(`UPDATE api_keys SET last_used = NOW() WHERE id = $1`, [key.id]).catch(() => {});

      next();
    } catch (err) {
      console.error('[apiKeyAuth] error:', err.message);
      res.status(500).json({ error: 'server_error', message: tr(req, 'api_key_verify_failed') });
    }
  };
}

module.exports = { requireApiKey, hashKey };
