const express = require('express');
const { buildUrl, getBaseUrl } = require('../utils/publicUrl');
const { issueToken, hashToken } = require('../utils/tokens');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { normalizeEmail, normalizeUsername, normalizePhone, normalizeIdentifier } = require('../utils/identity');
// অস্তিত্বহীন ইউজারের ক্ষেত্রে bcrypt.compare() একদমই না চালালে (শুধু `!user ||` শর্ট-সার্কিটে থেমে গেলে)
// রেসপন্স প্রায় তাৎক্ষণিক আসে, কিন্তু ভুল পাসওয়ার্ড দিলে পুরো bcrypt cost (~৫০-১০০ms) লাগে — যদিও
// এরর মেসেজ দুই ক্ষেত্রেই এক, এই টাইমিং পার্থক্য দিয়েই ইমেইল/ফোন অস্তিত্ব যাচাই (এনিউমারেশন) করা যায়।
// তাই ইউজার না থাকলেও একটা ডামি হ্যাশের বিপরীতে bcrypt.compare() চালানো হয়, যাতে দুই পথের সময়
// প্রায় সমান থাকে।
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('dummy-password-for-constant-time-compare', 10);
const rateLimit = require('express-rate-limit');
const { logEvent: logAuditEvent } = require('../services/auditLog');
const { pool } = require('../db');
const { createReferral } = require('../services/referral');
const { sendQueuedEmail } = require('../services/email');
const { scanRegistration, scanFailedLogin, scanLogin, isAccountThrottled } = require('../services/fraudDetection');
const { evaluateDuplicateAccount } = require('../services/duplicateDetection');
const { checkIp } = require('../services/vpnDetection');
const { evaluateRequest, generateCaptcha, verifyCaptcha, logBotEvent } = require('../services/botDetection');
const { getIpRule } = require('../services/ipRules');
const { recordDeviceLogin, parseUserAgent, revokeAllOtherSessions } = require('../services/deviceTracking');
const cache = require('../services/cache');
const RedisRateLimitStore = require('../services/redisRateLimitStore');
const googleAuth = require('../services/googleAuth');
const { regenerateSession, saveSession } = require('../utils/sessionRegenerate');

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: (req) => req.t('common_rate_limited_15m'),
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:reset:')
});

const verifyResendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: (req) => req.t('common_rate_limited_15m'),
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:verifyresend:')
});

// Google OAuth redirect/callback — pre-authentication, তাই IP-ভিত্তিক রেট-লিমিট (ব্রুটফোর্স/abuse ঠেকাতে)
const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: (req) => req.t('common_rate_limited_15m'),
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore('rl:googleoauth:')
});

// ইউজার-সাইড ইভেন্ট (রেজিস্ট্রেশন, ভেরিফিকেশন) admin_logs টেবিলেই লগ হয়, যাতে
// অ্যাডমিন প্যানেলের বিদ্যমান Activity Log-এই (ফিল্টার/সার্চ/CSV export সহ) দেখা যায়
async function logSystemEvent(userId, username, actionType, details, ip = null) {
  try {
    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action_type, details, ip_address) VALUES ($1, $2, $3, $4, $5)`,
      [userId, username, actionType, details, ip]
    );
  } catch (e) {
    console.error('logSystemEvent error:', e.message);
  }
}

async function issueVerificationToken(userId) {
  // ডাটাবেসে যায় শুধু হ্যাশ, ইমেইলে যায় আসল টোকেন — utils/tokens.js দেখুন।
  const { token, tokenHash } = issueToken();
  const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // ২৪ ঘণ্টা
  await pool.query(
    'UPDATE users SET verification_token = $1, verification_token_expiry = $2, last_verification_sent_at = NOW() WHERE id = $3',
    [tokenHash, expiry, userId]
  );
  return token;
}

function getReqIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
}

function sanitizeUser(u) {
  if (!u) return null;
  const safe = { ...u };
  delete safe.password;
  delete safe.reset_token;
  delete safe.reset_token_expiry;
  return safe;
}

async function recordLogin(req, userId, vpnInfo = null) {
  let loginLogId = null;
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const ua = req.get('user-agent') || '';
    // ডিভাইস ফিঙ্গারপ্রিন্ট ঐচ্ছিক — ফ্রন্টএন্ড পাঠালে ব্যবহার হয়, না পাঠালে fraud check শুধু IP/UA দিয়ে চলে
    const deviceFingerprint = req.headers['x-device-fingerprint'] || req.body?.device_fingerprint || null;
    await pool.query(
      `UPDATE users SET last_login = NOW(), last_ip = $1, last_device = $2, login_count = COALESCE(login_count,0) + 1 WHERE id = $3`,
      [ip, ua, userId]
    );
    const inserted = await pool.query(
      `INSERT INTO login_logs (user_id, ip, user_agent, device_fingerprint, is_vpn, is_proxy, is_tor, is_hosting, ip_risk_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [userId, ip, ua, deviceFingerprint,
        !!(vpnInfo && vpnInfo.isVpn), !!(vpnInfo && vpnInfo.isProxy), !!(vpnInfo && vpnInfo.isTor), !!(vpnInfo && vpnInfo.isHosting),
        (vpnInfo && vpnInfo.riskScore) || 0]
    );
    loginLogId = inserted.rows[0]?.id || null;
  } catch (e) {
    console.error('recordLogin error:', e.message);
  }
  return {
    ip: (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
    deviceFingerprint: req.headers['x-device-fingerprint'] || req.body?.device_fingerprint || null,
    loginLogId
  };
}

router.get('/', async (req, res) => {
  try {
    let dbGames = [];
    try {
      dbGames = await cache.getOrSet('homepage:games', 60, async () => {
        const gamesResult = await pool.query(
          `SELECT name, slug, emoji, category AS type, provider, badge
           FROM games WHERE is_active = true ORDER BY sort_order ASC, id ASC`
        );
        return gamesResult.rows;
      });
    } catch (gErr) {
      console.error('Homepage games fetch error:', gErr.message);
      dbGames = [];
    }
    // কোন গেম আসলে খেলা যায় সেটা সার্ভারই বলে দেয় — লবি নিজে অনুমান করে না।
    // লজিক না থাকা গেম কার্ডে "শীঘ্রই" ব্যাজ পায় এবং ক্লিক করা যায় না।
    const playableSlugs = require('../services/gameRegistry').playableSlugs();
    res.render('index', { user: req.session.user || null, dbGames, playableSlugs });
  } catch (err) {
    console.error('Error rendering index:', err);
    res.status(500).send('Render Error');
  }
});

// ==================== রেফারেল কোড জেনারেশন (কলিশন-সেফ) ====================
// কোড = ইউজারনেমের প্রথম ৪ অক্ষর (পড়তে সহজ রাখার জন্য, আগের ফরম্যাটের সাথে সামঞ্জস্যপূর্ণ)
// + crypto.randomBytes থেকে নেওয়া ৬ ক্যারেক্টার base32-সদৃশ সাফিক্স। বিভ্রান্তিকর অক্ষর
// (O/0, I/1) বাদ দেওয়া হয়েছে যাতে ইউজার হাতে টাইপ করতে ভুল না করে।
const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ৩২টা ক্যারেক্টার
const REFERRAL_CODE_SUFFIX_LEN = 6; // ৩২^৬ ≈ ১০৭ কোটি সম্ভাবনা প্রতি প্রিফিক্সে
const REFERRAL_CODE_MAX_ATTEMPTS = 5;

function generateReferralCode(username) {
  const prefix = String(username || 'USER').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'USER';
  const bytes = crypto.randomBytes(REFERRAL_CODE_SUFFIX_LEN);
  let suffix = '';
  for (let i = 0; i < REFERRAL_CODE_SUFFIX_LEN; i++) {
    suffix += REFERRAL_CODE_ALPHABET[bytes[i] % REFERRAL_CODE_ALPHABET.length];
  }
  return prefix + suffix;
}

/**
 * insertFn(code) কল করে ইউজার ইনসার্ট করে। referral_code-এ ইউনিক কনস্ট্রেইন্ট ভাঙলে
 * (Postgres error code 23505) নতুন কোড নিয়ে আবার চেষ্টা করে। শুধু referral_code-এর কলিশনেই
 * রিট্রাই হয় — username/phone/email ডুপ্লিকেট হলে (সেগুলোও 23505) এররটা যথারীতি উপরে ছুড়ে
 * দেওয়া হয়, কারণ ওগুলো ইউজারের ইনপুট এবং কলার সেগুলো আলাদাভাবে হ্যান্ডল করে।
 * সাধারণ রেজিস্ট্রেশন ও Google Sign-In — দুই পথেই একই হেল্পার ব্যবহার হয়।
 */
async function insertWithUniqueReferralCode(username, insertFn) {
  let lastErr = null;
  for (let attempt = 0; attempt < REFERRAL_CODE_MAX_ATTEMPTS; attempt++) {
    const code = generateReferralCode(username);
    try {
      return await insertFn(code);
    } catch (err) {
      const isReferralCollision = err && err.code === '23505' && err.constraint === 'users_referral_code_key';
      if (!isReferralCollision) throw err;
      lastErr = err;
      console.warn(`referral_code কলিশন (${code}) — নতুন কোড দিয়ে আবার চেষ্টা করা হচ্ছে (${attempt + 1}/${REFERRAL_CODE_MAX_ATTEMPTS})`);
    }
  }
  throw lastErr;
}

router.get('/register', (req, res) => {
  const ref = req.query.ref || '';
  const botCheck = evaluateRequest({ ip: getReqIp(req), userAgent: req.get('user-agent') || '', endpoint: '/register', req });
  let captcha = null;
  if (botCheck.requiresCaptcha) {
    captcha = generateCaptcha();
    req.session.botCaptcha = captcha;
    logBotEvent({ ip: getReqIp(req), endpoint: '/register', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent: req.get('user-agent') || '', blocked: false })
      .catch(e => console.error('logBotEvent error:', e.message));
  } else {
    req.session.botCaptcha = null;
  }
  res.render('registration', { ref, captcha, formRenderedAt: Date.now() });
});

router.post('/register', async (req, res) => {
  const { username: rawUsername, email: rawEmail, phone: rawPhone, password, confirmPassword, referralCode, website, form_rendered_at, captcha_answer } = req.body;
  // সংরক্ষণ ও খোঁজা — দুটোই normalize করা মানেই হয়, নাহলে কেস/স্পেসের
  // ভিন্নতায় একই ইমেইলে একাধিক অ্যাকাউন্ট তৈরি হয় (utils/identity.js দেখুন)।
  const username = normalizeUsername(rawUsername);
  const email = normalizeEmail(rawEmail);
  const phone = normalizePhone(rawPhone);
  const ref = referralCode || req.query.ref || '';
  const reqIp = getReqIp(req);
  const userAgent = req.get('user-agent') || '';

  // ব্লকলিস্টেড IP হলে সরাসরি প্রত্যাখ্যান, whitelist হলে নিচের বট-চেক সম্পূর্ণ স্কিপ
  const ipRule = await getIpRule(reqIp);
  if (ipRule === 'block') {
    logBotEvent({ ip: reqIp, endpoint: '/register', signals: [{ type: 'ip_blocklisted', description: 'অ্যাডমিন কর্তৃক ব্লকলিস্টেড IP' }], riskLevel: 'high', userAgent, blocked: true })
      .catch(e => console.error('logBotEvent error:', e.message));
    req.flash('error', req.t('error_action_not_completed'));
    return res.redirect('/register');
  }

  // ==================== Bot Detection System — সন্দেহজনক হলে CAPTCHA পাস করা বাধ্যতামূলক ====================
  const botCheck = ipRule === 'whitelist' ? { requiresCaptcha: false, signals: [], riskLevel: null } : evaluateRequest({
    ip: reqIp, userAgent, endpoint: '/register',
    honeypotTriggered: !!(website && website.trim()),
    formRenderedAt: form_rendered_at,
    req
  });
  if (botCheck.requiresCaptcha) {
    const captchaOk = verifyCaptcha(req.session, captcha_answer);
    if (!captchaOk) {
      logBotEvent({ ip: reqIp, endpoint: '/register', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent, blocked: true , fingerprint: botCheck.fingerprint })
        .catch(e => console.error('logBotEvent error:', e.message));
      req.flash('error', req.t('error_suspicious_activity_captcha'));
      return res.redirect('/register');
    }
    logBotEvent({ ip: reqIp, endpoint: '/register', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent, blocked: false , fingerprint: botCheck.fingerprint })
      .catch(e => console.error('logBotEvent error:', e.message));
  }

  try {
    if (!username || !password) {
      req.flash('error', req.t('auth_username_password_required'));
      return res.redirect('/register');
    }
    if (!/^[A-Za-z0-9_.]{3,20}$/.test(username)) {
      req.flash('error', req.t('auth_username_format_invalid'));
      return res.redirect('/register');
    }
    if (!email && !phone) {
      req.flash('error', req.t('auth_email_or_phone_required'));
      return res.redirect('/register');
    }
    if (email && !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)) {
      req.flash('error', req.t('auth_email_format_invalid'));
      return res.redirect('/register');
    }
    if (phone && !/^01\d{9}$/.test(phone)) {
      req.flash('error', req.t('auth_phone_format_invalid'));
      return res.redirect('/register');
    }
    if (password.length < 8) {
      req.flash('error', req.t('auth_password_min_length'));
      return res.redirect('/register');
    }
    if (confirmPassword && password !== confirmPassword) {
      req.flash('error', req.t('auth_password_mismatch'));
      return res.redirect('/register');
    }

    if (email) {
      const existingEmail = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email]);
      if (existingEmail.rows.length > 0) {
        req.flash('error', req.t('auth_email_already_registered'));
        return res.redirect('/register');
      }
    }
    if (phone) {
      const existingPhone = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
      if (existingPhone.rows.length > 0) {
        req.flash('error', req.t('auth_phone_already_registered'));
        return res.redirect('/register');
      }
    }

    const hashed = await bcrypt.hash(password, 10);

    let referredById = null;
    if (ref) {
      const referrer = await pool.query('SELECT id FROM users WHERE referral_code = $1', [ref]);
      if (referrer.rows[0]) referredById = referrer.rows[0].id;
    }

    // রেফারেল কোড ইনসার্ট — কলিশন-সেফ।
    // আগে কোড ছিল username-এর প্রথম ৪ অক্ষর + ৪ ডিজিট র‍্যান্ডম, অর্থাৎ একই ৪-অক্ষরের প্রিফিক্স
    // ওয়ালা ইউজারদের জন্য মাত্র ৯,০০০টা সম্ভাব্য কোড — কোনো uniqueness চেক বা রিট্রাই ছিল না।
    // ফলে users_referral_code_key ইউনিক কনস্ট্রেইন্ট ভেঙে পুরো রেজিস্ট্রেশন catch-এ চলে যেত
    // এবং ইউজার শুধু "রেজিস্ট্রেশন ব্যর্থ হয়েছে" দেখত (নিজে থেকে রিকভার করার উপায় ছিল না)।
    // এখন crypto.randomBytes-ভিত্তিক অনেক বড় স্পেস, আর কলিশন হলেও (23505) নতুন কোড নিয়ে রিট্রাই হয়।
    const result = await insertWithUniqueReferralCode(username, (code) => pool.query(`
      INSERT INTO users (username, email, phone, password, role, coins, referral_code, referred_by_id, created_at)
      VALUES ($1, $2, $3, $4, 'user', 0, $5, $6, NOW()) RETURNING *
    `, [username, email || null, phone || null, hashed, code, referredById]));

    const newUserId = result.rows[0].id;

    if (referredById) {
      await createReferral(null, referredById, newUserId);
    }

    const regLogin = await recordLogin(req, newUserId);
    req.session.user = sanitizeUser(result.rows[0]);
    const regDevice = await recordDeviceLogin(req, newUserId, regLogin.loginLogId);

    // ==== ইমেইল ভেরিফিকেশন লিঙ্ক পাঠানো (থাকলে) — কখনো রেজিস্ট্রেশন ব্লক করে না ====
    // আগে এখানে sendQueuedEmail()-কে await করা হতো, যা এই ফাংশনের নিজের কমেন্টের সাথেই সাংঘর্ষিক —
    // SMTP সংযোগ ধীর/ব্লকড হলে (অনেক হোস্টিং প্রোভাইডার আউটবাউন্ড SMTP পোর্ট ব্লক করে) পুরো
    // রেজিস্ট্রেশন রিকোয়েস্ট আটকে থাকত। নিচের লাইনে (OTP resend) একই ফাইলে ইতিমধ্যে সঠিক
    // fire-and-forget প্যাটার্ন আছে (.catch() সহ, await ছাড়া) — এখানেও সেটাই ব্যবহার করা হচ্ছে।
    if (email) {
      try {
        const token = await issueVerificationToken(newUserId);
        const verifyUrl = buildUrl(req, `/verify-email/${token}`);
        sendQueuedEmail('verification', email, { verifyUrl })
          .catch(e => console.error('registration verification email error:', e.message));
        // সেশনে আসল টোকেন রাখা হয় না — সেশন স্টোরও একটা ডেটাস্টোর, আর টোকেনটা
        // ইমেইলেই পাঠানো হয়ে গেছে। শুধু "পাঠানো হয়েছে" ফ্ল্যাগ রাখা হয়, যাতে
        // UI ভেরিফিকেশন-বার্তা দেখাতে পারে।
        req.session.user.verification_pending = true;
        await logSystemEvent(newUserId, username, 'EMAIL_VERIFICATION_SENT', `রেজিস্ট্রেশনের সময় ভেরিফিকেশন ইমেইল পাঠানো হয়েছে: ${email}`, req.ip);
      } catch (mailErr) {
        console.error('registration verification email error:', mailErr.message);
      }
    }

    // ফ্রড চেক — কখনো রেজিস্ট্রেশন ব্লক করে না, ব্যর্থ হলেও silently এগিয়ে যায়
    scanRegistration(newUserId, {
      ip: (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
      deviceFingerprint: req.headers['x-device-fingerprint'] || req.body?.device_fingerprint || null,
      email: email || null,
      phone: phone || null
    }).catch(e => console.error('fraud scanRegistration error:', e.message));

    // ডুপ্লিকেট অ্যাকাউন্ট চেক — কখনো রেজিস্ট্রেশন ব্লক করে না, ব্যর্থ হলেও silently এগিয়ে যায়
    const regParsedUA = parseUserAgent(req.get('user-agent') || '');
    evaluateDuplicateAccount(newUserId, {
      ip: (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
      deviceFingerprint: req.headers['x-device-fingerprint'] || req.body?.device_fingerprint || null,
      deviceSignature: regDevice?.signature || null,
      browser: regParsedUA.browser,
      os: regParsedUA.os
    }).catch(e => console.error('duplicate account evaluate error:', e.message));

    req.flash('success', email
      ? req.t('register_success_verify')
      : req.t('register_success'));
    res.redirect('/');
  } catch (err) {
    console.error(err);
    req.flash('error', req.t('auth_registration_failed'));
    res.redirect('/register');
  }
});

const STEP_UP_RISK_THRESHOLD = 70; // এর উপরে রিস্ক স্কোর হলে অতিরিক্ত ইমেইল ভেরিফিকেশন চাওয়া হয়
const STEP_UP_CODE_TTL_MINUTES = 10;

// ভেরিফিকেশন সফল/অপ্রয়োজনীয় হলে লগইন সম্পন্ন করে — session সেট, device/fraud লগ, রিডাইরেক্ট পাথ রিটার্ন করে
async function completeLogin(req, user, vpnInfo) {
  // admin অ্যাকাউন্টের জন্য 2FA বাধ্যতামূলক — completeLogin() যেখান থেকেই কল হোক না কেন (মূল
  // /login, VPN step-up ভেরিফিকেশনের পর, Google Sign-In callback) একইভাবে প্রয়োগ হয়, যাতে কোনো
  // admin অ্যাকাউন্ট /admin/login-এর বদলে সাইটের সাধারণ /login (বা Google দিয়ে) ঢুকে
  // routes/admin.js-এর বাধ্যতামূলক 2FA এড়িয়ে যেতে না পারে — দুই জায়গাতেই একই
  // pending2FA/pendingEnrollment সেশন-স্টেট ও রুট ব্যবহার হয় (routes/admin.js-এই ডিফাইন করা)।
  if (user.role && user.role.toLowerCase() === 'admin') {
    const fresh = await pool.query('SELECT totp_enabled FROM users WHERE id = $1', [user.id]);
    if (fresh.rows[0]?.totp_enabled) {
      req.session.pending2FA = { id: user.id, username: user.username, role: user.role };
      req.session.twoFAAttempts = 0;
      return '/admin/login/2fa';
    }
    req.session.pendingEnrollment = { id: user.id, username: user.username, role: user.role };
    return '/admin/2fa/mandatory-setup';
  }

  // session fixation প্রতিরোধ: লগইন সফল হওয়ার মুহূর্তে সেশন আইডি রোটেট করা হয়, যাতে
  // অথেন্টিকেশনের আগে থেকে পরিচিত/সেট করা কোনো পুরনো সেশন আইডি লগইনের পরও কার্যকর না থাকে
  await regenerateSession(req);
  const loginResult = await recordLogin(req, user.id, vpnInfo);
  req.session.user = sanitizeUser(user);
  const deviceResult = await recordDeviceLogin(req, user.id, loginResult.loginLogId);

  // ফ্রড চেক (অস্বাভাবিক লগইন, ঘনঘন IP/ডিভাইস পরিবর্তন, VPN/Proxy/Tor) — কখনো লগইন ব্লক করে না
  scanLogin(user.id, {
    ip: loginResult.ip,
    isNewDevice: deviceResult && deviceResult.isNewDevice,
    location: deviceResult && deviceResult.location,
    vpnInfo
  }).catch(e => console.error('scanLogin error:', e.message));

  // redirect-এর আগে সেশন স্টোরে লেখা নিশ্চিত করা হচ্ছে। express-session ডিফল্টে
  // fire-and-forget ভঙ্গিতে লেখে, তাই regenerate()-এর পরপরই redirect করলে ব্রাউজারের
  // পরের রিকোয়েস্ট নতুন sid নিয়ে পৌঁছে যেতে পারে সেশন সারি কমিট হওয়ার আগেই —
  // ফলাফল: লগইন সফল হলেও ইউজার সঙ্গে সঙ্গে লগইন পেজে ফেরত যায়।
  await saveSession(req);

  return (user.role && user.role.toLowerCase() === 'admin') ? '/admin' : '/';
}

// ==================== Google Sign-In (OAuth 2.0 / OpenID Connect) ====================

function googleRedirectUri(req) {
  return buildUrl(req, '/auth/google/callback');
}

/**
 * ভেরিফাইড Google প্রোফাইল দিয়ে ইউজার খুঁজে বের করে বা তৈরি করে:
 * 1. আগে থেকে এই google_id দিয়ে লিংক করা অ্যাকাউন্ট থাকলে সেটাই।
 * 2. না থাকলে কিন্তু একই ইমেইলের local অ্যাকাউন্ট থাকলে — সেটার সাথে google_id লিংক করে দেওয়া হয়
 *    (একবার লিংক হলে ভবিষ্যতে সরাসরি ধাপ ১-এই মিলে যাবে)। পাসওয়ার্ড/অন্য কোনো ডেটা বদলানো হয় না।
 * 3. দুটোর কোনোটাই না থাকলে — নতুন অ্যাকাউন্ট, কখনো Google-এর আসল পাসওয়ার্ড স্টোর করা হয় না
 *    (এমনকি Google আমাদের কখনো সেটা দেয়ও না) — বরং একটা র‍্যান্ডম, কখনো কাউকে না-জানানো ৩২-বাইট
 *    সিক্রেটের bcrypt hash বসানো হয় শুধু NOT NULL কলাম পূরণের জন্য, যা দিয়ে কখনো লগইন করা সম্ভব না।
 */
async function findOrCreateGoogleUser(profile) {
  let existing = await pool.query('SELECT * FROM users WHERE google_id = $1', [profile.googleId]);
  if (existing.rows[0]) return existing.rows[0];

  if (profile.email) {
    existing = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizeEmail(profile.email)]);
    if (existing.rows[0]) {
      await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [profile.googleId, existing.rows[0].id]);
      existing.rows[0].google_id = profile.googleId;
      return existing.rows[0];
    }
  }

  const unusablePassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const baseUsername = ((profile.email || '').split('@')[0] || 'user').replace(/[^A-Za-z0-9_.]/g, '').slice(0, 15) || 'user';
  let username = baseUsername;
  let suffix = 0;
  while (true) {
    const clash = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
    if (clash.rows.length === 0) break;
    suffix++;
    username = `${baseUsername}${suffix}`.slice(0, 20);
  }
  // সাধারণ রেজিস্ট্রেশনের মতোই কলিশন-সেফ কোড — এখানেও আগে ৪ ডিজিট র‍্যান্ডম ব্যবহার হতো,
  // ফলে একই ইউনিক-কনস্ট্রেইন্ট ব্যর্থতায় Google Sign-In-ও ভেঙে পড়তে পারত।
  const created = await insertWithUniqueReferralCode(username, (code) => pool.query(`
    INSERT INTO users (username, email, password, role, coins, referral_code, email_verified, google_id, auth_provider, full_name, avatar, created_at)
    VALUES ($1, $2, $3, 'user', 0, $4, $5, $6, 'google', $7, $8, NOW()) RETURNING *
  `, [username, normalizeEmail(profile.email), unusablePassword, code, profile.emailVerified, profile.googleId, profile.name, profile.picture]));

  logSystemEvent(created.rows[0].id, username, 'GOOGLE_ACCOUNT_CREATED', `Google Sign-In দিয়ে নতুন অ্যাকাউন্ট তৈরি: ${profile.email || ''}`, null)
    .catch(e => console.error('logSystemEvent error:', e.message));

  return created.rows[0];
}

router.get('/auth/google', googleAuthLimiter, (req, res) => {
  if (!googleAuth.isConfigured()) {
    req.flash('error', req.t('auth_google_login_unavailable'));
    return res.redirect('/login');
  }
  const state = crypto.randomBytes(24).toString('hex');
  const nonce = crypto.randomBytes(24).toString('hex');
  req.session.googleOAuthState = state;
  req.session.googleOAuthNonce = nonce;
  res.redirect(googleAuth.generateAuthUrl(googleRedirectUri(req), state, nonce));
});

router.get('/auth/google/callback', googleAuthLimiter, async (req, res) => {
  const expectedState = req.session.googleOAuthState;
  const expectedNonce = req.session.googleOAuthNonce;
  delete req.session.googleOAuthState;
  delete req.session.googleOAuthNonce;

  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      req.flash('error', req.t('auth_google_login_cancelled'));
      return res.redirect('/login');
    }
    if (!code || !state || !expectedState || state !== expectedState) {
      req.flash('error', req.t('auth_google_login_invalid_request'));
      return res.redirect('/login');
    }
    if (!googleAuth.isConfigured()) {
      req.flash('error', req.t('auth_google_login_unavailable'));
      return res.redirect('/login');
    }

    const profile = await googleAuth.exchangeCodeForProfile(googleRedirectUri(req), code, expectedNonce);
    if (!profile.email || !profile.emailVerified) {
      req.flash('error', req.t('auth_google_email_not_verified'));
      return res.redirect('/login');
    }

    const user = await findOrCreateGoogleUser(profile);
    if (user.is_banned) {
      req.flash('error', req.t('auth_account_banned'));
      return res.redirect('/login');
    }
    if (user.self_exclude_until && new Date(user.self_exclude_until) > new Date()) {
      const until = new Date(user.self_exclude_until).toLocaleDateString('bn-BD');
      req.flash('error', req.t('auth_self_excluded_until').replace('{value}', until));
      return res.redirect('/login');
    }

    const vpnInfo = await checkIp(getReqIp(req)).catch(() => null);
    const redirectPath = await completeLogin(req, user, vpnInfo);
    res.redirect(redirectPath);
  } catch (err) {
    console.error('google oauth callback error:', err.message);
    req.flash('error', req.t('auth_google_login_failed'));
    res.redirect('/login');
  }
});

router.get('/login', (req, res) => {
  const botCheck = evaluateRequest({ ip: getReqIp(req), userAgent: req.get('user-agent') || '', endpoint: '/login', req });
  let captcha = null;
  if (botCheck.requiresCaptcha) {
    captcha = generateCaptcha();
    req.session.botCaptcha = captcha;
    logBotEvent({ ip: getReqIp(req), endpoint: '/login', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent: req.get('user-agent') || '', blocked: false })
      .catch(e => console.error('logBotEvent error:', e.message));
  } else {
    req.session.botCaptcha = null;
  }
  res.render('login', { captcha, formRenderedAt: Date.now() });
});

router.post('/login', async (req, res) => {
  const { identifier, password, website, form_rendered_at, captcha_answer } = req.body;
  const reqIp = getReqIp(req);
  const userAgent = req.get('user-agent') || '';

  const ipRule = await getIpRule(reqIp);
  if (ipRule === 'block') {
    logBotEvent({ ip: reqIp, endpoint: '/login', signals: [{ type: 'ip_blocklisted', description: 'অ্যাডমিন কর্তৃক ব্লকলিস্টেড IP' }], riskLevel: 'high', userAgent, blocked: true })
      .catch(e => console.error('logBotEvent error:', e.message));
    req.flash('error', req.t('error_action_not_completed'));
    return res.redirect('/login');
  }

  // ==================== Bot Detection System — সন্দেহজনক হলে CAPTCHA পাস করা বাধ্যতামূলক ====================
  const botCheck = ipRule === 'whitelist' ? { requiresCaptcha: false, signals: [], riskLevel: null } : evaluateRequest({
    ip: reqIp, userAgent, endpoint: '/login',
    honeypotTriggered: !!(website && website.trim()),
    formRenderedAt: form_rendered_at,
    req
  });
  if (botCheck.requiresCaptcha) {
    const captchaOk = verifyCaptcha(req.session, captcha_answer);
    if (!captchaOk) {
      logBotEvent({ ip: reqIp, endpoint: '/login', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent, blocked: true , fingerprint: botCheck.fingerprint })
        .catch(e => console.error('logBotEvent error:', e.message));
      req.flash('error', req.t('error_suspicious_activity_captcha'));
      return res.redirect('/login');
    }
    logBotEvent({ ip: reqIp, endpoint: '/login', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent, blocked: false , fingerprint: botCheck.fingerprint })
      .catch(e => console.error('logBotEvent error:', e.message));
  }

  try {
    // LOWER(email) — পুরোনো রেকর্ড মিশ্র-কেসে জমা থাকতে পারে, সেগুলোতেও লগইন কাজ করবে।
    const loginIdentifier = normalizeIdentifier(identifier);
    const result = await pool.query(
      // নিরাপত্তা: is_banned / self_exclude_until / email_verified কলামগুলো আগে SELECT-এ ছিল না,
      // ফলে নিচের `user.is_banned` ও `user.self_exclude_until` সবসময় undefined হতো — অর্থাৎ
      // ব্যান করা ও সেল্ফ-এক্সক্লুড করা অ্যাকাউন্টও পাসওয়ার্ড লগইন দিয়ে ঢুকে যেতে পারত, আর
      // step-up ভেরিফিকেশনও কখনো ট্রিগার হতো না। কলামগুলো এখন স্পষ্টভাবে লোড করা হচ্ছে।
      `SELECT id, username, email, phone, password, role,
              is_banned, self_exclude_until, email_verified
         FROM users WHERE LOWER(email) = $1 OR phone = $1`,
      [loginIdentifier]
    );
    const user = result.rows[0];
    const loginIp = reqIp;

    // অ্যাকাউন্ট-ভিত্তিক থ্রটল — একই অ্যাকাউন্টে অল্প সময়ে অনেক ব্যর্থ চেষ্টা হলে (IP নির্বিশেষে)
    // সংক্ষিপ্ত সময়ের জন্য নতুন চেষ্টা আটকানো হয়। রেসপন্স ইচ্ছাকৃতভাবে ভুল পাসওয়ার্ডের মতোই —
    // আলাদা মেসেজ দিলে সেটা "এই অ্যাকাউন্ট আসলেই বিদ্যমান" ফাঁস করে দিত।
    if (user) {
      const throttle = await isAccountThrottled(user.id).catch(() => ({ throttled: false }));
      if (throttle.throttled) {
        req.flash('error', req.t('auth_invalid_credentials'));
        return res.redirect('/login');
      }
    }

    const passwordMatches = await bcrypt.compare(password, user ? user.password : DUMMY_BCRYPT_HASH);
    if (!user || !passwordMatches) {
      scanFailedLogin(identifier, user ? user.id : null, loginIp, req.get('user-agent') || '')
        .catch(e => console.error('scanFailedLogin error:', e.message));
      req.flash('error', req.t('auth_invalid_credentials'));
      return res.redirect('/login');
    }
    if (user.is_banned) {
      req.flash('error', req.t('auth_account_banned'));
      return res.redirect('/login');
    }

    // সেল্ফ-এক্সকশন চেক — নির্দিষ্ট সময় পর্যন্ত লগইন বন্ধ
    if (user.self_exclude_until && new Date(user.self_exclude_until) > new Date()) {
      const until = new Date(user.self_exclude_until).toLocaleDateString('bn-BD');
      req.flash('error', req.t('auth_self_excluded_until').replace('{value}', until));
      return res.redirect('/login');
    }

    // ==================== VPN & Proxy Detection — কখনো লগইন ব্লক করে না, শুধু রিস্ক স্কোর অনুযায়ী step-up ভেরিফিকেশন চায় ====================
    const vpnInfo = await checkIp(loginIp).catch(() => null);
    const needsStepUp = vpnInfo && (vpnInfo.isTor || vpnInfo.riskScore >= STEP_UP_RISK_THRESHOLD);

    if (needsStepUp && user.email && user.email_verified) {
      // মাস্টার অডিট: Math.random() একটা নিরাপত্তা-সংবেদনশীল কোডের জন্য CSPRNG নয়
      // (predictable seed/state) — crypto.randomInt একটা uniform, cryptographically
      // secure ৬-অঙ্কের কোড দেয়।
      const code = String(crypto.randomInt(100000, 1000000));
      await pool.query(
        `INSERT INTO step_up_verifications (user_id, code, purpose, ip, expires_at)
         VALUES ($1, $2, 'vpn_login', $3, NOW() + INTERVAL '${STEP_UP_CODE_TTL_MINUTES} minutes')`,
        [user.id, code, loginIp]
      );
      sendQueuedEmail('otp', user.email, { otp: code }).catch(e => console.error('sendOTP queue error:', e.message));

      req.session.pendingLoginUserId = user.id;
      req.session.pendingLoginVpnInfo = vpnInfo;
      req.flash('success', req.t('auth_stepup_code_sent').replace('{value}', user.email));
      return res.redirect('/verify-access');
    }

    const redirectPath = await completeLogin(req, user, vpnInfo);
    res.redirect(redirectPath);
  } catch (err) {
    console.error(err);
    req.flash('error', req.t('auth_login_failed'));
    res.redirect('/login');
  }
});

// ==================== VPN & Proxy Detection — Step-up Verification (ইমেইল OTP) ====================
router.get('/verify-access', (req, res) => {
  if (!req.session.pendingLoginUserId) return res.redirect('/login');
  res.render('verify-access');
});

router.post('/verify-access', async (req, res) => {
  try {
    const pendingUserId = req.session.pendingLoginUserId;
    if (!pendingUserId) return res.redirect('/login');

    const { code } = req.body;
    const rowRes = await pool.query(
      `SELECT id, user_id, purpose, code, expires_at, verified_at, created_at, attempts FROM step_up_verifications
       WHERE user_id = $1 AND purpose = 'vpn_login' AND verified_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [pendingUserId]
    );
    const row = rowRes.rows[0];

    if (!row || new Date(row.expires_at) < new Date()) {
      req.flash('error', req.t('auth_code_expired_relogin'));
      req.session.pendingLoginUserId = null;
      req.session.pendingLoginVpnInfo = null;
      return res.redirect('/login');
    }
    if (row.attempts >= 5) {
      req.flash('error', req.t('auth_too_many_attempts_relogin'));
      req.session.pendingLoginUserId = null;
      req.session.pendingLoginVpnInfo = null;
      return res.redirect('/login');
    }
    if (!code || code !== row.code) {
      await pool.query(`UPDATE step_up_verifications SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      req.flash('error', req.t('auth_code_incorrect'));
      return res.redirect('/verify-access');
    }

    await pool.query(`UPDATE step_up_verifications SET verified_at = NOW() WHERE id = $1`, [row.id]);

    const userRes = await pool.query('SELECT id, username, email, phone, coins, demo_balance, role, avatar, kyc_status FROM users WHERE id = $1', [pendingUserId]);
    const user = userRes.rows[0];
    if (!user) return res.redirect('/login');

    const vpnInfo = req.session.pendingLoginVpnInfo || null;
    req.session.pendingLoginUserId = null;
    req.session.pendingLoginVpnInfo = null;

    const redirectPath = await completeLogin(req, user, vpnInfo);
    req.flash('success', req.t('email_verified_welcome'));
    res.redirect(redirectPath);
  } catch (err) {
    console.error('verify-access error:', err.message);
    req.flash('error', req.t('auth_verification_failed'));
    res.redirect('/login');
  }
});

// ==================== ইমেইল ভেরিফিকেশন ====================

router.get('/verify-email/:token', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email FROM users WHERE verification_token = $1 AND verification_token_expiry > NOW()',
      [hashToken(req.params.token)]
    );
    const user = result.rows[0];

    if (!user) {
      req.flash('error', req.t('auth_link_invalid_request_new'));
      return res.redirect('/profile');
    }

    await pool.query(
      'UPDATE users SET email_verified = true, verification_token = NULL, verification_token_expiry = NULL WHERE id = $1',
      [user.id]
    );
    if (req.session.user && req.session.user.id === user.id) {
      req.session.user.email_verified = true;
    }
    await logSystemEvent(user.id, user.username, 'EMAIL_VERIFIED', `ইমেইল ভেরিফাই সম্পন্ন হয়েছে: ${user.email}`, req.ip);

    req.flash('success', req.t('auth_email_verified_success'));
    res.redirect(req.session.user ? '/profile' : '/login');
  } catch (err) {
    console.error('verify-email error:', err.message);
    req.flash('error', req.t('auth_generic_error_retry'));
    res.redirect('/');
  }
});

router.post('/resend-verification', verifyResendLimiter, async (req, res) => {
  try {
    if (!req.session.user) {
      req.flash('error', req.t('auth_login_required_first'));
      return res.redirect('/login');
    }

    const result = await pool.query(
      'SELECT id, username, email, email_verified, last_verification_sent_at FROM users WHERE id = $1',
      [req.session.user.id]
    );
    const user = result.rows[0];

    if (!user || !user.email) {
      req.flash('error', req.t('auth_no_email_on_account'));
      return res.redirect('/profile');
    }
    if (user.email_verified) {
      req.flash('success', req.t('auth_email_already_verified'));
      return res.redirect('/profile');
    }
    // অ্যাকাউন্ট-ভিত্তিক কুলডাউন — বারবার স্প্যাম-ক্লিকেও ৬০ সেকেন্ডে একবারের বেশি পাঠানো যাবে না
    if (user.last_verification_sent_at && (Date.now() - new Date(user.last_verification_sent_at).getTime()) < 60 * 1000) {
      req.flash('error', req.t('auth_resend_cooldown'));
      return res.redirect('/profile');
    }

    const token = await issueVerificationToken(user.id);
    const verifyUrl = buildUrl(req, `/verify-email/${token}`);
    sendQueuedEmail('verification', user.email, { verifyUrl })
      .catch(e => console.error('resend-verification email error:', e.message));
    await logSystemEvent(user.id, user.username, 'EMAIL_VERIFICATION_RESEND', req.t('auth_verification_email_resent').replace('{value}', user.email), req.ip);

    req.flash('success', req.t('auth_verification_link_resent'));
    res.redirect('/profile');
  } catch (err) {
    console.error('resend-verification error:', err.message);
    req.flash('error', req.t('auth_generic_error_retry'));
    res.redirect('/profile');
  }
});

// ==================== পাসওয়ার্ড রিসেট (Forgot Password) ====================

router.get('/forgot-password', (req, res) => {
  const botCheck = evaluateRequest({ ip: getReqIp(req), userAgent: req.get('user-agent') || '', endpoint: '/forgot-password', req });
  let captcha = null;
  if (botCheck.requiresCaptcha) {
    captcha = generateCaptcha();
    req.session.botCaptcha = captcha;
    logBotEvent({ ip: getReqIp(req), endpoint: '/forgot-password', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent: req.get('user-agent') || '', blocked: false })
      .catch(e => console.error('logBotEvent error:', e.message));
  } else {
    req.session.botCaptcha = null;
  }
  res.render('forgot-password', { sent: false, captcha, formRenderedAt: Date.now() });
});

router.post('/forgot-password', resetLimiter, async (req, res) => {
  const { email: rawResetEmail, website, form_rendered_at, captcha_answer } = req.body;
  const email = normalizeEmail(rawResetEmail);
  const reqIp = getReqIp(req);
  const userAgent = req.get('user-agent') || '';

  const ipRule = await getIpRule(reqIp);
  if (ipRule === 'block') {
    logBotEvent({ ip: reqIp, endpoint: '/forgot-password', signals: [{ type: 'ip_blocklisted', description: 'অ্যাডমিন কর্তৃক ব্লকলিস্টেড IP' }], riskLevel: 'high', userAgent, blocked: true })
      .catch(e => console.error('logBotEvent error:', e.message));
    req.flash('error', req.t('error_action_not_completed'));
    return res.redirect('/forgot-password');
  }

  // ==================== Bot Detection System — সন্দেহজনক হলে CAPTCHA পাস করা বাধ্যতামূলক ====================
  const botCheck = ipRule === 'whitelist' ? { requiresCaptcha: false, signals: [], riskLevel: null } : evaluateRequest({
    ip: reqIp, userAgent, endpoint: '/forgot-password',
    honeypotTriggered: !!(website && website.trim()),
    formRenderedAt: form_rendered_at,
    req
  });
  if (botCheck.requiresCaptcha) {
    const captchaOk = verifyCaptcha(req.session, captcha_answer);
    if (!captchaOk) {
      logBotEvent({ ip: reqIp, endpoint: '/forgot-password', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent, blocked: true , fingerprint: botCheck.fingerprint })
        .catch(e => console.error('logBotEvent error:', e.message));
      req.flash('error', req.t('error_suspicious_activity_captcha'));
      return res.redirect('/forgot-password');
    }
    logBotEvent({ ip: reqIp, endpoint: '/forgot-password', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent, blocked: false , fingerprint: botCheck.fingerprint })
      .catch(e => console.error('logBotEvent error:', e.message));
  }

  try {
    if (!email) {
      req.flash('error', req.t('auth_email_required'));
      return res.redirect('/forgot-password');
    }

    const result = await pool.query('SELECT id, email FROM users WHERE LOWER(email) = $1', [email]);
    const user = result.rows[0];

    // ইউজার থাকুক বা না থাকুক একই সাফল্যের মেসেজ দেখানো হয় (ইমেইল enumeration ঠেকাতে)
    if (user) {
      const { token, tokenHash } = issueToken();
      const expiry = new Date(Date.now() + 60 * 60 * 1000); // ১ ঘণ্টা
      await pool.query(
        'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
        [tokenHash, expiry, user.id]
      );
      // Redis-এ token → userId ক্যাশ করা হচ্ছে (TTL = DB expiry-এর সমান), যাতে verify-এর সময়
      // বেশিরভাগ ক্ষেত্রে DB না ছুঁয়েই কাজ চলে। ব্যর্থ হলেও সমস্যা নেই — DB fallback তো থাকছেই।
      cache.set(`reset_token:${tokenHash}`, user.id, 60 * 60).catch(() => {});

      const resetUrl = buildUrl(req, `/reset-password/${token}`);
      sendQueuedEmail('password_reset', user.email, { resetUrl })
        .catch(e => console.error('forgot-password email error:', e.message));
    }

    res.render('forgot-password', { sent: true });
  } catch (err) {
    console.error('forgot-password error:', err.message);
    req.flash('error', req.t('auth_generic_error_retry'));
    res.redirect('/forgot-password');
  }
});

router.get('/reset-password/:token', async (req, res) => {
  try {
    const token = req.params.token;
    // আগে Redis-এ চেক করা হচ্ছে (দ্রুত, DB-তে না গিয়েই) — ক্যাশ মিস/Redis ডাউন হলে স্বাভাবিকভাবে DB fallback হবে
    const cachedUserId = await cache.get(`reset_token:${hashToken(token)}`);
    if (cachedUserId) {
      return res.render('reset-password', { token });
    }
    const result = await pool.query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
      [hashToken(token)]
    );
    if (result.rows.length === 0) {
      req.flash('error', req.t('auth_link_invalid_retry'));
      return res.redirect('/forgot-password');
    }
    res.render('reset-password', { token });
  } catch (err) {
    console.error('reset-password GET error:', err.message);
    res.redirect('/forgot-password');
  }
});

router.post('/reset-password/:token', resetLimiter, async (req, res) => {
  const { password, confirmPassword } = req.body;
  const { token } = req.params;
  try {
    if (!password || password.length < 8) {
      req.flash('error', req.t('auth_password_min_length'));
      return res.redirect(`/reset-password/${token}`);
    }
    if (password !== confirmPassword) {
      req.flash('error', req.t('auth_password_mismatch'));
      return res.redirect(`/reset-password/${token}`);
    }

    const hashed = await bcrypt.hash(password, 10);

    // টোকেন যাচাই + পাসওয়ার্ড আপডেট + টোকেন invalidate — সব একটাই atomic UPDATE-এ।
    // আগে আলাদা SELECT ... তারপর UPDATE ছিল; দুটোর মাঝে কোনো লক ছিল না, তাই একই টোকেন নিয়ে
    // দুটো রিকোয়েস্ট একসাথে এলে দুটোই SELECT-এ রো পেত এবং দুটোই পাসওয়ার্ড সেট করত —
    // অর্থাৎ টোকেনটা কার্যত single-use ছিল না। WHERE-এ reset_token রাখার ফলে দ্বিতীয় কলটা
    // rowCount 0 পায় (প্রথমটা ইতিমধ্যে NULL করে দিয়েছে) এবং কিছুই পরিবর্তন করতে পারে না।
    const updated = await pool.query(
      `UPDATE users SET password = $1, reset_token = NULL, reset_token_expiry = NULL
       WHERE reset_token = $2 AND reset_token_expiry > NOW()
       RETURNING id, username`,
      [hashed, hashToken(token)]
    );
    if (updated.rowCount === 0) {
      req.flash('error', req.t('auth_link_invalid_retry'));
      return res.redirect('/forgot-password');
    }
    cache.del(`reset_token:${hashToken(token)}`).catch(() => {});

    // PHASE 5/14 fix: password reset একটি security-sensitive account event,
    // কিন্তু এর কোনো audit trail ছিল না। token বা password কখনো log করা হয় না।
    logAuditEvent({
      req, actorType: 'user', actorId: updated.rows[0].id, actorUsername: updated.rows[0].username,
      action: 'PASSWORD_RESET_COMPLETED', category: 'auth', status: 'success', riskLevel: 'high',
      details: { sessionsRevoked: true, via: 'reset_link' }
    }).catch((e) => console.error('logAuditEvent (PASSWORD_RESET_COMPLETED) error:', e.message));

    // পাসওয়ার্ড রিসেটের পর ওই অ্যাকাউন্টের সব পুরনো সেশন বাতিল করা হয়।
    // এটা না থাকলে অ্যাকাউন্ট টেকওভারের পর ভিকটিম পাসওয়ার্ড রিসেট করলেও আক্রমণকারীর
    // আগের লগইন সেশনটা বহাল থাকত — রিসেট করেও অ্যাকাউন্ট ফেরত পাওয়া যেত না।
    // services/deviceTracking.js-এর বিদ্যমান হেল্পারটাই ব্যবহার করা হচ্ছে; currentSid হিসেবে
    // ফাঁকা স্ট্রিং দেওয়া হয় (এই রিকোয়েস্টটা unauthenticated, বাদ দেওয়ার মতো নিজস্ব সেশন নেই),
    // ফলে `sid != ''` শর্তে ইউজারের সব সক্রিয় সেশনই বাতিল হয়।
    try {
      await revokeAllOtherSessions(updated.rows[0].id, '', 'PASSWORD_RESET');
    } catch (e) {
      console.error('reset-password session revoke error:', e.message);
    }

    req.flash('success', req.t('auth_password_reset_success'));
    res.redirect('/login');
  } catch (err) {
    console.error('reset-password POST error:', err.message);
    req.flash('error', req.t('auth_generic_error_retry'));
    res.redirect(`/reset-password/${token}`);
  }
});

// LOW-2 fix: logout একটি state-changing action, তাই এটি POST + CSRF-protected।
// পুরনো GET /logout link গুলো ভাঙে না — সেগুলো একটি confirm page দেখায়
// যেখান থেকে CSRF token সহ POST করা হয়।
async function doUserLogout(req, res) {
  try {
    if (req.sessionID) {
      await pool.query(`UPDATE device_sessions SET revoked_at = NOW() WHERE sid = $1`, [req.sessionID]);
    }
  } catch (e) {
    console.error('logout device_sessions cleanup error:', e.message);
  }
  req.session.destroy(() => res.redirect('/login'));
}

router.post('/logout', doUserLogout);

// GET /logout সাইটজুড়ে অসংখ্য <a href="/logout"> link-এ ব্যবহৃত হয়, তাই সেটি
// কাজ করতেই থাকে। শুধু cross-site থেকে আসা GET (অর্থাৎ প্রকৃত CSRF চেষ্টা)
// সরাসরি logout করে না — সেক্ষেত্রে confirm page দেখানো হয়, যেখান থেকে
// CSRF token সহ POST করতে হয়।
function isCrossSiteNavigation(req) {
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;

  // Host header সরাসরি ব্যবহার করা হয় না (host poisoning প্রতিরোধ) —
  // trusted base URL থেকে expected host নেওয়া হয়।
  const origin = req.get('origin');
  if (origin) {
    let expectedHost;
    try {
      expectedHost = new URL(getBaseUrl(req)).host;
    } catch (e) {
      return true; // base URL নির্ধারণ করা না গেলে fail-closed
    }
    try {
      if (new URL(origin).host !== expectedHost) return true;
    } catch (e) {
      return true; // malformed Origin = সন্দেহজনক
    }
  }
  return false;
}

router.get('/logout', async (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/login');
  if (isCrossSiteNavigation(req)) {
    return res.render('logout-confirm');
  }
  return doUserLogout(req, res);
});

module.exports = router;
