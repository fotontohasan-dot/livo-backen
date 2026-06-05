const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth, isAdmin } = require('../middleware/auth');

router.use(isAuth, isAdmin);

router.get('/', async (_req, res) => {
  const stats = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role='user') as total_users,
      (SELECT COUNT(*) FROM matches) as total_matches,
      (SELECT COUNT(*) FROM predictions) as total_predictions,
      (SELECT COUNT(*) FROM tournaments) as total_tournaments,
      (SELECT COALESCE(SUM(coins),0) FROM users) as total_coins_in_system
  `);
  const recentUsers = await pool.query(`SELECT * FROM users ORDER BY created_at DESC LIMIT 5`);
  const recentMatches = await pool.query(`SELECT * FROM matches ORDER BY created_at DESC LIMIT 5`);
  const pendingDeposits = await pool.query(`SELECT ct.*, u.username FROM coin_transactions ct JOIN users u ON ct.user_id = u.id WHERE ct.status = 'pending' ORDER BY ct.created_at DESC`);
  res.render('admin/dashboard', { stats: stats.rows[0], recentUsers: recentUsers.rows, recentMatches: recentMatches.rows, pendingDeposits: pendingDeposits.rows });
});

router.post('/deposits/:id/approve', async (req, res) => {
  const { id } = req.params;
  const transaction = await pool.query(`SELECT * FROM coin_transactions WHERE id=$1 AND status='pending'`, [id]);
  if (transaction.rows[0]) {
    const { user_id, amount } = transaction.rows[0];
    await pool.query(`UPDATE coin_transactions SET status='completed' WHERE id=$1`, [id]);
    await pool.query(`UPDATE users SET coins=coins+$1 WHERE id=$2`, [amount, user_id]);
    await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'ডিপোজিট সফল', 'আপনার ${amount} কয়েন অ্যাকাউন্টে যোগ করা হয়েছে।', 'success')`, [user_id]);
    req.flash('success', 'Deposit approved!');
  }
  res.redirect('/admin');
});

router.post('/deposits/:id/reject', async (req, res) => {
  const { id } = req.params;
  await pool.query(`UPDATE coin_transactions SET status='rejected' WHERE id=$1`, [id]);
  req.flash('success', 'Deposit rejected');
  res.redirect('/admin');
});

router.get('/users', async (_req, res) => {
  const users = await pool.query(`SELECT * FROM users ORDER BY created_at DESC`);
  res.render('admin/users', { users: users.rows });
});

router.post('/users/:id/ban', async (req, res) => {
  await pool.query(`UPDATE users SET is_banned=NOT is_banned WHERE id=$1`, [req.params.id]);
  req.flash('success', 'User status updated');
  res.redirect('/admin/users');
});

router.post('/users/:id/coins', async (req, res) => {
  const { amount, description } = req.body;
  const coins = parseInt(amount);
  await pool.query(`UPDATE users SET coins=coins+$1 WHERE id=$2`, [coins, req.params.id]);
  await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_grant',$3)`, [req.params.id, coins, description || 'Admin coin grant']);
  await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'Coins Updated','Admin has updated your coins','info')`, [req.params.id]);
  req.flash('success', 'Coins updated!');
  res.redirect('/admin/users');
});

router.get('/matches', async (_req, res) => {
  const matches = await pool.query(`SELECT * FROM matches ORDER BY match_date DESC`);
  res.render('admin/matches', { matches: matches.rows });
});

router.post('/matches', async (req, res) => {
  const { title, sport, team_a, team_b, match_date, stream_url } = req.body;
  await pool.query(`INSERT INTO matches (title, sport, team_a, team_b, match_date, stream_url) VALUES ($1,$2,$3,$4,$5,$6)`,
    [title, sport, team_a, team_b, match_date, stream_url]);
  req.flash('success', 'Match created!');
  res.redirect('/admin/matches');
});

router.post('/matches/:id/result', async (req, res) => {
  const { result, score_a, score_b } = req.body;
  await pool.query(`UPDATE matches SET result=$1, score_a=$2, score_b=$3, status='completed' WHERE id=$4`, [result, score_a, score_b, req.params.id]);
  const predictions = await pool.query(`SELECT * FROM predictions WHERE match_id=$1 AND status='pending'`, [req.params.id]);
  for (const pred of predictions.rows) {
    if (pred.predicted_winner === result) {
      const earned = pred.coins_bet * 2;
      await pool.query(`UPDATE predictions SET status='won', points_earned=$1 WHERE id=$2`, [earned, pred.id]);
      await pool.query(`UPDATE users SET coins=coins+$1, total_points=total_points+$1 WHERE id=$2`, [earned, pred.user_id]);
      await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'win','Won prediction!')`, [pred.user_id, earned]);
      await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'You Won!','Your prediction was correct!','success')`, [pred.user_id]);
    } else {
      await pool.query(`UPDATE predictions SET status='lost' WHERE id=$1`, [pred.id]);
      await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'Better luck next time','Your prediction was wrong.','info')`, [pred.user_id]);
    }
  }
  req.flash('success', 'Result set and predictions settled!');
  res.redirect('/admin/matches');
});

router.get('/tournaments', async (_req, res) => {
  const tournaments = await pool.query(`SELECT * FROM tournaments ORDER BY created_at DESC`);
  res.render('admin/tournaments', { tournaments: tournaments.rows });
});

router.post('/tournaments', async (req, res) => {
  const { name, sport, description, entry_fee, prize_pool, max_participants, start_date, end_date } = req.body;
  await pool.query(`INSERT INTO tournaments (name, sport, description, entry_fee, prize_pool, max_participants, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [name, sport, description, entry_fee, prize_pool, max_participants, start_date, end_date]);
  req.flash('success', 'Tournament created!');
  res.redirect('/admin/tournaments');
});

router.get('/news', async (_req, res) => {
  const news = await pool.query(`SELECT n.*, u.username as author FROM news n LEFT JOIN users u ON n.author_id=u.id ORDER BY n.created_at DESC`);
  res.render('admin/news', { news: news.rows });
});

router.post('/news', async (req, res) => {
  const { title, content, sport, image } = req.body;
  await pool.query(`INSERT INTO news (title, content, sport, image, author_id) VALUES ($1,$2,$3,$4,$5)`,
    [title, content, sport, image, req.session.user.id]);
  req.flash('success', 'News published!');
  res.redirect('/admin/news');
});

router.post('/news/:id/delete', async (req, res) => {
  await pool.query(`DELETE FROM news WHERE id=$1`, [req.params.id]);
  req.flash('success', 'News deleted');
  res.redirect('/admin/news');
});

router.post('/notify-all', async (req, res) => {
  const { title, message } = req.body;
  const users = await pool.query(`SELECT id FROM users WHERE role='user'`);
  for (const u of users.rows) {
    await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'info')`, [u.id, title, message]);
  }
  req.flash('success', `Notification sent to ${users.rows.length} users!`);
  res.redirect('/admin');
});

module.exports = router;
