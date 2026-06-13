const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth, isAdmin } = require('../middleware/auth');

router.use(isAuth, isAdmin);

// Dashboard
router.get('/', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalCoins = await pool.query('SELECT SUM(coins) as total FROM users');
    res.render('admin/dashboard', {
      stats: {
        total_users: users.rows[0].count,
        total_coins_in_system: totalCoins.rows[0].total || 0,
        total_matches: 'N/A',
        total_predictions: 'N/A',
        total_tournaments: 'N/A'
      },
      recentUsers: [],
      recentMatches: []
    });
  } catch (err) {
    console.error(err);
    res.render('admin/dashboard', {
      stats: { total_users: 'N/A', total_matches: 'N/A', total_predictions: 'N/A', total_tournaments: 'N/A', total_coins_in_system: 'N/A' },
      recentUsers: [],
      recentMatches: []
    });
  }
});

// Users list
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, coins, total_points, is_banned FROM users ORDER BY id ASC');
    res.render('admin/users', { users: result.rows });
  } catch (err) {
    console.error(err);
    res.render('admin/users', { users: [] });
  }
});

// Ban/Unban user
router.post('/users/:id/ban', async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_banned = NOT is_banned WHERE id = $1', [req.params.id]);
    req.flash('success', 'ব্যান স্ট্যাটাস আপডেট হয়েছে!');
  } catch (err) {
    console.error(err);
    req.flash('error', 'সমস্যা হয়েছে!');
  }
  res.redirect('/admin/users');
});

// + কয়েন যোগ করুন
router.post('/users/:id/coins/add', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) {
      req.flash('error', 'সঠিক পরিমাণ দিন!');
      return res.redirect('/admin/users');
    }
    await pool.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [amount, req.params.id]);
    req.flash('success', `✅ কয়েন যোগ করা হয়েছে!`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'সমস্যা হয়েছে!');
  }
  res.redirect('/admin/users');
});

// - কয়েন কমান
router.post('/users/:id/coins/remove', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) {
      req.flash('error', 'সঠিক পরিমাণ দিন!');
      return res.redirect('/admin/users');
    }
    await pool.query(
      'UPDATE users SET coins = GREATEST(coins - $1, 0) WHERE id = $2',
      [amount, req.params.id]
    );
    req.flash('success', `✅ কয়েন কমানো হয়েছে!`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'সমস্যা হযছে!');
  }
  res.redirect('/admin/users');
});

module.exports = router;
