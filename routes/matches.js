const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const matches = await pool.query(`
      SELECT * FROM matches 
      ORDER BY start_time ASC, id DESC
    `);
    res.render('matches', { matches: matches.rows, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.render('matches', { matches: [], user: req.session.user });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const matchRes = await pool.query('SELECT * FROM matches WHERE id = $1', [req.params.id]);
    const match = matchRes.rows[0];

    if (!match) return res.status(404).send('Match not found');

    // ডাইনামিক মার্কেট লোড
    const marketsRes = await pool.query(`
      SELECT * FROM markets 
      WHERE match_id = $1 AND status = 'open' 
      ORDER BY type, name
    `, [req.params.id]);

    res.render('match-detail', { 
      match, 
      markets: marketsRes.rows,
      user: req.session.user 
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// বেট প্লেস রাউট
router.post('/:id/bet', async (req, res) => {
  if (!req.session.user) return res.json({ success: false, error: 'লগইন করুন' });

  const { market_id, runner, odd, stake } = req.body;
  const userId = req.session.user.id;

  if (!stake || stake < 10) return res.json({ success: false, error: 'মিনিমাম ১০ কয়েন' });

  try {
    const user = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    if (user.rows[0].coins < stake) {
      return res.json({ success: false, error: 'পর্যাপ্ত কয়েন নেই' });
    }

    await pool.query(`
      INSERT INTO bets (user_id, match_id, market_id, runner, odd, stake, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
    `, [userId, req.params.id, market_id, runner, odd, stake]);

    await pool.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [stake, userId]);

    res.json({ success: true, message: '✅ বেট সফলভাবে প্লেস হয়েছে!' });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: 'সিস্টেম এরর' });
  }
});

module.exports = router;
