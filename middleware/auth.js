const { pool } = require('../db');
const cache = require('../services/cache');
const cacheKeys = require('../services/cacheKeys');
const { tr } = require('../utils/i18n');

// isAuth আগে শুধু req.session.user-এর অস্তিত্ব দেখত — অর্থাৎ কাউকে ব্যান/ডিলিট করার পরও
// তার আগের সেশন দিয়ে (লগআউট না করা পর্যন্ত) পুরো সাইট ব্যবহার করা যেত। isAdmin-এ এই
// সমস্যা আগে থেকেই ঠিক করা ছিল (প্রতি রিকোয়েস্টে DB থেকে role যাচাই), কিন্তু isAuth-এ ছিল
// না — অথচ isAuth ৯০+ জায়গায় ব্যবহৃত হয়, তাই প্রতি রিকোয়েস্টে সরাসরি DB কল করা পারফরম্যান্সে
// আঘাত করত। তাই এখানে একটা সংক্ষিপ্ত-মেয়াদি (৩০ সেকেন্ড) cache-ব্যাকড active-check —
// Redis থাকলে দ্রুত, Redis না থাকলে/ডাউন থাকলে services/cache.js এমনিতেই DB fallback করে
// (getOrSet-এর ভেতরের fetchFn সবসময় নিরাপদ)। ব্যান/আনব্যান হওয়ার সাথে সাথেই effective
// হওয়া দরকার এমন জায়গায় (routes/admin.js ব্যান টগল) এই ক্যাশ invalidate করা হয়, তাই
// worst-case বিলম্ব ৩০ সেকেন্ডের বেশি না এমনকি cache invalidate মিস হলেও।
const ACTIVE_STATUS_TTL_SECONDS = 30;

function rowToStatus(row) {
  if (!row) return { exists: false, banned: false, selfExcluded: false };
  const selfExcluded = !!(row.self_exclude_until && new Date(row.self_exclude_until) > new Date());
  return { exists: true, banned: !!row.is_banned, selfExcluded };
}

async function isUserActive(userId) {
  const key = cacheKeys.userActiveStatus(userId);
  try {
    const cached = await cache.getOrSet(key, ACTIVE_STATUS_TTL_SECONDS, async () => {
      const result = await pool.query('SELECT is_banned, self_exclude_until FROM users WHERE id = $1', [userId]);
      return rowToStatus(result.rows[0]);
    });
    if (!cached) {
      // ক্যাশ লেয়ার সম্পূর্ণ ব্যর্থ হলে (Redis-ও নেই, getOrSet-ও fetchFn চালাতে পারেনি) —
      // fail-open না করে সরাসরি একবার DB চেষ্টা করা হয়, যাতে ব্যানড ইউজার ভুলবশত ঢুকতে না পারে।
      const result = await pool.query('SELECT is_banned, self_exclude_until FROM users WHERE id = $1', [userId]);
      return rowToStatus(result.rows[0]);
    }
    return cached;
  } catch (err) {
    console.error('isUserActive check error:', err.message);
    // DB ব্যর্থ হলে আগে fail-open করা হতো — `{ exists: true, banned: false }`
    // ফেরত দিয়ে রিকোয়েস্ট চালিয়ে যাওয়া হতো, যুক্তি ছিল DB hiccup-এ সবাইকে
    // লগ-আউট করা বেশি ক্ষতিকর।
    //
    // কিন্তু এটা টাকার প্ল্যাটফর্ম। fail-open মানে DB অস্থির থাকা অবস্থায়
    // ব্যানড ইউজার, self-excluded ইউজার (দায়িত্বশীল জুয়া), আর ডিলিট করা
    // অ্যাকাউন্ট — সবাই ডিপোজিট, বাজি ও উইথড্র করতে পারত। যাচাই করা যাচ্ছে
    // না মানে যাচাই পাস করেছে নয়।
    //
    // এখন fail-closed: স্ট্যাটাস অজানা থাকলে অ্যাক্সেস দেওয়া হয় না। সেশন
    // ধ্বংস করা হয় না — DB ফিরলে ইউজার রিফ্রেশ করলেই আবার ঢুকতে পারবে।
    return { exists: false, banned: false, selfExcluded: false, checkFailed: true };
  }
}

const isAuth = async (req, res, next) => {
  if (!(req.session && req.session.user)) return res.redirect('/login');

  const status = await isUserActive(req.session.user.id);
  // self-exclude আগে শুধু লগইন করার সময় (routes/auth.js) চেক হতো — অর্থাৎ এক্সক্লুশন সেট করার
  // মুহূর্তে যেসব সেশন ইতিমধ্যে লগইন করা ছিল (অন্য ডিভাইস/ব্রাউজার) সেগুলো দিয়ে পুরো
  // এক্সক্লুশন পিরিয়ড জুড়ে ডিপোজিট/উইথড্র/বেট করা যেত। এখন প্রতিটা isAuth-সুরক্ষিত রিকোয়েস্টেই
  // যাচাই হয়, যেমন is_banned হয়।
  // স্ট্যাটাস যাচাই করা যায়নি (DB/ক্যাশ ব্যর্থ) — সেশন ধ্বংস না করে 503।
  // ইউজারের দোষ নয়, তাই লগ-আউট করানো হয় না; কিন্তু যাচাই ছাড়া ভেতরেও ঢুকতে
  // দেওয়া হয় না।
  if (status.checkFailed) {
    if (req.path.includes('/api/')) {
      return res.status(503).json({ success: false, error: tr(req, 'auth_status_unavailable') });
    }
    return res.status(503).render('error', {
      user: req.session.user || null,
      message: tr(req, 'auth_status_unavailable')
    });
  }

  if (!status.exists || status.banned || status.selfExcluded) {
    req.session.destroy(() => {});
    if (req.path.includes('/api/')) {
      return res.status(401).json({ success: false, error: tr(req, 'auth_session_invalid') });
    }
    return res.redirect('/login');
  }

  return next();
};

// অ্যাডমিন রুটে ঢোকার প্রতিটা রিকোয়েস্টে সেশনের পুরনো role না মেনে,
// সরাসরি ডাটাবেজ থেকে বর্তমান role যাচাই করা হয় — কাউকে ডিমোট করলে
// তার আগের সেশন দিয়ে আর অ্যাক্সেস করা যাবে না (লগআউট করা লাগবে না, সাথে সাথেই কার্যকর হবে)
const isAdmin = async (req, res, next) => {
  const denyResponse = () => {
    if (req.path.includes('/api/')) {
      return res.status(403).json({ success: false, error: tr(req, 'auth_admin_required') });
    }
    return res.redirect('/admin/login');
  };

  if (!req.session || !req.session.user) return denyResponse();

  try {
    const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.user.id]);
    const currentRole = result.rows[0] && result.rows[0].role;

    if (currentRole !== 'admin') {
      req.session.destroy(() => {});
      return denyResponse();
    }

    // সেশনে role স্টেল হয়ে থাকলে সিঙ্ক করে রাখা (অন্য জায়গায় ইউজ হলে যেন সঠিক থাকে)
    req.session.user.role = currentRole;
    return next();
  } catch (err) {
    console.error('isAdmin role check error:', err.message);
    return denyResponse();
  }
};

const requireAuth = isAuth;
const requireAdmin = isAdmin;

// সংবেদনশীল ফিচার (যেমন withdraw) ব্যবহারের আগে ইমেইল ভেরিফাইড কিনা DB থেকে যাচাই করে —
// সেশনে ক্যাশ করা মান নয়, কারণ ভেরিফাই/রিসেন্ড অন্য ট্যাবে হলে সেশন স্টেল থাকতে পারে
const requireVerifiedEmail = async (req, res, next) => {
  if (!req.session || !req.session.user) return res.redirect('/login');

  try {
    const result = await pool.query('SELECT email, email_verified FROM users WHERE id = $1', [req.session.user.id]);
    const row = result.rows[0];

    // ইমেইলই নেই এমন অ্যাকাউন্টের জন্য এই গেট প্রযোজ্য না (ফোন দিয়ে রেজিস্টার করা ইউজার)
    if (!row || !row.email || row.email_verified) {
      if (row) req.session.user.email_verified = row.email_verified;
      return next();
    }

    if (req.path.includes('/api/')) {
      return res.status(403).json({ success: false, error: tr(req, 'auth_email_verify_required') });
    }
    req.flash && req.flash('error', tr(req, 'auth_email_verify_required_detail'));
    return res.redirect('/profile');
  } catch (err) {
    console.error('requireVerifiedEmail error:', err.message);
    return res.redirect('/profile');
  }
};

module.exports = { isAuth, isAdmin, requireAuth, requireAdmin, requireVerifiedEmail };
