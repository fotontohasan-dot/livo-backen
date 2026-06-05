const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

router.get('/', async (req, res) => {
  const { sport, status } = req.query;
  let query = `SELECT * FROM matches WHERE 1=1`;
  const params = [];
  if (sport) { params.push(sport); query += ` AND sport=$${params.length}`; }
  if (status) { params.push(status); query += ` AND status=$${params.length}`; }
  query += ` ORDER BY match_date DESC`;
  const matches = await pool.query(query, params);
  res.render('matches', { matches: matches.rows, sport, status });
});

router.get('/:id', isAuth, async (req, res) => {
  const match = await pool.query(`SELECT * FROM matches WHERE id=$1`, [req.params.id]);
  if (!match.rows[0]) return res.redirect('/matches');
  const userPred = await pool.query(`SELECT * FROM predictions WHERE user_id=$1 AND match_id=$2`, [req.session.user.id, req.params.id]);
  const predictions = await pool.query(`SELECT p.*, u.username FROM predictions p JOIN users u ON p.user_id=u.id WHERE match_id=$1 ORDER BY coins_bet DESC LIMIT 10`, [req.params.id]);
  res.render('match-detail', { match: match.rows[0], userPrediction: userPred.rows[0], predictions: predictions.rows });
});

router.post('/:id/predict', isAuth, async (req, res) => {
  const { predicted_winner, coins_bet } = req.body;
  const matchId = req.params.id;
  const userId = req.session.user.id;
  const bet = parseInt(coins_bet);
  try {
    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
    if (user.rows[0].coins < bet) {
      req.flash('error', 'Not enough coins!');
      return res.redirect(`/matches/${matchId}`);
    }
    const match = await pool.query(`SELECT * FROM matches WHERE id=$1`, [matchId]);
    if (match.rows[0].status !== 'upcoming') {
      req.flash('error', 'Predictions closed for this match');
      return res.redirect(`/matches/${matchId}`);
    }
    await pool.query(`INSERT INTO predictions (user_id, match_id, predicted_winner, coins_bet) VALUES ($1,$2,$3,$4)`, [userId, matchId, predicted_winner, bet]);
    await pool.query(`UPDATE users SET coins=coins-$1 WHERE id=$2`, [bet, userId]);
    await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'bet','Bet on match')`, [userId, -bet]);
    req.session.user.coins -= bet;
    req.flash('success', `Prediction placed! ${bet} coins bet`);
    res.redirect(`/matches/${matchId}`);
  } catch (err) {
    req.flash('error', 'Already predicted this match');
    res.redirect(`/matches/${matchId}`);
  }
});

module.exports = router;
