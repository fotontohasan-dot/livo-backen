const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Cricket In-Play লিস্ট পেজ (স্ক্রিনশট ১)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, team_a, team_b, score_a, score_b, overs, status, match_date 
      FROM matches 
      WHERE sport = 'cricket' 
      ORDER BY match_date DESC 
      LIMIT 15
    `);
    
    res.render('matches', { 
      matches: result.rows,
      currentPage: 'cricket',
      title: 'Cricket In-Play'
    });
  } catch (err) {
    console.error('Matches Error:', err);
    res.render('matches', { 
      matches: [], 
      currentPage: 'cricket',
      title: 'Cricket In-Play'
    });
  }
});

// Single Match Detail Page (স্ক্রিনশট ২)
router.get('/:id', async (req, res) => {
  try {
    const matchResult = await pool.query(`
      SELECT * FROM matches WHERE id = $1
    `, [req.params.id]);

    if (matchResult.rows.length === 0) {
      return res.status(404).render('error', { 
        message: 'ম্যাচটি পাওয়া যায়নি।' 
      });
    }

    const match = matchResult.rows[0];

    res.render('match-detail', { 
      match: match,
      currentPage: 'match'
    });
  } catch (err) {
    console.error('Match Detail Error:', err);
    res.status(500).render('error', { 
      message: 'সার্ভার সমস্যা হয়েছে।' 
    });
  }
});

module.exports = router;
