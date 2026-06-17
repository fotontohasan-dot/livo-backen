const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

router.get('/', async (req, res) => {
  try {
    const tournaments = await pool.query(`
      SELECT
        t.*,
        COALESCE(t.name, t.title, 'টুর্নামেন্ট') as display_name,
        COUNT(tp.user_id) as participant_count
      FROM tournaments t
      LEFT JOIN tournament_participants tp ON t.id = tp.tournament_id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `);
    res.render('tournaments', { tournaments: tournaments.rows });
  } catch (err) {
    console.error('Tournaments error:', err);
    res.render('tournaments', { tournaments: [] });
  }
});

router.get('/:id', isAuth, async (req, res) => {
  try {
    const t = await pool.query(`SELECT * FROM tournaments WHERE id=$1`, [req.params.id]);
    if (!t.rows[0]) return res.redirect('/tournaments');

    const participants = await pool.query(`
      SELECT tp.*, u.username, u.avatar, u.total_points,
        COALESCE(tp.points, 0) as points
      FROM tournament_participants tp
      JOIN users u ON tp.user_id = u.id
      WHERE tp.tournament_id = $1
      ORDER BY tp.points DESC
    `, [req.params.id]);

    const joined = await pool.query(`
      SELECT * FROM tournament_participants
      WHERE tournament_id=$1 AND user_id=$2
    `, [req.params.id, req.session.user.id]);

    const tournament = t.rows[0];
    tournament.name = tournament.name || tournament.title || 'টুর্নামেন্ট';

    res.render('tournament-detail', {
      tournament,
      participants: participants.rows,
      joined: !!joined.rows[0]
    });
  } catch (err) {
    console.error('Tournament detail error:', err);
    req.flash('error', 'টুর্নামেন্ট লোড করতে সমস্যা হয়েছে।');
    res.redirect('/tournaments');
  }
});

router.post('/:id/join', isAuth, async (req, res) => {
  const tId = req.params.id;
  const userId = req.session.user.id;
  try {
    const t = await pool.query(`SELECT * FROM tournaments WHERE id=$1`, [tId]);
    const tournament = t.rows[0];
    if (!tournament) return res.redirect('/tournaments');

    const user = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
    const entryFee = tournament.entry_fee || 0;

    if (user.rows[0].coins < entryFee) {
      req.flash('error', 'যথেষ্ট কয়েন নেই!');
      return res.redirect(`/tournaments/${tId}`);
    }

    await pool.query(`
      INSERT INTO tournament_participants (tournament_id, user_id, points, joined_at)
      VALUES ($1, $2, 0, NOW())
    `, [tId, userId]);

    if (entryFee > 0) {
      await pool.query(`UPDATE users SET coins = coins - $1 WHERE id=$2`, [entryFee, userId]);
      await pool.query(`
        INSERT INTO coin_transactions (user_id, amount, type, description)
        VALUES ($1, $2, 'tournament_entry', 'Joined tournament')
      `, [userId, -entryFee]);
      req.session.user.coins -= entryFee;
    }

    const name = tournament.name || tournament.title || 'টুর্নামেন্ট';
    req.flash('success', `${name}-এ যোগ দিয়েছেন!`);
  } catch (err) {
    console.error('Join tournament error:', err);
    req.flash('error', 'আগেই যোগ দিয়েছেন অথবা সমস্যা হয়েছে।');
  }
  res.redirect(`/tournaments/${tId}`);
});

module.exports = router;
