const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  const { sport } = req.query;
  let query = `SELECT n.*, u.username as author FROM news n LEFT JOIN users u ON n.author_id=u.id`;
  const params = [];
  if (sport) { params.push(sport); query += ` WHERE n.sport=$1`; }
  query += ` ORDER BY n.created_at DESC`;
  const news = await pool.query(query, params);
  res.render('news', { news: news.rows, sport });
});

router.get('/:id', async (req, res) => {
  await pool.query(`UPDATE news SET views=views+1 WHERE id=$1`, [req.params.id]);
  const article = await pool.query(`SELECT n.*, u.username as author FROM news n LEFT JOIN users u ON n.author_id=u.id WHERE n.id=$1`, [req.params.id]);
  if (!article.rows[0]) return res.redirect('/news');
  const related = await pool.query(`SELECT * FROM news WHERE sport=$1 AND id!=$2 ORDER BY created_at DESC LIMIT 3`, [article.rows[0].sport, req.params.id]);
  res.render('news-detail', { article: article.rows[0], related: related.rows });
});

module.exports = router;
