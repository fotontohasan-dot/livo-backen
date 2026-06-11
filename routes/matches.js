const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

router.get('/predictions', isAuth, async (req, res) => {
  const url = 'https://today-football-prediction.p.rapidapi.com/';
  const options = {
    method: 'GET',
    headers: {
      'x-rapidapi-key': 'fd215d3ff9mshb341cac3fbaeb72p190b85jsn1fbbc0b7e341',
      'x-rapidapi-host': 'today-football-prediction.p.rapidapi.com'
    }
  };

  try {
    const response = await fetch(url, options);
    const result = await response.json();
    res.render('predictions', { predictions: result.recommendations || [] });
  } catch (error) {
    console.error('Prediction fetch error:', error);
    req.flash('error', 'প্রেডিকশন ডেটা লোড করতে ব্যর্থ হয়েছে।');
    res.redirect('/matches');
  }
});

router.get('/', async (req, res) => {
  const { sport, status } = req.query;
  let query = `SELECT * FROM matches WHERE 1=1`;
  const params = [];
  if (sport) {
    params.push(sport);
    query += ` AND sport=$${params.length}`;
  }
  if (status) {
    params.push(status);
    query += ` AND status=$${params.length}`;
  } else {
    query += ` AND status='upcoming'`;
  }
  query += ` ORDER BY match_date ASC`;

  try {
    const matches = await pool.query(query, params);
    res.render('matches', { matches: matches.rows, sport, status });
  } catch (_err) {
    req.flash('error', 'ম্যাচ লোড করতে সমস্যা হয়েছে।');
    res.redirect('/');
  }
});

router.get('/:id', isAuth, async (req, res) => {
  try {
    const match = await pool.query(`SELECT * FROM matches WHERE id=$1`, [req.params.id]);
    if (!match.rows[0]) return res.redirect('/matches');

    const userPred = await pool.query(`SELECT * FROM predictions WHERE user_id=$1 AND match_id=$2`, [req.session.user.id, req.params.id]);
    const predictions = await pool.query(`SELECT p.*, u.username FROM predictions p JOIN users u ON p.user_id=u.id WHERE match_id=$1 ORDER BY coins_bet DESC LIMIT 10`, [req.params.id]);

    res.render('match-detail', {
      match: match.rows[0],
      userPrediction: userPred.rows[0],
      predictions: predictions.rows
    });
  } catch (_err) {
    res.redirect('/matches');
  }
});

router.post('/:id/predict', isAuth, async (req, res) => {
  const { winner, bet } = req.body;
  const matchId = req.params.id;
  const userId = req.session.user.id;
  const coinsBet = parseInt(bet);

  try {
    const user = await pool.query(`SELECT coins FROM users WHERE id=$1`, [userId]);
    if (user.rows[0].coins < coinsBet) {
      req.flash('error', 'আপনার পর্যাপ্ত কয়েন নেই!');
      return res.redirect(`/matches/${matchId}`);
    }

    const match = await pool.query(`SELECT status FROM matches WHERE id=$1`, [matchId]);
    if (match.rows[0].status !== 'upcoming') {
      req.flash('error', 'এই ম্যাচের প্রেডিকশন বন্ধ হয়ে গেছে');
      return res.redirect(`/matches/${matchId}`);
    }

    await pool.query('BEGIN');
    await pool.query(`UPDATE users SET coins=coins-$1 WHERE id=$2`, [coinsBet, userId]);
    await pool.query(`INSERT INTO predictions (user_id, match_id, predicted_winner, coins_bet) VALUES ($1,$2,$3,$4)`,
      [userId, matchId, winner, coinsBet]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,-$2,'prediction','Bet on match ${matchId}')`, [userId, coinsBet]);
    await pool.query('COMMIT');

    req.flash('success', `প্রেডিকশন সফল হয়েছে! ${coinsBet} কয়েন বাজি ধরা হয়েছে`);
    res.redirect(`/matches/${matchId}`);
  } catch (err) {
    await pool.query('ROLLBACK');
    if (err.code === '23505') {
      req.flash('error', 'আপনি ইতিমধ্যে এই ম্যাচে প্রেডিকশন করেছেন');
    } else {
      req.flash('error', 'প্রেডিকশন করতে সমস্যা হয়েছে');
    }
    res.redirect(`/matches/${matchId}`);
  }
});

module.exports = router;
