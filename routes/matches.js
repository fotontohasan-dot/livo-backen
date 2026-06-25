// routes/matches.js
const express = require('express');
const router = express.Router();
const db = require('../db');

// ম্যাচ লিস্ট
router.get('/', async (req, res) => {
  try {
    const matches = await db.query(`
      SELECT * FROM matches 
      ORDER BY start_time ASC
    `);
    res.render('matches', { matches: matches.rows, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.render('matches', { matches: [], user: req.session.user });
  }
});

// ম্যাচ ডিটেইল পেজ (এখন বেটিং সহ)
router.get('/:id', async (req, res) => {
  try {
    const matchResult = await db.query('SELECT * FROM matches WHERE id = $1', [req.params.id]);
    const match = matchResult.rows[0];

    if (!match) return res.status(404).send('Match not found');

    // TODO: পরে markets টেবিল থেকে ডাইনামিক ওডস আনবে
    res.render('match-detail', { 
      match: match, 
      user: req.session.user 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// বেট প্লেস করা
router.post('/:id/bet', async (req, res) => {
  if (!req.session.user) return res.json({ success: false, error: 'Login required' });

  const { market, runner, odd, stake } = req.body;
  const userId = req.session.user.id;
  const matchId = req.params.id;

  if (!stake || stake < 10) {
    return res.json({ success: false, error: 'Minimum stake 10 coins' });
  }

  try {
    // ব্যালেন্স চেক
    const userRes = await db.query('SELECT coins FROM users WHERE id = $1', [userId]);
    if (userRes.rows[0].coins < stake) {
      return res.json({ success: false, error: 'Insufficient coins' });
    }

    // বেট সেভ করা
    await db.query(`
      INSERT INTO bets (user_id, match_id, market, runner, odd, stake, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
    `, [userId, matchId, market, runner, odd, stake]);

    // কয়েন কাটা
    await db.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [stake, userId]);

    res.json({ 
      success: true, 
      message: 'বেট সফলভাবে প্লেস হয়েছে!' 
    });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'Something went wrong' });
  }
});

module.exports = router;
