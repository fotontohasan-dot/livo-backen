const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAdmin } = require('../middleware/auth');
const { settleSelectionsForMarket } = require('../services/accumulator');
const { grantFreeBet } = require('../services/freebet');
const { syncMatches } = require('../services/matchUpdater');
const { runBackupNow, restoreFromBackup, getBackupStatus } = require('../services/backup');

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
      recentUsers: [], recentMatches: []
    });
  } catch (err) {
    console.error(err);
    res.render('admin/dashboard', { stats: {}, recentUsers: [], recentMatches: [] });
  }
});

// ==================== USERS ====================
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, coins, total_points, is_banned, created_at FROM users ORDER BY id DESC');
    res.render('admin/users', { users: result.rows });
  } catch (err) {
    console.error(err);
    res.render('admin/users', { users: [] });
  }
});

// ইউজার বিস্তারিত + হিস্টরি + একই IP-র অ্যাকাউন্ট
router.get('/users/:id', async (req, res) => {
  try {
    const uId = req.params.id;
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [uId]);
    const user = userRes.rows[0];
    if (!user) {
      req.flash('error', 'ইউজার পাওয়া যায়নি!');
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

    // একই IP থেকে অন্য অ্যাকাউন্ট (multi-account ধরা)
    try {
      if (user.last_ip) {
        const s = await pool.query(
          `SELECT id, username, email FROM users WHERE last_ip = $1 AND id <> $2`,
          [user.last_ip, uId]);
        sameIp = s.rows;
      }
    } catch (e) {}

    try {
      const r = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by_id = $1', [uId]);
      referralCount = parseInt(r.rows[0].count);
    } catch (e) {}

    // আর্থিক হিসাব
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
    req.flash('error', 'সমস্যা হয়েছে!');
    res.redirect('/admin/users');
  }
});

router.post('/users/:id/ban', async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_banned = NOT is_banned WHERE id = $1', [req.params.id]);
    req.flash('success', 'স্ট্যাটাস আপডেট হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/delete', async (req, res) => {
  try {
    if (String(req.session.user.id) === String(req.params.id)) {
      req.flash('error', 'নিজের অ্যাকাউন্ট ডিলিট করা যাবে না!');
      return res.redirect('/admin/users');
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    req.flash('success', 'ইউজার ডিলট করা হয়েছে!');
  } catch (err) {
    console.error('delete error:', err.message);
    req.flash('error', 'ডিলিট করতে সমস্যা! (যুক্ত ডেটা থাকতে পারে)');
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/note', async (req, res) => {
  try {
    await pool.query('UPDATE users SET admin_note = $1 WHERE id = $2', [req.body.note || '', req.params.id]);
    req.flash('success', 'নোট সেভ হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্য হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/notify', async (req, res) => {
  try {
    const { title, message } = req.body;
    if (title && message) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,'info')`,
        [req.params.id, title, message]);
      req.flash('success', 'মেসেজ পাঠানো হয়েছে!');
    }
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/coins/add', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) { req.flash('error', 'সঠিক পরিমাণ দিন!'); return res.redirect('back'); }
    await pool.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [amount, req.params.id]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_add','অ্যাডমন কয়েন যোগ')`, [req.params.id, amount]);
    req.flash('success', '✅ কয়েন যগ হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/coins/remove', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) { req.flash('error', 'সঠিক পরিমাণ দিন!'); return res.redirect('back'); }
    await pool.query('UPDATE users SET coins = GREATEST(coins - $1, 0) WHERE id = $2', [amount, req.params.id]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'admin_remove','অ্যাডমিন কয়েন কমানো')`, [req.params.id, -amount]);
    req.flash('success', '✅ কয়ন কমানো হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/users/:id/freebet', async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) { req.flash('error', 'সঠিক পরিমাণ দিন!'); return res.redirect('back'); }
    await grantFreeBet(req.params.id, amount, 'admin');
    req.flash('success', `✅ ${amount} টাকার ফ্রি বেট দেওয়া হয়েছে!`);
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

// ==================== MATCH MANAGEMENT ====================
router.get('/matches', async (req, res) => {
  try {
    const matches = await pool.query('SELECT * FROM matches ORDER BY start_time DESC');
    res.render('admin/matches', { matches: matches.rows });
  } catch (err) { res.render('admin/matches', { matches: [] }); }
});

router.post('/matches/sync', async (req, res) => {
  try { await syncMatches(); req.flash('success', 'ম্যাচ সিঙ্ক সম্পন্ন!'); }
  catch (err) { req.flash('error', 'সিঙ্ক সমস্যা!'); }
  res.redirect('/admin/matches');
});

router.post('/matches/add', async (req, res) => {
  try {
    const { title, sport, team_a, team_b, start_time } = req.body;
    if (!team_a || !team_b) { req.flash('error', 'দুই দলের নাম দিন!'); return res.redirect('/admin/matches'); }
    await pool.query(
      `INSERT INTO matches (title, sport, team_a, team_b, status, start_time) VALUES ($1,$2,$3,$4,'upcoming',$5)`,
      [title || `${team_a} vs ${team_b}`, sport || 'cricket', team_a, team_b, start_time || null]);
    req.flash('success', 'নতুন ম্যাচ যোগ হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('/admin/matches');
});

router.post('/matches/:id/delete', async (req, res) => {
  try { await pool.query('DELETE FROM matches WHERE id = $1', [req.params.id]); req.flash('success', 'ম্যাচ মছে ফেলা হয়েছে!'); }
  catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
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
    req.flash('success', 'মার্কেট আপডেট হয়েছে!');
    res.redirect(`/admin/markets/${match_id}`);
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); res.redirect('/admin/matches'); }
});

router.post('/markets/:marketId/toggle', async (req, res) => {
  try {
    await pool.query('UPDATE markets SET status = $1 WHERE id = $2', [req.body.status, req.params.marketId]);
    req.flash('success', 'মার্কেট আপডেট হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('back');
});

router.post('/markets/:marketId/settle', async (req, res) => {
  const marketId = req.params.marketId;
  const { winning_runner } = req.body;
  if (!winning_runner) { req.flash('error', 'জয নির্বাচন করুন!'); return res.redirect('back'); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bets = await client.query(`SELECT * FROM bets WHERE market_id = $1 AND status = 'pending' FOR UPDATE`, [marketId]);
    let winnersCount = 0;
    for (const bet of bets.rows) {
      if (String(bet.runner) === String(winning_runner)) {
        const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
        await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [payout, bet.user_id]);
        await client.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'bet_win','বেট জয়')`, [bet.user_id, payout]);
        await client.query(`UPDATE bets SET status = 'won' WHERE id = $1`, [bet.id]);
        await client.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট জয়!',$2,'success')`, [bet.user_id, `আপনি ${payout} কয়েন জিতেছেন!`]);
        winnersCount++;
      } else {
        await client.query(`UPDATE bets SET status = 'lost' WHERE id = $1`, [bet.id]);
      }
    }
    await client.query(`UPDATE markets SET status = 'settled', updated_at = NOW() WHERE id = $1`, [marketId]);
    await settleSelectionsForMarket(client, marketId, winning_runner);
    await client.query('COMMIT');
    req.flash('success', `সেটেল সম্পন্ন! ${bets.rows.length} টি বেট, ${winnersCount} জন জিতেছে।`);
    res.redirect('back');
  } catch (err) {
    await client.query('ROLLBACK');
    req.flash('error', 'সটেল সমস্যা!');
    res.redirect('back');
  } finally { client.release(); }
});

// ==================== NEWS ====================
router.get('/news', async (req, res) => {
  try { const news = await pool.query('SELECT * FROM news ORDER BY created_at DESC'); res.render('admin/news', { news: news.rows }); }
  catch (err) { res.render('admin/news', { news: [] }); }
});

router.post('/news', async (req, res) => {
  try {
    const { title, content, image_url, sport } = req.body;
    if (!title) { req.flash('error', 'শিরোনাম দিন!'); return res.redirect('/admin/news'); }
    await pool.query(`INSERT INTO news (title, content, image_url, sport, author_id, views, created_at) VALUES ($1,$2,$3,$4,$5,0,NOW())`,
      [title, content || '', image_url || null, sport || null, req.session.user.id]);
    req.flash('success', 'নিউজ প্রকাশিত হয়েছে!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('/admin/news');
});

router.post('/news/:id/delete', async (req, res) => {
  try { await pool.query('DELETE FROM news WHERE id = $1', [req.params.id]); req.flash('success', 'মুছে ফেলা হয়েছে!'); }
  catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('/admin/news');
});

// ==================== KYC ====================
router.get('/kyc', async (req, res) => {
  try {
    const requests = await pool.query(`
      SELECT k.*, u.username FROM kyc_requests k JOIN users u ON k.user_id = u.id
      ORDER BY CASE WHEN k.status = 'pending' THEN 0 ELSE 1 END, k.created_at DESC`);
    res.render('admin/kyc', { requests: requests.rows });
  } catch (err) { res.render('admin/kyc', { requests: [] }); }
});

router.post('/kyc/:id/approve', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM kyc_requests WHERE id = $1', [req.params.id]);
    const kyc = r.rows[0];
    if (kyc) {
      await pool.query(`UPDATE kyc_requests SET status='approved', updated_at=NOW() WHERE id=$1`, [req.params.id]);
      await pool.query("UPDATE users SET kyc_status='approved' WHERE id=$1", [kyc.user_id]);
      await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'KYC অনুমোদিত','আপনার পরিচয় যাচাই সম্পন্ন হয়েছে!','success')`, [kyc.user_id]);
    }
    req.flash('success', 'KYC অনুমোদিত!');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('/admin/kyc');
});

router.post('/kyc/:id/reject', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM kyc_requests WHERE id = $1', [req.params.id]);
    const kyc = r.rows[0];
    if (kyc) {
      await pool.query(`UPDATE kyc_requests SET status='rejected', updated_at=NOW() WHERE id=$1`, [req.params.id]);
      await pool.query("UPDATE users SET kyc_status='rejected' WHERE id=$1", [kyc.user_id]);
      await pool.query(`INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'KYC বাতিল','আপনার KYC বাতিল হয়েছে।','error')`, [kyc.user_id]);
    }
    req.flash('error', 'KYC বাতিল করা হয়েছে।');
  } catch (err) { req.flash('error', 'সমস্যা হয়েছে!'); }
  res.redirect('/admin/kyc');
});

// ==================== ব্যাকআপ ====================
router.get('/backup/status', async (req, res) => {
  res.json(getBackupStatus());
});

router.post('/backup/run', async (req, res) => {
  const result = await runBackupNow();
  if (result.ok) req.flash('success', `✅ ব্যাকআপ সম্পন্ন (${result.tables}টা টেবিল)`);
  else req.flash('error', `❌ ব্যাকআপ ব্যর্থ: ${result.error}`);
  res.redirect('/admin');
});

// সতর্কতা: ?confirm=RESTORE ছাড়া কাজ করবে না — ভুলে চালানো ঠেকাতে
router.post('/backup/restore', async (req, res) => {
  if (req.query.confirm !== 'RESTORE') {
    req.flash('error', '?confirm=RESTORE যোগ করে আবার চেষ্টা করুন। এটা ভুলে চালানো ঠেকানোর জন্য।');
    return res.redirect('/admin');
  }
  try {
    const results = await restoreFromBackup();
    const total = Object.values(results).reduce((a, b) => a + b, 0);
    req.flash('success', `✅ রিস্টোর সম্পন্ন — মোট ${total} সারি ফিরে এসেছে`);
  } catch (err) {
    req.flash('error', `❌ রিস্টোর ব্যর্থ: ${err.message}`);
  }
  res.redirect('/admin');
});

module.exports = router;
