const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAdmin } = require('../middleware/auth');

// Middleware - শুধু অ্যাডমিনদের জন্য
router.use(isAdmin);

// ==================== DASHBOARD ====================
router.get('/', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalCoins = await pool.query('SELECT SUM(coins) as total FROM users');
    const matches = await pool.query('SELECT COUNT(*) as count FROM matches');

    res.render('admin/dashboard', {
      stats: {
        total_users: users.rows[0].count,
        total_coins_in_system: totalCoins.rows[0].total || 0,
        total_matches: matches.rows[0].count,
        total_predictions: 'N/A',
        total_tournaments: 'N/A'
      },
      recentUsers: [],
      recentMatches: []
    });
  } catch (err) {
    console.error(err);
    res.render('admin/dashboard', { stats: {}, recentUsers: [], recentMatches: [] });
  }
});

// ==================== USERS MANAGEMENT ====================
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, coins, total_points, is_banned, created_at FROM users ORDER BY id DESC');
    res.render('admin/users', { users: result.rows });
  } catch (err) {
    console.error(err);
    res.render('admin/users', { users: [] });
  }
});

router.post('/users/:id/ban', async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_banned = NOT is_banned WHERE id = $1', [req.params.id]);
    req.flash('success', 'ব্যান স্ট্যাটাস আপডেট হয়েছে!');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে!');
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/coins/add', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) {
      req.flash('error', 'সঠিক পরিমাণ দিন!');
      return res.redirect('/admin/users');
    }
    await pool.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [amount, req.params.id]);
    req.flash('success', '✅ কয়েন যোগ করা হয়েছে!');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে!');
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/coins/remove', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) {
      req.flash('error', 'সঠিক পরিমাণ দিন!');
      return res.redirect('/admin/users');
    }
    await pool.query('UPDATE users SET coins = GREATEST(coins - $1, 0) WHERE id = $2', [amount, req.params.id]);
    req.flash('success', '✅ কয়েন কমানো হয়েছে!');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে!');
  }
  res.redirect('/admin/users');
});

// ==================== MARKET MANAGEMENT (নতুন যোগ করা) ====================

// সব ম্যাচের লিস্ট (মার্কেট এডিট করার জন্য)
router.get('/matches', async (req, res) => {
  try {
    const matches = await pool.query('SELECT * FROM matches ORDER BY start_time DESC');
    res.render('admin/matches', { matches: matches.rows });
  } catch (err) {
    console.error(err);
    res.render('admin/matches', { matches: [] });
  }
});

// একটা ম্যাচের মার্কেট ম্যানেজ
router.get('/markets/:matchId', async (req, res) => {
  try {
    const matchResult = await pool.query('SELECT * FROM matches WHERE id = $1', [req.params.matchId]);
    const match = matchResult.rows[0];

    if (!match) return res.status(404).send('Match not found');

    const markets = await pool.query('SELECT * FROM markets WHERE match_id = $1', [req.params.matchId]);

    res.render('admin/markets', { 
      match: match, 
      markets: markets.rows 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// মার্কেট তৈরি/আপডেট
router.post('/markets/update', async (req, res) => {
  try {
    const { match_id, type, name, odds, status } = req.body;
    
    await pool.query(`
      INSERT INTO markets (match_id, type, name, odds, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (match_id, type, name) 
      DO UPDATE SET 
        odds = EXCLUDED.odds,
        status = EXCLUDED.status,
        updated_at = NOW()
    `, [match_id, type, name, odds, status || 'open']);

    req.flash('success', 'মার্কেট আপডেট হয়েছে!');
    res.redirect(`/admin/markets/${match_id}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'মার্কেট আপডেট করতে সমস্যা হয়েছে!');
    res.redirect('/admin/matches');
  }
});

// মার্কেট সাসপেন্ড / ওপেন
router.post('/markets/:marketId/toggle', async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE markets SET status = $1 WHERE id = $2', [status, req.params.marketId]);
    req.flash('success', 'মার্কেট স্ট্যাটাস আপডেট হয়েছে!');
    res.redirect('back');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে!');
    res.redirect('back');
  }
});

module.exports = router;
