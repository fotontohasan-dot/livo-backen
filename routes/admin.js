const express = require('express');
const router = express.Router();
const { isAuth, isAdmin } = require('../middleware/auth');
const { syncMatches } = require('../services/matchUpdater');

router.use(isAuth, isAdmin);

router.get('/', async (req, res) => {
  res.render('admin/dashboard', { 
    stats: { total_users: 'N/A', total_matches: 'N/A', total_predictions: 'N/A', total_tournaments: 'N/A', total_coins_in_system: 'N/A' }, 
    recentUsers: [], 
    recentMatches: [] 
  });
});

router.get('/users', (req, res) => {
  res.render('admin/users', { users: [] });
});

// Add more admin routes as needed

module.exports = router;
