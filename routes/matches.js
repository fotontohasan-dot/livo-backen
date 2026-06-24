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
    res.render('match-detail', {
      title: match.name || 'Match Detail',
      currentPage: 'matches',
      match,
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

module.exports = router;
