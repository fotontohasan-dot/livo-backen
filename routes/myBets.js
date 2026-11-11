// My Bets page — shell only. All data comes from the existing, session-scoped
// GET /matches/api/my-bets (routes/matches.js); this router adds no data access of its own.
const express = require('express');
const router = express.Router();
const { isAuth } = require('../middleware/auth');

router.get('/', isAuth, (req, res) => {
  res.render('my-bets', { title: req.t('my_bets'), currentPage: 'my-bets' });
});

module.exports = router;
