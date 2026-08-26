const express = require('express');
const { requireIntParam } = require('../middleware/validate');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const { addTurnover } = require('../services/turnover');
const { updateDailyTurnover } = require('../services/dailyReward');
const { distributeCommission } = require('../services/referral');
const { addBet } = require('../services/cashback');
const { addVipTurnover } = require('../services/vip');
const { updateMissionProgress } = require('../services/missions');
const { addPoints } = require('../services/loyalty');
const { checkBadges } = require('../services/badges');
const { getSetting } = require('../services/settings');
const { resolveOdd } = require('../services/oddsResolver');
const { broadcastDemoStats } = require('../services/socket');
const cache = require('../services/cache');

function formatMatch(row) {
  return {
    id: row.id,
    sport: row.sport,
    league: row.league || null,
    name: row.title || null,
    teams: [row.team_a || 'Team A', row.team_b || 'Team B'],
    homeTeam: row.team_a || 'Team A',
    awayTeam: row.team_b || 'Team B',
    homeScore: row.score_a != null ? row.score_a : null,
    awayScore: row.score_b != null ? row.score_b : null,
    overs: row.overs || null,
    status: row.status || 'upcoming',
    date: row.start_time || null
  };
}

router.get('/', (req, res) => {
  res.render('matches', {
    currentPage: 'matches',
    sport: 'all',
    title: req.t('matches_upcoming_title'),
    user: req.session ? req.session.user : null
  });
});

router.get('/worldcup', (req, res) => {
  res.render('matches', {
    currentPage: 'worldcup',
    sport: 'cricket',
    title: 'World Cup',
    user: req.session ? req.session.user : null
  });
});

router.get('/cricket', (req, res) => {
  res.render('matches', {
    currentPage: 'cricket',
    sport: 'cricket',
    title: 'Cricket',
    user: req.session ? req.session.user : null
  });
});

router.get('/football', (req, res) => {
  res.render('matches', {
    currentPage: 'football',
    sport: 'football',
    title: 'Football',
    user: req.session ? req.session.user : null
  });
});

router.get('/api/live', async (req, res) => {
  try {
    const CACHE_KEY = 'matches:live';
    const cached = await cache.get(CACHE_KEY);
    if (cached) return res.json(cached);

    // দ্রষ্টব্য: এখানে আগে `result, home_odds, draw_odds, away_odds` কলামগুলোও SELECT করা
    // হতো, কিন্তু matches টেবিলে ওই কলামগুলো কখনো তৈরিই হয়নি। ফলে কোয়েরিটা প্রতিবার
    // "column \"result\" does not exist" এরর দিত, নিচের catch ব্লক সেটা গিলে ফেলে
    // `{ success: true, cricket: [], football: [] }` ফেরত দিত — অর্থাৎ ম্যাচ পেজে
    // কখনোই কোনো ম্যাচ দেখাত না, অথচ HTTP 200 আসায় সমস্যাটা ধরা পড়ত না।
    // formatMatch() ওই চারটা কলামের একটাও ব্যবহার করে না, তাই SELECT থেকে বাদ দেওয়াই
    // সবচেয়ে ছোট নিরাপদ ফিক্স — কোনো আউটপুট ফিল্ড হারায় না।
    const result = await pool.query(
      `SELECT id, title, team_a, team_b, sport, league, status, start_time,
              score_a, score_b, overs
       FROM matches ORDER BY
         CASE WHEN status = 'live' THEN 0 ELSE 1 END,
         start_time ASC NULLS LAST,
         id DESC
       LIMIT 100`
    );

    const cricket = [];
    const football = [];

    for (const row of result.rows) {
      const m = formatMatch(row);
      if (m.sport === 'football') football.push(m);
      else cricket.push(m);
    }

    const payload = { success: true, cricket, football };
    cache.set(CACHE_KEY, payload, 10).catch(() => {}); // 10s TTL — live data stays fresh
    res.json(payload);
  } catch (err) {
    console.error('matches/api/live error:', err.message);
    res.json({ success: true, cricket: [], football: [] });
  }
});

// ত্রুটিপূর্ণ id (abc, 1e309, ইত্যাদি) আগে সরাসরি PostgreSQL-এ পৌঁছে 22P02/22003 এরর
// ঘটাত, তারপর catch ব্লক ধরে রিডাইরেক্ট করত। ইউজার নিরাপদ উত্তরই পেত, কিন্তু প্রতিটা
// এমন রিকোয়েস্টে অপ্রয়োজনীয় DB রাউন্ড-ট্রিপ হতো। এখন রুটে ঢোকার আগেই যাচাই হয়;
// গন্তব্য আগের catch ব্লকের মতোই।
router.get('/:id', requireIntParam('id', '/matches'), async (req, res) => {
  try {
    const matchRes = await pool.query(`SELECT * FROM matches WHERE id = $1`, [req.params.id]);
    const row = matchRes.rows[0];
    if (!row) return res.redirect('/matches');

    const match = {
      id: row.id,
      title: row.title,
      teams: [row.team_a || 'Team A', row.team_b || 'Team B'],
      sport: row.sport,
      status: row.status || 'Upcoming',
      score_a: row.score_a,
      score_b: row.score_b,
      overs: row.overs,
      league: row.league
    };

    let markets = [];
    try {
      const marketRes = await pool.query(
        `SELECT * FROM markets WHERE match_id = $1 AND status = 'open' ORDER BY id ASC`,
        [req.params.id]
      );
      markets = marketRes.rows;
    } catch (mErr) {
      console.error('markets fetch error:', mErr.message);
    }

    res.render('match-detail', {
      match,
      markets,
      user: req.session ? req.session.user : null
    });
  } catch (err) {
    console.error('match-detail error:', err.message);
    res.redirect('/matches');
  }
});

router.post('/:id/bet', isAuth, async (req, res) => {
  const userId = req.session.user.id;
  const matchId = req.params.id;
  const { market_id, runner, demo } = req.body;
  const stake = parseInt(req.body.stake);
  const isDemo = !!demo;

  const minBet = Number(await getSetting('min_bet'));
  const maxBet = Number(await getSetting('max_bet'));
  if (isNaN(stake) || stake < minBet) {
    return res.status(400).json({ success: false, message: req.t('bet_min_amount').replace('{value}', minBet) });
  }
  if (stake > maxBet) {
    return res.status(400).json({ success: false, message: req.t('bet_max_amount').replace('{value}', maxBet) });
  }
  if (!market_id) {
    return res.status(400).json({ success: false, message: req.t('matches_market_not_found') });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const m = await client.query(`SELECT * FROM markets WHERE id = $1`, [market_id]);
    if (!m.rows[0] || m.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: req.t('matches_market_closed') });
    }

    // অডস সার্ভার থেকেই নির্ধারিত। আগে req.body.odd সরাসরি bets.odd-এ যেত, আর
    // সেটেলমেন্ট পেআউট হিসাব করে stake * bets.odd দিয়ে — ফলে বড় odd পাঠিয়ে
    // যেকোনো পরিমাণ কয়েন তোলা যেত। ক্লায়েন্টের পাঠানো odd এখন উপেক্ষিত।
    const oddNum = resolveOdd(m.rows[0], runner);
    if (oddNum === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: req.t('matches_invalid_odds') });
    }

    const balanceCol = isDemo ? 'demo_balance' : 'coins';
    const upd = await client.query(
      `UPDATE users SET ${balanceCol} = ${balanceCol} - $1 WHERE id = $2 AND ${balanceCol} >= $1 RETURNING ${balanceCol}`,
      [stake, userId]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: isDemo ? req.t('balance_insufficient_demo') : req.t('payment_insufficient_coins') });
    }

    await client.query(
      `INSERT INTO bets (user_id, match_id, market_id, market_type, runner, odd, stake, status, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
      [userId, matchId, market_id, m.rows[0].type, runner || null, oddNum, stake, isDemo]
    );

    if (isDemo) {
      await client.query(
        `INSERT INTO demo_transactions (user_id, category, type, amount, description)
         VALUES ($1, 'sports', 'bet', $2, $3)`,
        [userId, stake, `বেট: ${m.rows[0].name} (ডেমো)`]
      );
      await client.query('COMMIT');

      req.session.user.demo_balance = upd.rows[0].demo_balance;
      broadcastDemoStats().catch(e => console.error('demo stats:', e.message));

      return res.json({ success: true, message: req.t('matches_demo_bet_placed'), demo: true, newBalance: upd.rows[0].demo_balance });
    }

    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'bet', $3)`,
      [userId, -stake, `বেট: ${m.rows[0].name}`]
    );

    await client.query('COMMIT');

    if (req.session.user) req.session.user.coins = upd.rows[0].coins;
    broadcastDemoStats().catch(e => console.error('demo stats:', e.message));

    addTurnover(userId, 'sports', stake).catch(e => console.error('turnover:', e.message));
    updateDailyTurnover(userId, stake).catch(e => console.error('dailyReward:', e.message));
    distributeCommission(userId, stake).catch(e => console.error('commission:', e.message));
    addBet(userId, stake, 'sports').catch(e => console.error('cashback:', e.message));
    addVipTurnover(userId, stake).catch(e => console.error('vip:', e.message));
    updateMissionProgress(userId, stake).catch(e => console.error('mission:', e.message));
    addPoints(userId, stake).catch(e => console.error('loyalty:', e.message));
    checkBadges(userId).catch(e => console.error('badges:', e.message));

    res.json({ success: true, message: req.t('matches_bet_placed'), newBalance: upd.rows[0].coins });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('bet error:', err.message);
    res.status(500).json({ success: false, message: req.t('common_server_error_short') });
  } finally {
    client.release();
  }
});

module.exports = router;
