// routes/api/v1/index.js
// Backward-compatible: existing routes unchanged.
// This router re-uses the same route handlers under /api/v1/*

const express = require('express');
const router  = express.Router();
const { isAuth } = require('../../../middleware/auth');

// ── Re-use existing route modules ────────────────────────────────────────────
router.use('/auth',          require('../../auth'));
router.use('/matches',       require('../../matches'));
router.use('/sports',        require('../../sports'));
router.use('/payment',       isAuth, require('../../payment'));
router.use('/profile',       isAuth, require('../../profile'));
router.use('/games',         require('../../games'));
router.use('/leaderboard',   require('../../leaderboard'));
router.use('/coins',         isAuth, require('../../coins'));
router.use('/notifications', isAuth, require('../../notifications'));
router.use('/accumulator',   require('../../accumulator'));

// ── Version info endpoint ────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({
    success: true,
    version: 'v1',
    timestamp: new Date().toISOString(),
    endpoints: {
      auth:          '/api/v1/auth',
      matches:       '/api/v1/matches',
      sports:        '/api/v1/sports',
      payment:       '/api/v1/payment',
      profile:       '/api/v1/profile',
      games:         '/api/v1/games',
      leaderboard:   '/api/v1/leaderboard',
      coins:         '/api/v1/coins',
      notifications: '/api/v1/notifications',
      accumulator:   '/api/v1/accumulator',
    },
    docs: '/api/docs'
  });
});

module.exports = router;
