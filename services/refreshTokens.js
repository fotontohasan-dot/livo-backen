// services/refreshTokens.js
// দীর্ঘমেয়াদী রিফ্রেশ টোকেন — "persistent session" ও silent token refresh-এর ভিত্তি।
//
// নকশা:
//  * ব্রাউজারে যায় একটা র‍্যান্ডম ৩২-বাইট টোকেন (HttpOnly কুকি `livo_rt`); DB-তে যায় শুধু SHA-256 হ্যাশ
//    (utils/tokens.js-এর বিদ্যমান হেল্পার) — DB পড়তে পারলেও টোকেন ফেরত পাওয়া যায় না।
//  * প্রতিবার ব্যবহারে টোকেন রোটেট হয় (পুরনোটা rotated_at পায়, নতুনটা একই family_id-তে ইস্যু হয়)।
//  * Reuse detection: ইতিমধ্যে রোটেট হওয়া টোকেন grace window-এর পরে আবার এলে সেটা চুরির সংকেত —
//    পুরো family বাতিল হয়। grace window (ডিফল্ট ১০ সেকেন্ড) আছে কারণ একই ব্রাউজার থেকে একাধিক
//    প্যারালাল রিকোয়েস্ট একই পুরনো কুকি নিয়ে আসতে পারে — সেটা চুরি নয়।
//  * মেয়াদ: প্রতিটা টোকেনের নিজস্ব মেয়াদ (sliding, ডিফল্ট ৬০ দিন) + family-র একটা absolute সীমা
//    (ডিফল্ট ১৮০ দিন) — মানে কুকি চুরি হলেও অনির্দিষ্টকাল টেকে না।

const crypto = require('crypto');
const { pool } = require('../db');
const { hashToken } = require('../utils/tokens');

const DAY_MS = 24 * 60 * 60 * 1000;

function intEnv(name, fallback, min) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// env কল-টাইমে পড়া হয় — টেস্ট/রানটাইমে বদলানো যায়
function getConfig() {
  return {
    enabled: String(process.env.PERSISTENT_SESSION_ENABLED || 'true').toLowerCase() !== 'false',
    ttlMs: intEnv('REFRESH_TOKEN_TTL_DAYS', 60, 1) * DAY_MS,
    familyMaxMs: intEnv('REFRESH_TOKEN_FAMILY_MAX_DAYS', 180, 1) * DAY_MS,
    rotateAfterMs: intEnv('REFRESH_ROTATE_AFTER_HOURS', 24, 1) * 60 * 60 * 1000,
    reuseGraceMs: intEnv('REFRESH_REUSE_GRACE_SECONDS', 10, 0) * 1000
  };
}

const TOKEN_RE = /^[a-f0-9]{64}$/;

function newRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

function clip(v, n) {
  return v == null ? null : String(v).slice(0, n);
}

/**
 * নতুন টোকেন ইস্যু। familyId না দিলে নতুন family শুরু হয় (নতুন লগইন)।
 * @returns {{ token: string, id: number, familyId: string, expiresAt: Date }}
 */
async function issueToken(userId, meta = {}, db = pool) {
  const cfg = getConfig();
  const token = newRawToken();
  const familyId = meta.familyId || crypto.randomUUID();
  const now = Date.now();
  const familyStartedAt = meta.familyStartedAt ? new Date(meta.familyStartedAt) : new Date(now);
  // sliding মেয়াদ, কিন্তু family-র absolute সীমার বেশি নয়
  const expiresAt = new Date(Math.min(now + cfg.ttlMs, familyStartedAt.getTime() + cfg.familyMaxMs));
  const r = await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, family_started_at, sid, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [userId, hashToken(token), familyId, familyStartedAt, clip(meta.sid, 255), clip(meta.ip, 64), clip(meta.userAgent, 255), expiresAt]
  );
  // সময়ে সময়ে পুরনো সারি পরিষ্কার (আলাদা cron ছাড়াই; ১% ইস্যুতে একবার)
  if (Math.random() < 0.01) purgeExpired().catch(() => {});
  return { token, id: r.rows[0].id, familyId, expiresAt };
}

/**
 * টোকেন যাচাই + রোটেট (একটা ট্রানজ্যাকশনে, সারি লক করে — প্যারালাল রিকোয়েস্টে ডাবল-রোটেশন হয় না)।
 * status:
 *  ok      — রোটেট হয়েছে; token/id/expiresAt নতুন টোকেনের
 *  grace   — টোকেন সদ্য রোটেট হয়েছে (প্যারালাল রিকোয়েস্ট); userId বৈধ, কিন্তু নতুন টোকেন দেওয়া হয়নি
 *  reuse   — অনেক আগে রোটেট হওয়া টোকেন আবার এসেছে → family বাতিল
 *  expired / invalid — বৈধ নয়
 */
async function rotateToken(rawToken, meta = {}) {
  if (typeof rawToken !== 'string' || !TOKEN_RE.test(rawToken)) return { status: 'invalid' };
  const cfg = getConfig();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, user_id, family_id, family_started_at, expires_at, rotated_at, revoked_at
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(rawToken)]
    );
    const row = found.rows[0];
    if (!row || row.revoked_at) {
      await client.query('COMMIT');
      return { status: 'invalid' };
    }

    const now = Date.now();
    if (new Date(row.expires_at).getTime() <= now) {
      await client.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
      await client.query('COMMIT');
      return { status: 'expired' };
    }

    if (row.rotated_at) {
      const age = now - new Date(row.rotated_at).getTime();
      if (age <= cfg.reuseGraceMs) {
        await client.query('COMMIT');
        return { status: 'grace', userId: row.user_id, familyId: row.family_id };
      }
      // চুরির সংকেত: পুরো family বাতিল
      await client.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL', [row.family_id]);
      await client.query('COMMIT');
      return { status: 'reuse', userId: row.user_id, familyId: row.family_id };
    }

    await client.query('UPDATE refresh_tokens SET rotated_at = NOW(), last_used_at = NOW() WHERE id = $1', [row.id]);
    const issued = await issueToken(row.user_id, {
      familyId: row.family_id,
      familyStartedAt: row.family_started_at,
      sid: meta.sid,
      ip: meta.ip,
      userAgent: meta.userAgent
    }, client);
    await client.query('COMMIT');
    return { status: 'ok', userId: row.user_id, familyId: row.family_id, token: issued.token, id: issued.id, expiresAt: issued.expiresAt };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function setSid(tokenId, sid) {
  if (!tokenId || !sid) return;
  await pool.query('UPDATE refresh_tokens SET sid = $1 WHERE id = $2', [clip(sid, 255), tokenId]);
}

async function revokeFamily(familyId) {
  if (!familyId) return 0;
  const r = await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL', [familyId]);
  return r.rowCount || 0;
}

/** কুকির টোকেন থেকে family খুঁজে পুরোটা বাতিল (লগআউট)। */
async function revokeByToken(rawToken) {
  if (typeof rawToken !== 'string' || !TOKEN_RE.test(rawToken)) return 0;
  const r = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE revoked_at IS NULL
        AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
    [hashToken(rawToken)]
  );
  return r.rowCount || 0;
}

async function revokeAllForUser(userId) {
  const r = await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  return r.rowCount || 0;
}

/** "অন্য সব ডিভাইস থেকে লগআউট" — বর্তমান সেশনের (sid) family বাদে বাকি সব। */
async function revokeAllExceptSid(userId, currentSid) {
  const r = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL
        AND family_id NOT IN (
          SELECT family_id FROM refresh_tokens WHERE user_id = $1 AND sid = $2 AND revoked_at IS NULL
        )`,
    [userId, clip(currentSid, 255) || '']
  );
  return r.rowCount || 0;
}

/** নির্দিষ্ট একটি সেশন (ডিভাইস) বাতিল হলে তার family-ও বাতিল। */
async function revokeBySid(userId, sid) {
  if (!sid) return 0;
  const r = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL
        AND family_id IN (SELECT family_id FROM refresh_tokens WHERE user_id = $1 AND sid = $2)`,
    [userId, clip(sid, 255)]
  );
  return r.rowCount || 0;
}

async function purgeExpired() {
  const r = await pool.query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < NOW() - INTERVAL '7 days'
         OR revoked_at < NOW() - INTERVAL '7 days'`
  );
  return r.rowCount || 0;
}

module.exports = {
  getConfig,
  issueToken,
  rotateToken,
  setSid,
  revokeFamily,
  revokeByToken,
  revokeAllForUser,
  revokeAllExceptSid,
  revokeBySid,
  purgeExpired,
  TOKEN_RE
};
