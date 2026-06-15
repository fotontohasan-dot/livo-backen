const isAuth = (req, res, next) => {
  if (req.session && req.session.user) {
    return next();
  }
  return res.redirect('/login');
};

const isAdmin = (req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  return res.status(403).send('Access denied');
};

// Aliases
const requireAuth = isAuth;
const requireAdmin = isAdmin;

module.exports = { isAuth, isAdmin, requireAuth, requireAdmin };
