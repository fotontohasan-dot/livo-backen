const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Cricket In-Play লিস্ট পেজ
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM matches 
      WHERE sport = 'cricket' 
      ORDER BY match_date DESC 
      LIMIT 20
    `);
    
    res.render('matches', { 
      matches: result.rows,
      currentPage: 'matches'
    });
  } catch (err) {
    console.error(err);
    res.render('matches', { matches: [], currentPage: 'matches' });
  }
});

// Single Match Detail
router.get('/:id', async (req, res) => {
  try {
    const matchResult = await pool.query('SELECT * FROM matches WHERE id = $1', [req.params.id]);
    
    if (matchResult.rows.length === 0) {
      return res.status(404).render('error', { message: 'ম্যাচ পাওয়া যায়নি' });
    }

    const match = matchResult.rows[0];
    
    res.render('match-detail', { 
      match: match,
      currentPage: 'match'
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'সার্ভার এরর' });
  }
});

module.exports = router;
