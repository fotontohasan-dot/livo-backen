const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAdmin } = require('../middleware/auth');
const { settleSelectionsForMarket } = require('../services/accumulator');
const { grantFreeBet } = require('../services/freebet');
const { syncMatches } = require('../services/matchUpdater');
const { runBackupNow, restoreFromBackup, getBackupStatus } = require('../services/backup');
const bcrypt = require('bcryptjs');

// ==================== ADMIN ACTIVITY LOG HELPER ====================
async function logAdminAction(adminId, adminUsername, actionType, details, ip = null) {
    try {
        await pool.query(
            `INSERT INTO admin_logs (admin_id, admin_username, action_type, details, ip_address) 
             VALUES ($1, $2, $3, $4, $5)`,
            [adminId, adminUsername, actionType, details, ip]
        );
    } catch (err) {
        console.error('Admin Log Error:', err.message);
    }
}

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
      'SELECT * FROM users WHERE username = $1 AND role = $2 LIMIT 1',
      [username, 'admin']
    );

    if (result.rows.length === 0) {
      return res.render('admin/login', { error: 'à¦à¦à¦à¦¾à¦°à¦¨à§à¦® à¦¬à¦¾ à¦ªà¦¾à¦¸à¦à§à¦¾à¦°à§à¦¡ à¦­à§à¦²' });
    }

    const admin = result.rows[0];
    const isMatch = await bcrypt.compare(password, admin.password);

    if (!isMatch) {
      return res.render('admin/login', { error: 'à¦à¦à¦à¦¾à¦°à¦¨à§à¦® à¦¬à¦¾ à¦ªà¦¾à¦¸à¦à§à¦¾à¦°à§à¦¡ à¦­à§à¦²' });
    }

    req.session.user = {
      id: admin.id,
      username: admin.username,
      role: admin.role
    };

    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.render('admin/login', { error: 'à¦¸à¦¾à¦°à§à¦­à¦¾à¦° à¦à¦°à¦° à¦¹à§à§à¦à§' });
  }
});

// ==================== TEMPORARY: CREATE ADMIN LOGS TABLE ====================
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
    res.send('â Admin Logs à¦à§à¦¬à¦¿à¦² à¦¸à¦«à¦²à¦­à¦¾à¦¬à§ à¦¤à§à¦°à¦¿ à¦¹à§à§à¦à§!');
  } catch (err) {
    console.error(err);
    res.send('â à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§: ' + err.message);
  }
});

// ==================== ADMIN LOGOUT ====================
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

// ==================== à¦¸à¦¬ à¦°à¦¾à¦à¦ à¦ªà§à¦°à§à¦à§à¦à§à¦à§à¦¡ ====================
router.use(isAdmin);

// ==================== KYC ভেরিফিকেশন ====================
router.get('/kyc', async (req, res) => {
  try {
    const status = req.query.status || '';
    const q = req.query.q || '';
    const params = [];
    let query = `
      SELECT k.*, u.username, u.phone
      FROM kyc_requests k
      LEFT JOIN users u ON u.id = k.user_id
      WHERE 1=1
    `;
    if (status) {
      params.push(status);
      query += ` AND k.status = $${params.length}`;
    }
    if (q) {
      params.push(`%${q}%`);
      query += ` AND (u.username ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR k.full_name ILIKE $${params.length})`;
    }
    query += ' ORDER BY k.created_at DESC LIMIT 200';

    const result = await pool.query(query, params);
    const statsRes = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
      FROM kyc_requests
    `);

    res.render('admin/kyc', {
      kycList: result.rows,
      stats: statsRes.rows[0],
      filters: { status, q }
    });
  } catch (err) {
    console.error('KYC list error:', err.message);
    res.render('admin/kyc', {
      kycList: [],
      stats: { total: 0, pending: 0, approved: 0, rejected: 0 },
      filters: { status: '', q: '' }
    });
  }
});

router.post('/kyc/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await pool.query(
      "UPDATE kyc_requests SET status = 'approved', updated_at = NOW() WHERE id = $1 RETURNING user_id",
      [id]
    );
    if (r.rows[0]) {
      await pool.query("UPDATE users SET kyc_status = 'approved' WHERE id = $1", [r.rows[0].user_id]);
    }
    await logAdminAction(req.session.user.id, req.session.user.username, 'KYC_APPROVE', `KYC #${id} অনুমোদন করা হয়েছে`, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error('KYC approve error:', err.message);
    res.status(500).json({ success: false, message: 'সার্ভার এরর' });
  }
});

router.post('/kyc/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const reason = (req.body && req.body.reason) || '';
    const r = await pool.query(
      "UPDATE kyc_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1 RETURNING user_id",
      [id]
    );
    if (r.rows[0]) {
      await pool.query("UPDATE users SET kyc_status = 'rejected' WHERE id = $1", [r.rows[0].user_id]);
    }
    await logAdminAction(req.session.user.id, req.session.user.username, 'KYC_REJECT', `KYC #${id} বাতিল করা হয়েছে। কারণ: ${reason}`, req.ip);
    res.json({ success: true });
  } catch (err) {
    console.error('KYC reject error:', err.message);
    res.status(500).json({ success: false, message: 'সার্ভার এরর' });
  }
});

// ==================== DASHBOARD ====================
router.get('/', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalCoins = await pool.query('SELECT SUM(coins) as total FROM users');
    const matches = await pool.query('SELECT COUNT(*) as count FROM matches');
    const totalBets = await pool.query('SELECT COUNT(*) as count FROM bets');

    const recentMatchesRes = await pool.query(`SELECT * FROM matches ORDER BY start_time DESC LIMIT 8`);
    const recentUsersRes = await pool.query(`SELECT * FROM users ORDER BY created_at DESC LIMIT 8`);

    const todayDeposit = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM payment_requests 
       WHERE type='deposit' AND status='approved' AND created_at::date = CURRENT_DATE`
    );
    const todayWithdraw = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM payment_requests 
       WHERE type='withdraw' AND status='approved' AND created_at::date = CURRENT_DATE`
    );
    const todayBets = await pool.query(
      `SELECT COALESCE(SUM(stake),0) AS total, COUNT(*) AS cnt FROM bets WHERE created_at::date = CURRENT_DATE`
    );
    const todayProfitLoss = await pool.query(
      `SELECT COALESCE(SUM(stake),0) AS staked,
              COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS paidout
       FROM bets WHERE created_at::date = CURRENT_DATE AND status IN ('won','lost')`
    );

    const revenueTrend = await pool.query(`
      SELECT d::date AS day,
        COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='deposit' AND status='approved' AND created_at::date = d::date),0) AS deposit,
        COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='withdraw' AND status='approved' AND created_at::date = d::date),0) AS withdraw
      FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') d
      ORDER BY day
    `);

    const userGrowth = await pool.query(`
      SELECT d::date AS day,
        COALESCE((SELECT COUNT(*) FROM users WHERE created_at::date = d::date),0) AS new_users
      FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') d
      ORDER BY day
    `);

    const recentBets = await pool.query(`
      SELECT b.*, u.username, m.team_a, m.team_b, m.title
      FROM bets b JOIN users u ON b.user_id = u.id LEFT JOIN matches m ON b.match_id = m.id
      ORDER BY b.created_at DESC LIMIT 8
    `);

    const recentWithdrawals = await pool.query(`
      SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON pr.user_id = u.id
      WHERE pr.type='withdraw' ORDER BY pr.created_at DESC LIMIT 8
    `);

    const suspicious = await pool.query(`
      SELECT last_ip, COUNT(*) AS cnt, ARRAY_AGG(username) AS usernames
      FROM users WHERE last_ip IS NOT NULL
      GROUP BY last_ip HAVING COUNT(*) > 1
      ORDER BY cnt DESC LIMIT 5
    `);

    res.render('admin/dashboard', {
      stats: {
        total_users: users.rows[0].count,
        total_coins_in_system: totalCoins.rows[0].total || 0,
        total_matches: matches.rows[0].count,
        total_predictions: totalBets.rows[0].count,
        today_deposit: Number(todayDeposit.rows[0].total),
        today_deposit_count: parseInt(todayDeposit.rows[0].cnt),
        today_withdraw: Number(todayWithdraw.rows[0].total),
        today_withdraw_count: parseInt(todayWithdraw.rows[0].cnt),
        today_bet_amount: Number(todayBets.rows[0].total),
        today_bet_count: parseInt(todayBets.rows[0].cnt),
        today_profit: Number(todayProfitLoss.rows[0].staked) - Number(todayProfitLoss.rows[0].paidout)
      },
      revenueTrend: revenueTrend.rows.map(r => ({
        day: r.day, deposit: Number(r.deposit), withdraw: Number(r.withdraw)
      })),
      userGrowth: userGrowth.rows.map(r => ({ day: r.day, count: parseInt(r.new_users) })),
      recentBets: recentBets.rows,
      recentWithdrawals: recentWithdrawals.rows,
      recentMatches: recentMatchesRes.rows,
      recentUsers: recentUsersRes.rows,
      suspicious: suspicious.rows
    });
  } catch (err) {
    console.error(err);
    res.render('admin/dashboard', {
      stats: {}, revenueTrend: [], userGrowth: [], recentBets: [], recentWithdrawals: [], recentMatches: [], recentUsers: [], suspicious: []
    });
  }
});

// ==================== USERS ====================
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const status = req.query.status || '';

    const conditions = [];
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(username ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`);
    }
    if (status === 'banned') conditions.push('is_banned = true');
    if (status === 'active') conditions.push('is_banned = false');
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM users ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT id, username, email, phone, coins, total_points, is_banned, created_at FROM users ${where}
       ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.render('admin/users', {
      users: result.rows,
      page, totalPages: Math.max(1, Math.ceil(total / limit)), total,
      search, status
    });
  } catch (err) {
    console.error(err);
    res.render('admin/users', { users: [], page: 1, totalPages: 1, total: 0, search: '', status: '' });
  }
});

// ==================== USER DETAIL ====================
router.get('/users/:id', async (req, res) => {
  try {
    const uId = req.params.id;
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [uId]);
    const user = userRes.rows[0];
    if (!user) {
      req.flash('error', 'à¦à¦à¦à¦¾à¦° à¦ªà¦¾à¦à§à¦¾ à¦¯à¦¾à§à¦¨à¦¿!');
      return res.redirect('/admin/users');
    }

    let bets = [], transactions = [], payments = [], sameIp = [], referralCount = 0, stats = {};

    try {
      const b = await pool.query(
        `SELECT b.*, m.title AS match_title FROM bets b LEFT JOIN matches m ON b.match_id = m.id
         WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT 50`, [uId]);
      bets = b.rows;
    } catch (e) {}

    try {
      const t = await pool.query(`SELECT * FROM coin_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [uId]);
      transactions = t.rows;
    } catch (e) {}

    try {
      const p = await pool.query(`SELECT * FROM payment_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [uId]);
      payments = p.rows;
    } catch (e) {}

    try {
      if (user.last_ip) {
        const s = await pool.query(`SELECT id, username, email FROM users WHERE last_ip = $1 AND id <> $2`, [user.last_ip, uId]);
        sameIp = s.rows;
      }
    } catch (e) {}

    try {
      const r = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by_id = $1', [uId]);
      referralCount = parseInt(r.rows[0].count);
    } catch (e) {}

    try {
      const dep = await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM payment_requests WHERE user_id=$1 AND type='deposit' AND status='approved'`, [uId]);
      const wd = await pool.query(`SELECT COALESCE(SUM(amount),0) s FROM payment_requests WHERE user_id=$1 AND type='withdraw' AND status='approved'`, [uId]);
      const betSum = await pool.query(`SELECT COALESCE(SUM(stake),0) s, COUNT(*) c FROM bets WHERE user_id=$1`, [uId]);
      stats = {
        totalDeposit: dep.rows[0].s,
        totalWithdraw: wd.rows[0].s,
        totalBet: betSum.rows[0].s,
        betCount: betSum.rows[0].c
      };
    } catch (e) { stats = {}; }

    res.render('admin/user-detail', { u: user, bets, transactions, payments, sameIp, referralCount, stats });
  } catch (err) {
    console.error('user detail error:', err.message);
    req.flash('error', 'à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§!');
    res.redirect('/admin/users');
  }
});

// ==================== USER ACTIONS ====================
router.post('/users/:id/ban', async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_banned = NOT is_banned WHERE id = $1', [req.params.id]);
    req.flash('success', 'à¦¸à§à¦à§à¦¯à¦¾à¦à¦¾à¦¸ à¦à¦ªà¦¡à§à¦ à¦¹à§à§à¦à§!');
  } catch (err) { req.flash('error', 'à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§!'); }
  res.redirect('back');
});

router.post('/users/:id/delete', async (req, res) => {
  try {
    if (String(req.session.user.id) === String(req.params.id)) {
      req.flash('error', 'à¦¨à¦¿à¦à§à¦° à¦à§à¦¯à¦¾à¦à¦¾à¦à¦¨à§à¦ à¦¡à¦¿à¦²à¦¿à¦ à¦à¦°à¦¾ à¦¯à¦¾à¦¬à§ à¦¨à¦¾!');
      return res.redirect('/admin/users');
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    req.flash('success', 'à¦à¦à¦à¦¾à¦° à¦¡à¦¿à¦²à¦¿à¦ à¦à¦°à¦¾ à¦¹à§à§à¦à§!');
  } catch (err) {
    console.error('delete error:', err.message);
    req.flash('error', 'à¦¡à¦¿à¦²à¦¿à¦ à¦à¦°à¦¤à§ à¦¸à¦®à¦¸à§à¦¯à¦¾!');
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/coins/add', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) { req.flash('error', 'à¦¸à¦ à¦¿à¦ à¦ªà¦°à¦¿à¦®à¦¾à¦£ à¦¦à¦¿à¦¨!'); return res.redirect('back'); }
    await pool.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [amount, req.params.id]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_add','à¦à§à¦¯à¦¾à¦¡à¦®à¦¿à¦¨ à¦à§à§à¦¨ à¦¯à§à¦')`, [req.params.id, amount]);
    req.flash('success', 'â à¦à§à§à¦¨ à¦¯à§à¦ à¦¹à§à§à¦à§!');
  } catch (err) { req.flash('error', 'à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§!'); }
  res.redirect('back');
});

router.post('/users/:id/coins/remove', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) { req.flash('error', 'à¦¸à¦ à¦¿à¦ à¦ªà¦°à¦¿à¦®à¦¾à¦£ à¦¦à¦¿à¦¨!'); return res.redirect('back'); }
    await pool.query('UPDATE users SET coins = GREATEST(coins - $1, 0) WHERE id = $2', [amount, req.params.id]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_remove','à¦à§à¦¯à¦¾à¦¡à¦®à¦¿à¦¨ à¦à§à§à¦¨ à¦à¦®à¦¾à¦¨à§')`, [req.params.id, -amount]);
    req.flash('success', 'â à¦à§à§à¦¨ à¦à¦®à¦¾à¦¨à§ à¦¹à§à§à¦à§!');
  } catch (err) { req.flash('error', 'à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§!'); }
  res.redirect('back');
});

router.post('/users/:id/freebet', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) { req.flash('error', 'à¦¸à¦ à¦¿à¦ à¦ªà¦°à¦¿à¦®à¦¾à¦£ à¦¦à¦¿à¦¨!'); return res.redirect('back'); }
    await grantFreeBet(req.params.id, amount, 'admin');
    req.flash('success', `â ${amount} à¦à¦¾à¦à¦¾à¦° à¦«à§à¦°à¦¿ à¦¬à§à¦ à¦¦à§à¦à§à¦¾ à¦¹à§à§à¦à§!`);
  } catch (err) { req.flash('error', 'à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§!'); }
  res.redirect('back');
});

// ==================== MATCHES ====================
router.get('/matches', async (req, res) => {
  try {
    const matches = await pool.query('SELECT * FROM matches ORDER BY start_time DESC');
    res.render('admin/matches', { matches: matches.rows });
  } catch (err) { res.render('admin/matches', { matches: [] }); }
});

router.post('/matches/add', async (req, res) => {
  try {
    const { title, sport, team_a, team_b, start_time } = req.body;
    if (!team_a || !team_b) { req.flash('error', 'à¦¦à§à¦ à¦¦à¦²à§à¦° à¦¨à¦¾à¦® à¦¦à¦¿à¦¨!'); return res.redirect('/admin/matches'); }
    await pool.query(
      `INSERT INTO matches (title, sport, team_a, team_b, status, start_time) VALUES ($1,$2,$3,$4,'upcoming',$5)`,
      [title || `${team_a} vs ${team_b}`, sport || 'cricket', team_a, team_b, start_time || null]);
    req.flash('success', 'à¦¨à¦¤à§à¦¨ à¦®à§à¦¯à¦¾à¦ à¦¯à§à¦ à¦¹à§à§à¦à§!');
  } catch (err) { req.flash('error', 'à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§!'); }
  res.redirect('/admin/matches');
});

router.post('/matches/:id/delete', async (req, res) => {
  try { await pool.query('DELETE FROM matches WHERE id = $1', [req.params.id]); req.flash('success', 'à¦®à§à¦¯à¦¾à¦ à¦®à§à¦à§ à¦«à§à¦²à¦¾ à¦¹à§à§à¦à§!'); }
  catch (err) { req.flash('error', 'à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§!'); }
  res.redirect('/admin/matches');
});

// ==================== MARKETS ====================
router.get('/markets/:matchId', async (req, res) => {
  try {
    const matchResult = await pool.query('SELECT * FROM matches WHERE id = $1', [req.params.matchId]);
    const match = matchResult.rows[0];
    if (!match) return res.status(404).send('Match not found');
    const markets = await pool.query('SELECT * FROM markets WHERE match_id = $1', [req.params.matchId]);
    res.render('admin/markets', { match: match, markets: markets.rows });
  } catch (err) { res.status(500).send('Server Error'); }
});

router.post('/markets/update', async (req, res) => {
  try {
    const { match_id, type, name, odds, status } = req.body;
    await pool.query(`
      INSERT INTO markets (match_id, type, name, odds, status) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (match_id, type, name) DO UPDATE SET odds = EXCLUDED.odds, status = EXCLUDED.status, updated_at = NOW()
    `, [match_id, type, name, odds, status || 'open']);
    req.flash('success', 'à¦®à¦¾à¦°à§à¦à§à¦ à¦à¦ªà¦¡à§à¦ à¦¹à§à§à¦à§!');
    res.redirect(`/admin/markets/${match_id}`);
  } catch (err) { req.flash('error', 'à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§!'); res.redirect('/admin/matches'); }
});

router.post('/markets/:marketId/toggle', async (req, res) => {
  try {
    await pool.query('UPDATE markets SET status = $1 WHERE id = $2', [req.body.status, req.params.marketId]);
    req.flash('success', 'à¦®à¦¾à¦°à§à¦à§à¦ à¦à¦ªà¦¡à§à¦ à¦¹à§à§à¦à§!');
  } catch (err) { req.flash('error', 'à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§!'); }
  res.redirect('back');
});

router.post('/markets/:marketId/settle', async (req, res) => {
  const marketId = req.params.marketId;
  const { winning_runner } = req.body;
  if (!winning_runner) { req.flash('error', 'à¦à§ à¦¨à¦¿à¦°à§à¦¬à¦¾à¦à¦¨ à¦à¦°à§à¦¨!'); return res.redirect('back'); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bets = await client.query(`SELECT * FROM bets WHERE market_id = $1 AND status = 'pending' FOR UPDATE`, [marketId]);
    let winnersCount = 0;
    for (const bet of bets.rows) {
      if (String(bet.runner) === String(winning_runner)) {
        const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
        await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [payout, bet.user_id]);
        await client.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'bet_win','à¦¬à§à¦ à¦à§')`, [bet.user_id, payout]);
        await client.query(`UPDATE bets SET status = 'won' WHERE id = $1`, [bet.id]);
        await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'à¦¬à§à¦ à¦à§!',$2,'success')`, [bet.user_id, `à¦à¦ªà¦¨à¦¿ ${payout} à¦à§à§à¦¨ à¦à¦¿à¦¤à§à¦à§à¦¨!`]);
        winnersCount++;
      } else {
        await client.query(`UPDATE bets SET status = 'lost' WHERE id = $1`, [bet.id]);
      }
    }
    await client.query(`UPDATE markets SET status = 'settled', updated_at = NOW() WHERE id = $1`, [marketId]);
    await settleSelectionsForMarket(client, marketId, winning_runner);
    await client.query('COMMIT');
    req.flash('success', `à¦¸à§à¦à§à¦² à¦¸à¦®à§à¦ªà¦¨à§à¦¨! ${bets.rows.length} à¦à¦¿ à¦¬à§à¦, ${winnersCount} à¦à¦¨ à¦à¦¿à¦¤à§à¦à§à¥¤`);
    res.redirect('back');
  } catch (err) {
    await client.query('ROLLBACK');
    req.flash('error', 'à¦¸à§à¦à§à¦² à¦¸à¦®à¦¸à§à¦¯à¦¾!');
    res.redirect('back');
  } finally { client.release(); }
});

// ==================== BETS ====================
router.get('/bets', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 30;
    const offset = (page - 1) * limit;
    const status = req.query.status || '';
    const conditions = [];
    const params = [];
    if (['pending', 'won', 'lost'].includes(status)) {
      params.push(status);
      conditions.push(`b.status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM bets b ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(limit, offset);
    const bets = await pool.query(`
      SELECT b.*, u.username, m.team_a, m.team_b, m.title
      FROM bets b JOIN users u ON b.user_id = u.id LEFT JOIN matches m ON b.match_id = m.id
      ${where} ORDER BY b.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.render('admin/bets', {
      bets: bets.rows,
      page, totalPages: Math.max(1, Math.ceil(total / limit)), total, status
    });
  } catch (err) {
    console.error(err);
    res.render('admin/bets', { bets: [], page: 1, totalPages: 1, total: 0, status: '' });
  }
});

router.post('/bets/:id/settle', async (req, res) => {
  const { id } = req.params;
  const { result } = req.body;
  if (!['won', 'lost'].includes(result)) {
    req.flash('error', 'à¦­à§à¦² à¦°à§à¦à¦¾à¦²à§à¦');
    return res.redirect('/admin/bets');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT * FROM bets WHERE id=$1 FOR UPDATE', [id]);
    const bet = b.rows[0];
    if (!bet || bet.status !== 'pending') {
      await client.query('ROLLBACK');
      req.flash('error', 'à¦¬à§à¦ à¦ªà¦¾à¦à§à¦¾ à¦¯à¦¾à§à¦¨à¦¿ à¦à¦¥à¦¬à¦¾ à¦à¦à§à¦ à¦¸à§à¦à§à¦² à¦¹à§à§à¦à§');
      return res.redirect('/admin/bets');
    }
    await client.query('UPDATE bets SET status=$1 WHERE id=$2', [result, id]);
    if (result === 'won') {
      const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [payout, bet.user_id]);
      await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'à¦¬à§à¦ à¦à¦¿à¦¤à§à¦à§à¦¨!',$2,'success')`, [bet.user_id, `à¦à¦ªà¦¨à¦¿ à§³${payout} à¦à¦¿à¦¤à§à¦à§à¦¨!`]);
    } else {
      await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'à¦¬à§à¦ à¦«à¦²à¦¾à¦«à¦²',$2,'error')`, [bet.user_id, `à¦à¦ªà¦¨à¦¾à¦° à§³${bet.stake} à¦¬à§à¦à¦à¦¿ à¦¹à§à¦°à§ à¦à§à¦à§à¥¤`]);
    }
    await client.query('COMMIT');
    req.flash('success', 'à¦¬à§à¦ à¦¸à§à¦à§à¦² à¦¹à§à§à¦à§');
    res.redirect('/admin/bets');
  } catch (err) {
    await client.query('ROLLBACK');
    req.flash('error', 'à¦¸à¦®à¦¸à§à¦¯à¦¾ à¦¹à§à§à¦à§');
    res.redirect('/admin/bets');
  } finally {
    client.release();
  }
});
