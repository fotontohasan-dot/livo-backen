const { pool } = require('../db');
const { getSetting } = require('../services/settings');

const isAuth = (req, res, next) => {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
};

// অ্যাডমিন রুটে ঢোকার প্রতিটা রিকোয়েস্টে সেশনের পুরনো role না মেনে,
// সরাসরি ডাটাবেজ থেকে বর্তমান role যাচাই করা হয় — কাউকে ডিমোট করলে
// তার আগের সেশন দিয়ে আর অ্যাক্সেস করা যাবে না (লগআউট করা লাগবে না, সাথে সাথেই কার্যকর হবে)
const isAdmin = async (req, res, next) => {
  const denyResponse = () => {
    if (req.path.includes('/api/')) {
      return res.status(403).json({ success: false, error: 'অ্যাক্সেস অনুমোদিত নয়, দয়া করে অ্যাডমিন হিসেবে লগইন করুন।' });
    }
    return res.redirect('/admin/login');
  };

  if (!req.session || !req.session.user) return denyResponse();

  try {
    const idleMinutes = parseInt(await getSetting('session_idle_timeout_minutes'), 10);
    if (idleMinutes > 0) {
      const now = Date.now();
      if (req.session.lastAdminActivity && (now - req.session.lastAdminActivity) > idleMinutes * 60 * 1000) {
        req.session.destroy(() => {});
        return denyResponse();
      }
      req.session.lastAdminActivity = now;
    }
  } catch (e) {} // সেটিংস পড়তে সমস্যা হলে টাইমআউট চেক স্কিপ (fail-open, লগইন আটকাবে না)

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
      return res.status(403).json({ success: false, error: 'এই ফিচার ব্যবহার করতে আগে ইমেইল ভেরিফাই করুন।' });
    }
    req.flash && req.flash('error', '❌ এই ফিচার ব্যবহার করতে আগে আপনার ইমেইল ভেরিফাই করুন। প্রোফাইল পেজ থেকে ভেরিফিকেশন লিঙ্ক পুনরায় পাঠাতে পারেন।');
    return res.redirect('/profile');
  } catch (err) {
    console.error('requireVerifiedEmail error:', err.message);
    return res.redirect('/profile');
  }
};

module.exports = { isAuth, isAdmin, requireAuth, requireAdmin, requireVerifiedEmail };
