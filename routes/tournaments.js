const express = require('express');
const { requireIntParam } = require('../middleware/validate');
const router = express.Router();
const { pool } = require('../db');
const { isAuth } = require('../middleware/auth');

// দ্রষ্টব্য: tournaments টেবিলে কোনো `title` কলাম নেই (migrations.js — id, name, sport,
// description, entry_fee, prize_pool, max_participants, start_date, end_date, status,
// created_at)। নিচের কোয়েরিতে আগে অস্তিত্বহীন title কলামটাও রেফার করা হতো, ফলে প্রতিবার
// "column does not exist" (SQLSTATE 42703) এরর হতো এবং catch ব্লক নীরবে
// `tournaments: []` রেন্ডার করত — /tournaments পেজে কখনোই কোনো টুর্নামেন্ট দেখা যেত না,
// অথচ HTTP 200 আসায় সমস্যাটা ধরা পড়ত না। name কলামটা NOT NULL, তাই সেটাই যথেষ্ট।
router.get('/', async (req, res) => {
  try {
    const tournaments = await pool.query(`
      SELECT
        t.*,
        COALESCE(t.name, 'টুর্নামেন্ট') as display_name,
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

// ত্রুটিপূর্ণ id (abc, 1e309, ইত্যাদি) আগে সরাসরি PostgreSQL-এ পৌঁছে 22P02/22003 এরর
// ঘটাত, তারপর catch ব্লক ধরে রিডাইরেক্ট করত। ইউজার নিরাপদ উত্তরই পেত, কিন্তু প্রতিটা
// এমন রিকোয়েস্টে অপ্রয়োজনীয় DB রাউন্ড-ট্রিপ হতো। এখন রুটে ঢোকার আগেই যাচাই হয়;
// গন্তব্য আগের catch ব্লকের মতোই।
router.get('/:id', requireIntParam('id', '/tournaments'), isAuth, async (req, res) => {
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
    tournament.name = tournament.name || 'টুর্নামেন্ট'; // title কলামটা বিদ্যমান নয়

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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const t = await client.query(`SELECT * FROM tournaments WHERE id=$1`, [tId]);
    const tournament = t.rows[0];
    if (!tournament) {
      await client.query('ROLLBACK');
      return res.redirect('/tournaments');
    }

    const already = await client.query(
      `SELECT 1 FROM tournament_participants WHERE tournament_id=$1 AND user_id=$2`,
      [tId, userId]
    );
    if (already.rows[0]) {
      await client.query('ROLLBACK');
      req.flash('error', 'আপনি আগেই এই টুর্নামেন্টে যোগ দিয়েছেন।');
      return res.redirect(`/tournaments/${tId}`);
    }

    const entryFee = parseInt(tournament.entry_fee) || 0;

    if (entryFee > 0) {
      const upd = await client.query(
        `UPDATE users SET coins = coins - $1 WHERE id=$2 AND coins >= $1 RETURNING coins`,
        [entryFee, userId]
      );
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        req.flash('error', 'যথেষ্ট কয়েন নেই!');
        return res.redirect(`/tournaments/${tId}`);
      }
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'tournament_entry', 'Joined tournament')`,
        [userId, -entryFee]
      );
      if (req.session.user) req.session.user.coins = upd.rows[0].coins;
    }

    await client.query(
      `INSERT INTO tournament_participants (tournament_id, user_id, points, joined_at)
       VALUES ($1, $2, 0, NOW())`,
      [tId, userId]
    );

    await client.query('COMMIT');

    const name = tournament.name || 'টুর্নামেন্ট'; // title কলামটা বিদ্যমান নয়
    req.flash('success', `${name}-এ যোগ দিয়েছেন!`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Join tournament error:', err.message);
    req.flash('error', 'যোগ দিতে সমস্যা হয়েছে।');
  } finally {
    client.release();
  }
  res.redirect(`/tournaments/${req.params.id}`);
});

module.exports = router;
