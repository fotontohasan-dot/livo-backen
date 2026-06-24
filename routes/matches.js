// routes/matches.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const sportsAPI = require('../services/sportsAPI');

// Helper: get matches from DB by sport+status
async function fetchFromDB(sport, status) {
  let sql = 'SELECT * FROM matches WHERE 1=1';
  const params = [];
  if (sport && sport !== 'all') {
    params.push(sport);
    sql += ` AND sport = $${params.length}`;
  }
  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  sql += ' ORDER BY match_date DESC LIMIT 30';
  try {
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (err) {
    return [];
  }
}

// Map DB row → format expected by matches.ejs
function dbToView(row) {
  return {
    id: row.id,
    sport: row.sport,
    name: row.title,
    league: row.title,
    teams: [row.team_a, row.team_b],
    homeTeam: row.team_a,
    awayTeam: row.team_b,
    homeScore: row.score_a,
    awayScore: row.score_b,
    status: row.result || row.status,
    venue: null,
    date: row.match_date,
    score: row.score_a ? [
      { inning: row.team_a, r: row.score_a.split('/')[0], w: row.score_a.split('/')[1] || 0, o: row.overs || '' }
    ] : [],
  };
}

// Main matches page
router.get('/', async (req, res) => {
  const sport = req.query.sport || 'all';
  const live = (await fetchFromDB(sport, 'live')).map(dbToView);
  const upcoming = (await fetchFromDB(sport, 'upcoming')).map(dbToView);

  res.render('matches', {
    title: 'Live Matches',
    currentPage: 'matches',
    liveMatches: live,
    upcomingMatches: upcoming,
    sport,
    user: req.session.user || null,
  });
});

// World Cup page
router.get('/worldcup', async (req, res) => {
  try {
    const fixtures = await sportsAPI.getWorldCupFixtures();
    const live = await sportsAPI.getFootballLiveScores().catch(() => []);
    const worldCupLive = live.filter(m =>
      (m.league || '').toLowerCase().includes('world cup')
    );
    res.render('matches', {
      title: 'FIFA World Cup 2026',
      currentPage: 'worldcup',
      liveMatches: worldCupLive,
      upcomingMatches: fixtures,
      sport: 'football',
      user: req.session.user || null,
    });
  } catch (err) {
    console.error('World Cup error:', err);
    res.render('matches', {
      title: 'World Cup',
      currentPage: 'worldcup',
      liveMatches: [],
      upcomingMatches: [],
      sport: 'football',
      user: req.session.user || null,
    });
  }
});

// Cricket page
router.get('/cricket', async (req, res) => {
  const live = (await fetchFromDB('cricket', 'live')).map(dbToView);
  const upcoming = (await fetchFromDB('cricket', 'upcoming')).map(dbToView);
  res.render('matches', {
    title: 'Cricket Matches',
    currentPage: 'cricket',
    liveMatches: live,
    upcomingMatches: upcoming,
    sport: 'cricket',
    user: req.session.user || null,
  });
});

// Football page
router.get('/football', async (req, res) => {
  const live = (await fetchFromDB('football', 'live')).map(dbToView);
  const upcoming = (await fetchFromDB('football', 'upcoming')).map(dbToView);
  res.render('matches', {
    title: 'Football Matches',
    currentPage: 'football',
    liveMatches: live,
    upcomingMatches: upcoming,
    sport: 'football',
    user: req.session.user || null,
  });
});

// Match detail by DB id
router.get('/:id', async (req, res, next) => {
  // Skip if :id is a known route name
  if (['worldcup','cricket','football','api'].includes(req.params.id)) return next();
  try {
    const r = await pool.query('SELECT * FROM matches WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) {
      return res.status(404).render('error', { message: 'ম্যাচটি পাওয়া যায়নি।', siteName: 'Livo' });
    }
    const match = dbToView(r.rows[0]);

    // ইউজার এই ম্যাচে আগে কী কী প্রেডিকশন করেছে
    let myPredictions = [];
    if (req.session.user) {
      const p = await pool.query(
        'SELECT market, pick FROM predictions WHERE user_id=$1 AND match_id=$2',
        [req.session.user.id, req.params.id]
      );
      myPredictions = p.rows;
    }

    res.render('match-detail', {
      title: match.name || 'Match Detail',
      currentPage: 'matches',
      match,
      myPredictions,
      user: req.session.user || null,
    });
  } catch (err) {
    console.error('Match detail error:', err);
    res.status(500).render('error', { message: 'সার্ভার সমস্যা হয়েছে।', siteName: 'Livo' });
  }
});

// JSON live API endpoint
router.get('/api/live', async (req, res) => {
  try {
    const cricket = (await fetchFromDB('cricket', null)).map(dbToView);
    const football = (await fetchFromDB('football', null)).map(dbToView);
    res.json({ success: true, cricket, football, timestamp: Date.now() });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ==================== প্রেডিকশন সাবমিট ====================
// প্রতিটা মার্কেটের জন্য কত পয়েন্ট পাওয়া যাবে
const MARKET_POINTS = {
  winner: 10,
  draw: 20,
  runs: 15,
  wickets: 15,
};

const PREDICT_COST = 10; // প্রতি প্রেডিকশনে কত কয়েন লাগবে

// প্রেডিকশন সাবমিট করা — কয়েন/পয়েন্ট দিয়ে
router.post('/:id/predict', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, error: 'প্রেডিকশন করতে লগইন করুন।' });
  }

  const userId = req.session.user.id;
  const matchId = parseInt(req.params.id, 10);
  const { market, pick } = req.body;

  if (!market || !pick) {
    return res.status(400).json({ success: false, error: 'মার্কেট ও পছন্দ দুটোই দরকার।' });
  }

  const reward = MARKET_POINTS[market] || 10;

  try {
    // ম্চ আছে কিনা ও শেষ হয়ে গেছে কিনা চেক
    const mRes = await pool.query('SELECT status FROM matches WHERE id = $1', [matchId]);
    if (mRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'ম্যাচ পাওয়া যায়নি।' });
    }
    if (mRes.rows[0].status === 'finished') {
      return res.status(400).json({ success: false, error: 'এই ম্যাচ শেষ হয়ে গেছে।' });
    }

    // ইউজারের কযন আছে কিনা
    const uRes = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    const coins = uRes.rows[0] ? uRes.rows[0].coins : 0;
    if (coins < PREDICT_COST) {
      return res.status(400).json({ success: false, error: 'পরপ্ত কয়েন নেই।' });
    }

    // আগে একই মার্কেটে প্রেডিকশন করেছে কিনা
    const existing = await pool.query(
      'SELECT id FROM predictions WHERE user_id=$1 AND match_id=$2 AND market=$3',
      [userId, matchId, market]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'এই মার্কেটে আপনি আগেই প্রেডিকশন করেছেন।' });
    }

    // কয়েন কাটা + প্রেডিকশন সেভ
    await pool.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [PREDICT_COST, userId]);
    await pool.query(
      `INSERT INTO predictions (user_id, match_id, market, pick, points, status)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [userId, matchId, market, pick, reward]
    );

    // সেশনে কয়েন আপডেট
    req.session.user.coins = coins - PREDICT_COST;

    res.json({
      success: true,
      message: 'প্রেডিকশন সাবমিট হয়েছে!',
      newBalance: coins - PREDICT_COST,
      reward,
    });
  } catch (err) {
    console.error('Predict error:', err.message);
    res.status(500).json({ success: false, error: 'সার্ভর সমস্যা হয়েছে।' });
  }
});

module.exports = router;
