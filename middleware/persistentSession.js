// middleware/persistentSession.js
// স্থায়ী সেশন + silent token refresh।
//
// দুটো স্তর:
//  ১. সেশন কুকি (express-session, HttpOnly, rolling ৩০ দিন) — আগের মতোই।
//  ২. রিফ্রেশ কুকি `livo_rt` (HttpOnly, Secure(prod), SameSite=Lax, ডিফল্ট ৬০ দিন, রোটেটিং):
//     - সেশন কুকি হারালে/মেয়াদ শেষ হলে (ব্রাউজার ক্লিনআপ, Redis flush, ডিপ্লয়) পরের GET
//       রিকোয়েস্টেই ব্যবহারকারীকে নিঃশব্দে আবার লগইন করানো হয় (পুনরায় পাসওয়ার্ড চাওয়া ছাড়া)।
//     - সেশন বৈধ থাকলেও টোকেন মেয়াদ ফুরানোর অনেক আগে (ডিফল্ট প্রতি ২৪ ঘণ্টায়) ব্যাকএন্ডে
//       নিঃশব্দে নতুন টোকেন ইস্যু হয় — ব্যবহারকারী কিছু টের পায় না।
//
// নিরাপত্তা সিদ্ধান্ত:
//  * অ্যাডমিন অ্যাকাউন্টের জন্য রিফ্রেশ টোকেন কখনো ইস্যু/রিস্টোর হয় না — অ্যাডমিনের জন্য 2FA বাধ্যতামূলক
//    (routes/auth.js completeLogin), রিফ্রেশ কুকি দিয়ে সেটা এড়ানো যেত।
//  * রিস্টোরের সময় ব্যান / সেলফ-এক্সক্লুশন / অস্তিত্ব DB থেকে সরাসরি যাচাই হয় (ক্যাশ নয়)।
//  * রিস্টোর শুধু GET/HEAD-এ — state-changing রিকোয়েস্ট কুকি-নির্ভর রিস্টোরে চলে না (CSRF সারফেস বাড়ে না)।
//  * সেশন আইডি রোটেট হয় (session fixation প্রতিরোধ), রোটেটেড টোকেন পুনর্ব্যবহার = family বাতিল।

const express = require('express');
const { pool } = require('../db');
const refreshTokens = require('../services/refreshTokens');
const { regenerateSession, saveSession } = require('../utils/sessionRegenerate');

const COOKIE_NAME = 'livo_rt';

// যেসব পাথে কুকি দিয়ে রিস্টোর করার মানে হয় না (মেশিন-টু-মেশিন, হেলথ, লগআউট ইত্যাদি)
const NO_RESTORE_PREFIXES = ['/health', '/ready', '/metrics', '/provider/', '/socket.io/', '/wallet-callback/', '/payment/sslcommerz/', '/telegram-webhook', '/logout'];

function isProd() {
  return process.env.NODE_ENV === 'production';
}

function cookieOptions() {
  const { ttlMs } = refreshTokens.getConfig();
  return { httpOnly: true, secure: isProd(), sameSite: 'lax', path: '/', maxAge: ttlMs };
}

function setRefreshCookie(res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

function clearRefreshCookie(res) {
  const { maxAge, ...opts } = cookieOptions();
  res.clearCookie(COOKIE_NAME, opts);
}

function reqMeta(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return { ip: xff || req.ip || '', userAgent: (req.get && req.get('user-agent')) || '', sid: req.sessionID };
}

function stripSecrets(u) {
  const safe = { ...u };
  delete safe.password;
  delete safe.reset_token;
  delete safe.reset_token_expiry;
  return safe;
}

function isAdminRole(user) {
  return !!(user && user.role && String(user.role).toLowerCase() === 'admin');
}

function isRestorablePath(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = req.path || '';
  return !NO_RESTORE_PREFIXES.some((prefix) => {
    const bare = prefix.replace(/\/$/, '');
    return p === bare || p.startsWith(bare + '/');
  });
}

/**
 * লগইন সম্পূর্ণ হওয়ার পর কল হয় (routes/auth.js completeLogin)। অ্যাডমিনের জন্য কিছু করে না।
 * ব্যর্থ হলেও লগইন আটকায় না — সাধারণ সেশন কুকি তো আছেই।
 */
async function issueForLogin(req, res, user) {
  try {
    if (!refreshTokens.getConfig().enabled || !user || isAdminRole(user)) return false;
    const issued = await refreshTokens.issueToken(user.id, reqMeta(req));
    setRefreshCookie(res, issued.token);
    if (req.session) req.session.rtRotatedAt = Date.now();
    return true;
  } catch (err) {
    console.error('[persistent-session] issue error:', err.message);
    return false;
  }
}

/** লগআউট: কুকির টোকেনের পুরো family বাতিল + কুকি মোছা। */
async function revokeForLogout(req, res) {
  try {
    const raw = req.cookies && req.cookies[COOKIE_NAME];
    if (raw) await refreshTokens.revokeByToken(raw);
  } catch (err) {
    console.error('[persistent-session] logout revoke error:', err.message);
  }
  try { clearRefreshCookie(res); } catch (e) { /* headers already sent */ }
}

// সেশন বৈধ আছে; টোকেন "due" হলে নিঃশব্দে রোটেট করে
async function rotateIfDue(req, res, raw, { force = false } = {}) {
  const cfg = refreshTokens.getConfig();
  const last = Number(req.session.rtRotatedAt || 0);
  if (!force && last && Date.now() - last < cfg.rotateAfterMs) return 'fresh';

  const result = await refreshTokens.rotateToken(raw, reqMeta(req));
  // কুকির টোকেন অন্য ইউজারের হলে (একই ব্রাউজারে ইউজার বদল) সেটা এই সেশনে জোড়া লাগানো যাবে না —
  // নইলে সেশন শেষ হলে পরের রিস্টোরে আগের ইউজার হিসেবে ঢুকে যেত।
  if ((result.status === 'ok' || result.status === 'grace') && String(result.userId) !== String(req.session.user.id)) {
    await refreshTokens.revokeFamily(result.familyId).catch(() => {});
    clearRefreshCookie(res);
    return 'mismatch';
  }
  if (result.status === 'ok') {
    setRefreshCookie(res, result.token);
    req.session.rtRotatedAt = Date.now();
    return 'rotated';
  }
  if (result.status === 'grace') return 'fresh'; // প্যারালাল রিকোয়েস্ট নতুন কুকি বসিয়ে দিয়েছে
  clearRefreshCookie(res);
  if (result.status === 'reuse') {
    // চুরির সংকেত — এই সেশনও বিশ্বাসযোগ্য নয়
    console.warn('[persistent-session] refresh token reuse detected', { userId: result.userId });
    await new Promise((resolve) => req.session.destroy(() => resolve()));
    return 'reuse';
  }
  return result.status;
}

// সেশন নেই, কিন্তু বৈধ রিফ্রেশ কুকি আছে → সেশন পুনরুদ্ধার
async function restoreSession(req, res, raw) {
  const result = await refreshTokens.rotateToken(raw, reqMeta(req));
  if (result.status !== 'ok' && result.status !== 'grace') {
    clearRefreshCookie(res);
    if (result.status === 'reuse') console.warn('[persistent-session] refresh token reuse detected', { userId: result.userId });
    return false;
  }

  const u = await pool.query('SELECT * FROM users WHERE id = $1', [result.userId]);
  const user = u.rows[0];
  const selfExcluded = !!(user && user.self_exclude_until && new Date(user.self_exclude_until) > new Date());
  if (!user || user.is_banned || selfExcluded || isAdminRole(user)) {
    await refreshTokens.revokeFamily(result.familyId).catch(() => {});
    clearRefreshCookie(res);
    return false;
  }

  await regenerateSession(req);
  req.session.user = stripSecrets(user);
  req.session.rtRotatedAt = Date.now();
  await saveSession(req);

  if (result.status === 'ok') {
    setRefreshCookie(res, result.token);
    await refreshTokens.setSid(result.id, req.sessionID).catch(() => {});
  }
  return true;
}

async function persistentSessionMiddleware(req, res, next) {
  try {
    if (!refreshTokens.getConfig().enabled || !req.session) return next();
    const raw = req.cookies && req.cookies[COOKIE_NAME];
    if (!raw) return next();

    if (req.session.user) {
      // অ্যাডমিন সেশনে রিফ্রেশ কুকি থাকার কথা নয়; থাকলে (যেমন একই ব্রাউজারে আগের ইউজার) ছুঁয়ো না
      if (!isAdminRole(req.session.user) && isRestorablePath(req)) await rotateIfDue(req, res, raw);
      return next();
    }
    if (!isRestorablePath(req)) return next();
    await restoreSession(req, res, raw);
  } catch (err) {
    // নিঃশব্দ — রিস্টোর ব্যর্থ মানে সাধারণ "লগড-আউট" আচরণ, রিকোয়েস্ট ভাঙবে না
    console.error('[persistent-session] error:', err.message);
  }
  return next();
}

// ==================== POST /auth/refresh ====================
// ক্লায়েন্টের silent keep-alive (public/js/session-keepalive.js)। CSRF-সুরক্ষিত (গ্লোবাল csrfProtection;
// csrf-inject.js হেডার বসায়)। কাজ: সেশন কুকির rolling মেয়াদ বাড়ানো (এই রিকোয়েস্টটাই সেটা করে) +
// রিফ্রেশ টোকেন due হলে রোটেট; পুরনো সেশনে (ডিপ্লয়ের আগে লগইন) টোকেন না থাকলে নতুন ইস্যু।
const router = express.Router();

router.post('/auth/refresh', async (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  const user = req.session && req.session.user;
  if (!user) return res.status(401).json({ ok: false, code: 'NO_SESSION' });

  try {
    const cfg = refreshTokens.getConfig();
    if (!cfg.enabled || isAdminRole(user)) return res.json({ ok: true, persistent: false });

    // ব্যান/এক্সক্লুশন হলে নতুন টোকেন দেওয়া যাবে না (isAuth-এর ক্যাশ ৩০s পর্যন্ত পুরনো হতে পারে, তাই সরাসরি DB)
    const fresh = await pool.query('SELECT is_banned, self_exclude_until FROM users WHERE id = $1', [user.id]);
    const row = fresh.rows[0];
    const excluded = !!(row && row.self_exclude_until && new Date(row.self_exclude_until) > new Date());
    if (!row || row.is_banned || excluded) {
      return res.status(401).json({ ok: false, code: 'NOT_ACTIVE' });
    }

    const raw = req.cookies && req.cookies[COOKIE_NAME];
    let state;
    if (raw) {
      state = await rotateIfDue(req, res, raw);
    } else {
      state = (await issueForLogin(req, res, user)) ? 'issued' : 'skipped';
    }
    if (state === 'reuse') return res.status(401).json({ ok: false, code: 'TOKEN_REUSE' });
    return res.json({ ok: true, persistent: state === 'fresh' || state === 'rotated' || state === 'issued', state });
  } catch (err) {
    console.error('[persistent-session] /auth/refresh error:', err.message);
    return res.status(500).json({ ok: false, code: 'REFRESH_FAILED' });
  }
});

module.exports = {
  persistentSessionMiddleware,
  router,
  issueForLogin,
  revokeForLogout,
  COOKIE_NAME,
  isRestorablePath
};
