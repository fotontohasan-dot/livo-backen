const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAdmin } = require('../middleware/auth');
const { settleSelectionsForMarket } = require('../services/accumulator');
const { grantFreeBet } = require('../services/freebet');
const { syncMatches } = require('../services/matchUpdater');
const { runBackupNow, restoreFromBackup, getBackupStatus } = require('../services/backup');
const bcrypt = require('bcryptjs');

// ==================== ADMIN LOGIN ====================
router.get('/login', (req, res) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND role = $2 LIMIT 1', );

    if (result.rows.length === 0) {
      return res.render('admin/login', { error: 'ইউজারনেম বা পাসওয়ার্ড ভুল' });
    }

    const admin = result.rows[0];
    const isMatch = await bcrypt.compare(password, admin.password);

    if (!isMatch) {
      return res.render('admin/login', { error: 'ইউজারনেম বা পাসওয়ার্ড ভুল' });
    }

    req.session.user = {
      id: admin.id,
      username: admin.username,
      role: admin.role
    };

    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.render('admin/login', { error: 'সার্ভার এরর হয়েছে' });
  }
});

// ==================== CREATE ADMIN LOGS TABLE (Temporary) ====================
router.get('/create-activity-table', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES users(id),
        admin_username VARCHAR(100),
        action_type VARCHAR(100) NOT NULL,
        details TEXT,
        ip_address VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    res.send('✅ Admin Logs টেবিল সফলভাবে তৈরি হয়েছে!');
  } catch (err) {
    console.error(err);
    res.send('❌ সমস্যা হয়েছে: ' + err.message);
  }
});

// ==================== সব রাউট প্রোটেক্টেড ====================
router.use(isAdmin);

// ==================== ADMIN LOGOUT ====================
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// ==================== DASHBOARD ====================
router.get('/', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalCoins = await pool.query('SELECT SUM(coins) as total FROM users');
    const matches = await pool.query('SELECT COUNT(*) as count FROM matches');
    const totalBets = await pool.query('SELECT COUNT(*) as count FROM bets');

    const recentMatches = await pool.query('SELECT * FROM matches ORDER BY start_time DESC LIMIT 8');
    const recentUsers = await pool.query('SELECT * FROM users ORDER BY created_at DESC LIMIT 8');

    res.render('admin/dashboard', {
      stats: {
        total_users: users.rows[0].count,
        total_coins_in_system: totalCoins.rows[0].total || 0,
        total_matches: matches.rows[0 0].count,
      },
      recentMatches: recentMatches.rows,
      recentUsers: recentUsers.rows
    });
  } catch (err) {
    console.error(err);
    res.render('admin/dashboard', { stats: {}, recentMatches: [ ] });
  }
});

module.exports = router;
