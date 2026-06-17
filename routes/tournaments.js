const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

router.get('/', async (req, res) => {
  try {
    const tournaments = await pool.query(`SELECT t.*, COUNT(tp.user_id) as participant_count FROM tournaments t LEFT JOIN tournament_participants tp ON t.id=tp.tournament_id GROUP BY t.id ORDER BY t.start_date DESC`);
    res.render('tournaments', { tournaments: tournaments.rows });
  } catch (err) {
    console.error('Tournaments error:', err);
    req.flash('error', 'টুর্নামেন্ট লোড করতে সমস্যা হয়েছে।');
    res.render('tournaments', { tournaments: [] });
  }
});

router.get('/:id', isAuth, async (req, res) => {
  try {
    const t = await pool.query(`SELECT * FROM tournaments WHERE id=$1`, [req.params.id]);
    if (!t.rows[0]) return res.redirect('/tournaments');
    const participants = await pool.query(`SELECT tp.*, u.username, u.avatar, u.total_points FROM tournament_participants tp JOIN users u ON tp.user_id=u.id WHERE tp.tournament_id=$1 ORDER BY tp.points DESC`, [req.params.id]);
    const joined = await pool.query(`SELECT * FROM tournament_participants WHERE tournament_id=$1 AND user_id=$2`, [req.params.id, req.session.user.id]);
    res.render('tournament-detail', { tournament: t.rows[0], participants: participants.rows, joined: !!joined.rows[0] });
  } catch (err) {
    res.redirect('/tournaments');
  }
});

router.post('/:id/join', isAuth, async (req, res) => {
  try {
    const tId = req.params.id;
    const userId = req.session.user.id;
    const t = await pool.query(`SELECT * FROM tournaments WHERE id=$1`, [tId]);
    const tournament = t.rows[0];
    if (!tournament) return res.redirect('/tournaments');
    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
    if (user.rows[0].coins < tournament.entry_fee) {
      req.flash('error', 'Not enough coins to join!');
      return res.redirect(`/tournaments/${tId}`);
    }
    await pool.query(`INSERT INTO tournament_participants (tournament_id, user_id) VALUES ($1,$2)`, [tId, userId]);
    if (tournament.entry_fee > 0) {
      await pool.query(`UPDATE users SET coins=coins-$1 WHERE id=$2`, [tournament.entry_fee, userId]);
      await pool.query(`INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,'tournament_entry','Joined tournament')`, [userId, -tournament.entry_fee]);
      req.session.user.coins -= tournament.entry_fee;
    }
    req.flash('success', `Joined ${tournament.name}!`);
  } catch (err) {
    req.flash('error', 'ইতিমধ্যে জয়েন করেছেন অথবা সমস্যা হয়েছে');
  }
  res.redirect(`/tournaments/${req.params.id}`);
});

module.exports = router;
