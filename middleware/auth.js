const { pool } = require('../db');

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

module.exports = { isAuth, isAdmin, requireAuth, requireAdmin };
