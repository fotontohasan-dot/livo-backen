const isAuth = (req, res, next) => {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
};

const isAdmin = (req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  if (req.path.includes('/api/')) {
    return res.status(403).json({ success: false, error: 'অ্যাক্সেস অনুমোদিত নয়, দয়া করে অ্যাডমিন হিসেবে লগইন করুন।' });
  }
  return res.redirect('/admin/login');
};

const requireAuth = isAuth;
const requireAdmin = isAdmin;

module.exports = { isAuth, isAdmin, requireAuth, requireAdmin };
