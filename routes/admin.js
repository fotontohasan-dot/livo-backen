const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAdmin } = require('../middleware/auth');
const { syncMatches } = require('../services/matchUpdater');

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

// ==================== MATCH MANAGEMENT ====================
router.get('/matches', async (req, res) => {
  try {
    const matches = await pool.query('SELECT * FROM matches ORDER BY start_time DESC');
    res.render('admin/matches', { matches: matches.rows });
  } catch (err) {
    console.error(err);
    res.render('admin/matches', { matches: [] });
  }
});

// ম্যাচ সিঙ্ক (API থেকে)
router.post('/matches/sync', async (req, res) => {
  try {
    await syncMatches();
    req.flash('success', 'ম্যাচ সিঙ্ক সম্পন্ন হয়েছে!');
  } catch (err) {
    console.error('sync error:', err.message);
    req.flash('error', 'সিঙ্ক করতে সমস্যা হয়েছে!');
  }
  res.redirect('/admin/matches');
});

// নতুন ম্যাচ যোগ
router.post('/matches/add', async (req, res) => {
  try {
    const { title, sport, team_a, team_b, start_time } = req.body;
    if (!team_a || !team_b) {
      req.flash('error', 'দুই দলের নাম দিন!');
      return res.redirect('/admin/matches');
    }
    const matchTitle = title || `${team_a} vs ${team_b}`;
    await pool.query(
      `INSERT INTO matches (title, sport, team_a, team_b, status, start_time)
       VALUES ($1, $2, $3, $4, 'upcoming', $5)`,
      [matchTitle, sport || 'cricket', team_a, team_b, start_time || null]
    );
    req.flash('success', 'নতুন ম্যাচ যোগ হয়েছে!');
  } catch (err) {
    console.error('match add error:', err.message);
    req.flash('error', 'ম্যাচ যোগ করতে সমস্যা হয়েছে!');
  }
  res.redirect('/admin/matches');
});

// ম্যাচ ডিলিট
router.post('/matches/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM matches WHERE id = $1', [req.params.id]);
    req.flash('success', 'ম্যাচ মুছে ফেলা হয়েছে!');
  } catch (err) {
    console.error('match delete error:', err.message);
    req.flash('error', 'মুছতে সমস্যা হয়েছে!');
  }
  res.redirect('/admin/matches');
});

// ম্যাচের ফলাফল/স্ট্যাটাস আপডেট
router.post('/matches/:id/status', async (req, res) => {
  try {
    const { status, score_a, score_b } = req.body;
    await pool.query(
      'UPDATE matches SET status = $1, score_a = $2, score_b = $3 WHERE id = $4',
      [status || 'live', score_a || null, score_b || null, req.params.id]
    );
    req.flash('success', 'ম্যাচ আপডেট হয়েছে!');
  } catch (err) {
    console.error('match status error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে!');
  }
  res.redirect('/admin/matches');
});

// ==================== MARKET MANAGEMENT ====================
router.get('/markets/:matchId', async (req, res) => {
  try {
    const matchResult = await pool.query('SELECT * FROM matches WHERE id = $1', [req.params.matchId]);
    const match = matchResult.rows[0];
    if (!match) return res.status(404).send('Match not found');
    const markets = await pool.query('SELECT * FROM markets WHERE match_id = $1', [req.params.matchId]);
    res.render('admin/markets', { match: match, markets: markets.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

router.post('/markets/update', async (req, res) => {
  try {
    const { match_id, type, name, odds, status } = req.body;
    await pool.query(`
      INSERT INTO markets (match_id, type, name, odds, status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (match_id, type, name)
      DO UPDATE SET odds = EXCLUDED.odds, status = EXCLUDED.status, updated_at = NOW()
    `, [match_id, type, name, odds, status || 'open']);
    req.flash('success', 'মার্কেট আপডেট হয়েছে!');
    res.redirect(`/admin/markets/${match_id}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'মার্কেট আপডেট করতে সমস্যা হয়েছে!');
    res.redirect('/admin/matches');
  }
});

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

// ==================== বেট সেটেল ====================
router.post('/markets/:marketId/settle', async (req, res) => {
  const marketId = req.params.marketId;
  const { winning_runner } = req.body;

  if (!winning_runner) {
    req.flash('error', 'জয়ী নির্বাচন করুন!');
    return res.redirect('back');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bets = await client.query(
      `SELECT * FROM bets WHERE market_id = $1 AND status = 'pending' FOR UPDATE`,
      [marketId]
    );

    let winnersCount = 0;
    for (const bet of bets.rows) {
      if (String(bet.runner) === String(winning_runner)) {
        const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
        await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [payout, bet.user_id]);
        await client.query(
          `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'bet_win', 'বেট জয়')`,
          [bet.user_id, payout]
        );
        await client.query(`UPDATE bets SET status = 'won' WHERE id = $1`, [bet.id]);
        await client.query(
          `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'বেট জয়!', $2, 'success')`,
          [bet.user_id, `আপনি ${payout} কয়েন জিতেছেন!`]
        );
        winnersCount++;
      } else {
        await client.query(`UPDATE bets SET status = 'lost' WHERE id = $1`, [bet.id]);
      }
    }

    await client.query(`UPDATE markets SET status = 'settled', updated_at = NOW() WHERE id = $1`, [marketId]);
    await client.query('COMMIT');
    req.flash('success', `সেটেল সম্পন্ন! ${bets.rows.length} টি বেট প্রসেস হয়েছে, ${winnersCount} জন জিতেছে।`);
    res.redirect('back');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('settle error:', err.message);
    req.flash('error', 'সেটেল করতে সমস্যা হয়েছে!');
    res.redirect('back');
  } finally {
    client.release();
  }
});

// ==================== নিউজ ম্যানেজমেন্ট ====================
router.get('/news', async (req, res) => {
  try {
    const news = await pool.query('SELECT * FROM news ORDER BY created_at DESC');
    res.render('admin/news', { news: news.rows });
  } catch (err) {
    console.error('admin news error:', err.message);
    res.render('admin/news', { news: [] });
  }
});

router.post('/news', async (req, res) => {
  try {
    const { title, content, image_url, sport } = req.body;
    if (!title) {
      req.flash('error', 'শিরোনাম দিন!');
      return res.redirect('/admin/news');
    }
    await pool.query(
      `INSERT INTO news (title, content, image_url, sport, author_id, views, created_at)
       VALUES ($1, $2, $3, $4, $5, 0, NOW())`,
      [title, content || '', image_url || null, sport || null, req.session.user.id]
    );
    req.flash('success', 'নিউজ প্রকাশিত হয়েছে!');
    res.redirect('/admin/news');
  } catch (err) {
    console.error('news create error:', err.message);
    req.flash('error', 'নিউজ তৈরি করতে সমস্যা হয়েছে!');
    res.redirect('/admin/news');
  }
});

router.post('/news/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM news WHERE id = $1', [req.params.id]);
    req.flash('success', 'নিউজ মুছে ফেলা হয়েছে!');
    res.redirect('/admin/news');
  } catch (err) {
    console.error('news delete error:', err.message);
    req.flash('error', 'মুছতে সমস্যা হয়েছে!');
    res.redirect('/admin/news');
  }
});

// ==================== KYC ম্যানেজমেন্ট ====================
router.get('/kyc', async (req, res) => {
  try {
    const requests = await pool.query(`
      SELECT k.*, u.username FROM kyc_requests k
      JOIN users u ON k.user_id = u.id
      ORDER BY CASE WHEN k.status = 'pending' THEN 0 ELSE 1 END, k.created_at DESC
    `);
    res.render('admin/kyc', { requests: requests.rows });
  } catch (err) {
    console.error('admin kyc error:', err.message);
    res.render('admin/kyc', { requests: [] });
  }
});

router.post('/kyc/:id/approve', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM kyc_requests WHERE id = $1', [req.params.id]);
    const kyc = r.rows[0];
    if (kyc) {
      await pool.query(`UPDATE kyc_requests SET status = 'approved', updated_at = NOW() WHERE id = $1`, [req.params.id]);
      await pool.query("UPDATE users SET kyc_status = 'approved' WHERE id = $1", [kyc.user_id]);
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'KYC অনুমোদিত', 'আপনার পরিচয় যাচাই সম্পন্ন হয়েছে!', 'success')`,
        [kyc.user_id]
      );
    }
    req.flash('success', 'KYC অনুমোদিত হয়েছে!');
    res.redirect('/admin/kyc');
  } catch (err) {
    console.error('kyc approve error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে!');
    res.redirect('/admin/kyc');
  }
});

router.post('/kyc/:id/reject', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM kyc_requests WHERE id = $1', [req.params.id]);
    const kyc = r.rows[0];
    if (kyc) {
      await pool.query(`UPDATE kyc_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1`, [req.params.id]);
      await pool.query("UPDATE users SET kyc_status = 'rejected' WHERE id = $1", [kyc.user_id]);
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'KYC বাতিল', 'আপনার KYC বাতিল হয়েছে। আবার চেষ্টা করুন।', 'error')`,
        [kyc.user_id]
      );
    }
    req.flash('error', 'KYC বাতিল করা হয়েছে।');
    res.redirect('/admin/kyc');
  } catch (err) {
    console.error('kyc reject error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে!');
    res.redirect('/admin/kyc');
  }
});

module.exports = router;
