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
    const totalBets = await pool.query('SELECT COUNT(*) as count FROM bets');
    const recentMatchesRes = await pool.query(
      `SELECT * FROM matches ORDER BY start_time DESC LIMIT 8`
    );
    const recentUsersRes = await pool.query(
      `SELECT * FROM users ORDER BY created_at DESC LIMIT 8`
    );

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

    // গত ১৪ দিনের রেভিনিউ (ডিপোজিট - উইথড্র), লাইন চার্টের জন্য
    const revenueTrend = await pool.query(`
      SELECT d::date AS day,
        COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='deposit' AND status='approved' AND created_at::date = d::date),0) AS deposit,
        COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='withdraw' AND status='approved' AND created_at::date = d::date),0) AS withdraw
      FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') d
      ORDER BY day
    `);

    // গত ১৪ দিনের নতুন ইউজার, বার চার্টের জন্য
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

    // সন্দেহজনক অ্যাক্টিভিটি: একই IP থেকে একাধিক অ্যাকাউন্ট
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

// ==================== টুর্নামেন্ট ====================
router.get('/tournaments', async (req, res) => {
  try {
    const tournaments = await pool.query(`
      SELECT t.*, COUNT(tp.user_id) AS participant_count
      FROM tournaments t
      LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
      GROUP BY t.id ORDER BY t.created_at DESC
    `);
    res.render('admin/tournaments', { tournaments: tournaments.rows });
  } catch (err) {
    console.error('admin tournaments error:', err.message);
    res.render('admin/tournaments', { tournaments: [] });
  }
});

router.post('/tournaments', async (req, res) => {
  const { name, sport, description, entry_fee, prize_pool, max_participants, start_date, end_date } = req.body;
  if (!name || !start_date || !end_date) {
    req.flash('error', 'নাম ও তারিখ আবশ্যক');
    return res.redirect('/admin/tournaments');
  }
  try {
    await pool.query(
      `INSERT INTO tournaments (name, sport, description, entry_fee, prize_pool, max_participants, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [name, sport || 'football', description || '', parseInt(entry_fee) || 0, parseInt(prize_pool) || 0,
       parseInt(max_participants) || 100, start_date, end_date]
    );
    req.flash('success', 'টুর্নামেন্ট তৈরি হয়েছে');
  } catch (err) {
    console.error('create tournament error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে: ' + err.message);
  }
  res.redirect('/admin/tournaments');
});

router.post('/tournaments/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['upcoming', 'ongoing', 'completed'].includes(status)) return res.redirect('/admin/tournaments');
  try {
    await pool.query(`UPDATE tournaments SET status=$1 WHERE id=$2`, [status, req.params.id]);
    req.flash('success', 'স্ট্যাটাস আপডেট হয়েছে');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে');
  }
  res.redirect('/admin/tournaments');
});

router.post('/tournaments/:id/delete', async (req, res) => {
  try {
    await pool.query(`DELETE FROM tournaments WHERE id=$1`, [req.params.id]);
    req.flash('success', 'মুছে ফেলা হয়েছে');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে');
  }
  res.redirect('/admin/tournaments');
});
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

    // সন্দেহজনক বেট: গড়ের তুলনায় অনেক বড় স্টেক (৫০০০+ বা টানা জয়ের প্যাটার্ন)
    const suspiciousBets = await pool.query(`
      SELECT b.*, u.username, m.team_a, m.team_b, m.title
      FROM bets b JOIN users u ON b.user_id = u.id LEFT JOIN matches m ON b.match_id = m.id
      WHERE b.stake >= 5000 ORDER BY b.created_at DESC LIMIT 15
    `);

    res.render('admin/bets', {
      bets: bets.rows, suspiciousBets: suspiciousBets.rows,
      page, totalPages: Math.max(1, Math.ceil(total / limit)), total, status
    });
  } catch (err) {
    console.error(err);
    res.render('admin/bets', { bets: [], suspiciousBets: [], page: 1, totalPages: 1, total: 0, status: '' });
  }
});

// ম্যানুয়াল বেট সেটেলমেন্ট (একটা নির্দিষ্ট বেট জয়/হার হিসেবে সেট করা + পেআউট)
router.post('/bets/:id/settle', async (req, res) => {
  const { id } = req.params;
  const { result } = req.body; // 'won' | 'lost'
  if (!['won', 'lost'].includes(result)) {
    req.flash('error', 'ভুল রেজাল্ট');
    return res.redirect('/admin/bets');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT * FROM bets WHERE id=$1 FOR UPDATE', [id]);
    const bet = b.rows[0];
    if (!bet || bet.status !== 'pending') {
      await client.query('ROLLBACK');
      req.flash('error', 'বেট পাওয়া যায়নি অথবা আগেই সেটেল হয়েছে');
      return res.redirect('/admin/bets');
    }
    await client.query('UPDATE bets SET status=$1 WHERE id=$2', [result, id]);
    if (result === 'won') {
      const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
      await client.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [payout, bet.user_id]);
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট জিতেছেন!',$2,'success')`,
        [bet.user_id, `আপনি ৳${payout} জিতেছেন!`]
      );
    } else {
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,'বেট ফলাফল',$2,'error')`,
        [bet.user_id, `আপনার ৳${bet.stake} বেটটি হেরে গেছে।`]
      );
    }
    await client.query('COMMIT');
    req.flash('success', 'বেট সেটেল হয়েছে');
    res.redirect('/admin/bets');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('bet settle error:', err.message);
    req.flash('error', 'সমস্যা হয়েছে');
    res.redirect('/admin/bets');
  } finally {
    client.release();
  }
});

// ==================== বোনাস ম্যানেজমেন্ট ====================
router.get('/bonuses', async (req, res) => {
  try {
    const type = req.query.type || '';
    const params = [];
    let where = '';
    if (type) { params.push(type); where = `WHERE b.bonus_type = $1`; }
    const bonuses = await pool.query(`
      SELECT b.*, u.username FROM bonuses b JOIN users u ON b.user_id = u.id
      ${where} ORDER BY b.created_at DESC LIMIT 200
    `, params);
    res.render('admin/bonuses', { bonuses: bonuses.rows, type });
  } catch (err) {
    console.error(err);
    res.render('admin/bonuses', { bonuses: [], type: '' });
  }
});

router.post('/bonuses/:id/cancel', async (req, res) => {
  try {
    await pool.query(`UPDATE bonuses SET status='cancelled', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    req.flash('success', 'বোনাস বাতিল হয়েছে');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে');
  }
  res.redirect('/admin/bonuses');
});

// ==================== প্রমোশন ব্যানার ====================
router.get('/promotions', async (req, res) => {
  try {
    const promos = await pool.query('SELECT * FROM promotions ORDER BY position ASC, id DESC');
    res.render('admin/promotions', { promotions: promos.rows });
  } catch (err) {
    console.error(err);
    res.render('admin/promotions', { promotions: [] });
  }
});

router.post('/promotions/add', async (req, res) => {
  const { title, image_url, link_url, position } = req.body;
  if (!image_url) {
    req.flash('error', 'ছবির URL দাও');
    return res.redirect('/admin/promotions');
  }
  try {
    await pool.query(
      `INSERT INTO promotions (title, image_url, link_url, position) VALUES ($1,$2,$3,$4)`,
      [title || '', image_url, link_url || '', parseInt(position) || 0]
    );
    req.flash('success', 'প্রমোশন ব্যানার যোগ হয়েছে');
  } catch (err) {
    console.error(err);
    req.flash('error', 'সমস্যা হয়েছে');
  }
  res.redirect('/admin/promotions');
});

router.post('/promotions/:id/toggle', async (req, res) => {
  try {
    await pool.query(`UPDATE promotions SET active = NOT active WHERE id=$1`, [req.params.id]);
  } catch (e) {}
  res.redirect('/admin/promotions');
});

router.post('/promotions/:id/delete', async (req, res) => {
  try {
    await pool.query(`DELETE FROM promotions WHERE id=$1`, [req.params.id]);
    req.flash('success', 'মুছে ফেলা হয়েছে');
  } catch (e) {}
  res.redirect('/admin/promotions');
});

// ==================== রিপোর্টিং ====================
function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = v => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => escape(row[h])).join(','));
  return lines.join('\n');
}

router.get('/reports', (req, res) => {
  res.render('admin/reports', {});
});

router.get('/reports/export/:type', async (req, res) => {
  const { type } = req.params;
  const { from, to } = req.query;
  const dateFilter = (col) => {
    const conds = [];
    const params = [];
    if (from) { params.push(from); conds.push(`${col}::date >= $${params.length}`); }
    if (to) { params.push(to); conds.push(`${col}::date <= $${params.length}`); }
    return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
  };

  try {
    let rows = [], filename = 'report.csv';
    if (type === 'users') {
      const f = dateFilter('created_at');
      const r = await pool.query(`SELECT id, username, email, phone, coins, total_points, is_banned, created_at FROM users ${f.where} ORDER BY id`, f.params);
      rows = r.rows; filename = 'users_report.csv';
    } else if (type === 'bets') {
      const f = dateFilter('b.created_at');
      const r = await pool.query(`
        SELECT b.id, u.username, b.stake, b.odd, b.status, b.created_at
        FROM bets b JOIN users u ON b.user_id = u.id ${f.where} ORDER BY b.created_at DESC
      `, f.params);
      rows = r.rows; filename = 'bets_report.csv';
    } else if (type === 'payments') {
      const f = dateFilter('pr.created_at');
      const r = await pool.query(`
        SELECT pr.id, u.username, pr.type, pr.method, pr.amount, pr.status, pr.created_at
        FROM payment_requests pr JOIN users u ON pr.user_id = u.id ${f.where} ORDER BY pr.created_at DESC
      `, f.params);
      rows = r.rows; filename = 'payments_report.csv';
    } else if (type === 'profit') {
      const conds = ['status IN (\'won\',\'lost\')'];
      const params = [];
      if (from) { params.push(from); conds.push(`created_at::date >= $${params.length}`); }
      if (to) { params.push(to); conds.push(`created_at::date <= $${params.length}`); }
      const r = await pool.query(`
        SELECT created_at::date AS date,
          COALESCE(SUM(stake),0) AS total_staked,
          COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS total_paidout,
          COALESCE(SUM(stake),0) - COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS profit
        FROM bets WHERE ${conds.join(' AND ')} GROUP BY created_at::date ORDER BY date DESC
      `, params);
      rows = r.rows; filename = 'profit_report.csv';
    } else {
      return res.status(400).send('অজানা রিপোর্ট টাইপ');
    }

    const csv = toCsv(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csv); // BOM যোগ — এক্সেলে বাংলা ঠিকভাবে দেখানোর জন্য
  } catch (err) {
    console.error('report export error:', err.message);
    res.status(500).send('রিপোর্ট তৈরি করতে সমস্যা হয়েছে: ' + err.message);
  }
});

// ==================== সেটিংস ====================
router.get('/settings', async (req, res) => {
  try {
    const settings = await pool.query('SELECT * FROM site_settings ORDER BY key');
    const admins = await pool.query(`SELECT id, username, email, role FROM users WHERE role='admin' ORDER BY id`);
    res.render('admin/settings', {
      settings: settings.rows.reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {}),
      admins: admins.rows
    });
  } catch (err) {
    console.error(err);
    res.render('admin/settings', { settings: {}, admins: [] });
  }
});

router.post('/settings/update', async (req, res) => {
  try {
    const keys = ['min_bet', 'max_bet', 'turnover_multiplier', 'deposit_commission_percent', 'withdraw_commission_percent'];
    for (const k of keys) {
      if (req.body[k] !== undefined) {
        await pool.query(
          `INSERT INTO site_settings (key, value, updated_at) VALUES ($1,$2,NOW())
           ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
          [k, String(req.body[k])]
        );
      }
    }
    req.flash('success', 'সেটিংস সেভ হয়েছে');
  } catch (err) {
    console.error(err);
    req.flash('error', 'সমস্যা হয়েছে');
  }
  res.redirect('/admin/settings');
});

// অ্যাডমিন রোল ম্যানেজমেন্ট
router.post('/settings/admins/promote', async (req, res) => {
  const { username } = req.body;
  try {
    const r = await pool.query(`UPDATE users SET role='admin' WHERE username=$1 RETURNING id`, [username]);
    if (r.rowCount === 0) req.flash('error', `"${username}" নামে ইউজার পাওয়া যায়নি`);
    else req.flash('success', `"${username}" এখন অ্যাডমিন`);
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে');
  }
  res.redirect('/admin/settings');
});

router.post('/settings/admins/:id/demote', async (req, res) => {
  try {
    await pool.query(`UPDATE users SET role='user' WHERE id=$1`, [req.params.id]);
    req.flash('success', 'অ্যাডমিন অ্যাক্সেস বাতিল হয়েছে');
  } catch (err) {
    req.flash('error', 'সমস্যা হয়েছে');
  }
  res.redirect('/admin/settings');
});

module.exports = router;
