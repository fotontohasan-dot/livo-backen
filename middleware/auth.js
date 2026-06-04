const isAuth = (req, res, next) => {
  if (req.session.user) return next();
  req.flash('error', 'Please login first');
  res.redirect('/login');
};

const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).render('error', { message: 'Access Denied' });
};

module.exports = { isAuth, isAdmin };
