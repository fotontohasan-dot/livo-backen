const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// ====================================================
//  DB row -> client (matches.ejs) এর জন্য ফরম্যাট
// ====================================================
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

// ====================================================
//  পেজ রাউটগুলো
// ====================================================

// মূল ম্যাচ পেজ  ->  GET /matches
router.get('/', (req, res) => {
  res.render('matches', {
    currentPage: 'matches',
    sport: 'all',
    title: 'আসন্ন ম্যাচসমূহ',
    user: req.session ? req.session.user : null
  });
});

// World Cup ক্যাটাগরি  ->  GET /matches/worldcup
router.get('/worldcup', (req, res) => {
  res.render('matches', {
    currentPage: 'worldcup',
    sport: 'cricket',
    title: 'World Cup',
    user: req.session ? req.session.user : null
  });
});

// Cricket ক্যাটাগরি  ->  GET /matches/cricket
router.get('/cricket', (req, res) => {
  res.render('matches', {
    currentPage: 'cricket',
    sport: 'cricket',
    title: 'Cricket',
    user: req.session ? req.session.user : null
  });
});

// Football ক্যাটাগরি  ->  GET /matches/football
router.get('/football', (req, res) => {
  res.render('matches', {
    currentPage: 'football',
    sport: 'football',
    title: 'Football',
    user: req.session ? req.session.user : null
  });
});

// ====================================================
//  API রাউট  ->  GET /matches/api/live
//  matches.ejs এর fetch('/matches/api/live') এখানে আসে
//  রিটার্ন: { success, cricket: [...], football: [...] }
// ====================================================
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
      else cricket.push(m); // cricket + অন্য সব
    }

    res.json({ success: true, cricket, football });
  } catch (err) {
    console.error('matches/api/live error:', err.message);
    // DB না থাকলেও ক্লায়েন্ট ক্র্যাশ করবে না
    res.json({ success: true, cricket: [], football: [] });
  }
});

// ====================================================
//  একক ম্যাচ ডিটেইল  ->  GET /matches/:id
//  (এটা সবসময় শেষে রাখতে হবে, না হলে উপরের রাউটগুলো ধরে ফেলবে)
// ====================================================
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

module.exports = router;
