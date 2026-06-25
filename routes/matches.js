const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// ---- কোন কোন ক্যাটাগরি লিস্ট পেজ দেখাবে ----
const SPORT_CATEGORIES = {
  all: 'matches',
  cricket: 'cricket',
  football: 'football',
  worldcup: 'worldcup',
  inplay: 'inplay'
};

// ম্যাচ লিস্ট রেন্ডার করার সাধারণ ফাংশন
async function renderMatchList(req, res, sport, currentPage) {
  try {
    let result;
    if (sport === 'cricket' || sport === 'football') {
      result = await pool.query(
        'SELECT * FROM matches WHERE sport = $1 ORDER BY start_time ASC',
        [sport]
      );
    } else {
      result = await pool.query('SELECT * FROM matches ORDER BY start_time ASC');
    }
    res.render('matches', {
      matches: result.rows,
      user: req.session.user,
      sport,
      currentPage
    });
  } catch (err) {
    console.error('Matches list error:', err.message);
    // এরর হলেও পেজ ক্র্যাশ না করে খালি লিস্ট দেখাবে
    res.render('matches', {
      matches: [],
      user: req.session.user,
      sport,
      currentPage
    });
  }
}

// সব ম্যাচ
router.get('/', (req, res) => renderMatchList(req, res, 'all', 'matches'));

// ক্যাটাগরি অনুযায়ী (cricket / football / worldcup / inplay)
router.get('/category/:sport', (req, res) => {
  const sport = req.params.sport;
  const page = SPORT_CATEGORIES[sport] || 'matches';
  renderMatchList(req, res, sport, page);
});

// সরাসরি /matches/cricket, /matches/football ইত্যাদিও কাজ করবে
router.get('/cricket', (req, res) => renderMatchList(req, res, 'cricket', 'cricket'));
router.get('/football', (req, res) => renderMatchList(req, res, 'football', 'football'));
router.get('/worldcup', (req, res) => renderMatchList(req, res, 'worldcup', 'worldcup'));
router.get('/inplay', (req, res) => renderMatchList(req, res, 'inplay', 'inplay'));
router.get('/all', (req, res) => renderMatchList(req, res, 'all', 'matches'));

// ম্যাচ ডিটেইল — শুধু সংখ্যা হলে (যাতে 'cricket' ইত্যাদি এখানে না আসে)
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const matchResult = await pool.query('SELECT * FROM matches WHERE id = $1', [req.params.id]);
    const match = matchResult.rows[0];

    if (!match) return res.status(404).render('error', {
      message: 'ম্যাচটি পাওয়া যায়নি',
      user: req.session.user
    });

    const marketsResult = await pool.query(
      'SELECT * FROM markets WHERE match_id = $1 ORDER BY type, name',
      [req.params.id]
    );

    res.render('match-detail', {
      match,
      markets: marketsResult.rows,
      user: req.session.user
    });
  } catch (err) {
    console.error('Match detail error:', err.message);
    res.status(500).render('error', {
      message: 'সার্ভার সমস্যা হয়েছে',
      user: req.session.user
    });
  }
});

// বেট প্লেস
router.post('/:id(\\d+)/bet', async (req, res) => {
  if (!req.session.user) return res.json({ success: false, error: 'Login required' });

  const { market_id, runner, odd, stake } = req.body;
  const userId = req.session.user.id;
  const matchId = req.params.id;

  if (!stake || stake < 10) {
    return res.json({ success: false, error: 'Minimum 10 coins' });
  }

  try {
    const userRes = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    if (userRes.rows[0].coins < stake) {
      return res.json({ success: false, error: 'Insufficient balance' });
    }

    await pool.query(`
      INSERT INTO bets (user_id, match_id, market_id, runner, odd, stake, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
    `, [userId, matchId, market_id, runner, odd, stake]);

    await pool.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [stake, userId]);

    res.json({ success: true, message: 'বেট সফলভাবে প্লেস হয়েছে!' });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Something went wrong' });
  }
});

module.exports = router;
