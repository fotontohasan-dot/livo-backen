const isAuth = (req, res, next) => {
  if (req.session.user) return next();
  req.flash('error', 'Please login first');
  res.redirect('/login');
};

const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  req.flash('error', 'অ্যাডমিন অ্যাক্সেস দরকার');
  res.redirect('/');   // এখানে / এ রাখা হয়েছে
};

module.exports = { isAuth, isAdmin };
