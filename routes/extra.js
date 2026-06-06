const express = require('express');
const router = express.Router();

function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

router.get('/invitation', requireLogin, (req, res) => {
  res.render('extra/placeholder', { title: 'Invite Friends', activePage: 'invitation' });
});

router.get('/promotion', (req, res) => {
  res.render('extra/placeholder', { title: 'Promotions', activePage: 'promotion' });
});

router.get('/support', (req, res) => {
  res.render('extra/placeholder', { title: 'Customer Support', activePage: 'support' });
});

router.get('/rewards', requireLogin, (req, res) => {
  res.render('extra/placeholder', { title: 'Reward Center', activePage: '' });
});

router.get('/app-update', (req, res) => {
  res.render('extra/placeholder', { title: 'App Update', activePage: '' });
});

module.exports = router;
