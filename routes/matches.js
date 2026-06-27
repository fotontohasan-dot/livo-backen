const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');
const { addTurnover } = require('../services/turnover');
const { updateDailyTurnover } = require('../services/dailyReward');
const { distributeCommission } = require('../services/referral');
const { addBet } = require('../services/cashback');
const { addVipTurnover } = require('../services/vip');

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
    title: 'আসন্ন ম্যাচসমূহ',
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
    const result = await pool.query(
      `SELECT * FROM matches ORDER BY
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

    res.json({ success: true, cricket, football });
  } catch (err) {
    console.error('matches/api/live error:', err.message);
    res.json({ success: true, cricket: [], football: [] });
  }
});

router.get('/:id', async (req, res) => {
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
  const { market_id, runner, odd } = req.body;
  const stake = parseInt(req.body.stake);
  const oddNum = parseFloat(odd);

  if (isNaN(stake) || stake < 10) {
    return res.status(400).json({ success: false, message: 'মিনিমাম ১০ কয়েন বেট করতে হবে' });
  }
  if (isNaN(oddNum) || oddNum <= 1) {
    return res.status(400).json({ success: false, message: 'অকার্যকর ওডস' });
  }
  if (!market_id) {
    return res.status(400).json({ success: false, message: 'মার্কেট পাওয়া যায়নি' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const m = await client.query(`SELECT * FROM markets WHERE id = $1`, [market_id]);
    if (!m.rows[0] || m.rows[0].status !== 'open') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'এই মার্কেটে এখন বেট করা যাবে না' });
    }

    const upd = await client.query(
      `UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins`,
      [stake, userId]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'পর্যাপ্ত কয়েন নেই' });
    }

    await client.query(
      `INSERT INTO bets (user_id, match_id, market_id, market_type, runner, odd, stake, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [userId, matchId, market_id, m.rows[0].type, runner || null, oddNum, stake]
    );

    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'bet', $3)`,
      [userId, -stake, `বেট: ${m.rows[0].name}`]
    );

    await client.query('COMMIT');

    if (req.session.user) req.session.user.coins = upd.rows[0].coins;

    addTurnover(userId, 'sports', stake).catch(e => console.error('turnover:', e.message));
    updateDailyTurnover(userId, stake).catch(e => console.error('dailyReward:', e.message));
    distributeCommission(userId, stake).catch(e => console.error('commission:', e.message));
    addBet(userId, stake).catch(e => console.error('cashback:', e.message));
    addVipTurnover(userId, stake).catch(e => console.error('vip:', e.message));

    res.json({ success: true, message: 'বেট সফল হয়েছে!', newBalance: upd.rows[0].coins });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('bet error:', err.message);
    res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  } finally {
    client.release();
  }
});

module.exports = router;
