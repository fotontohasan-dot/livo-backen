const express = require('express');
const { requireIntParam } = require('../middleware/validate');
const router = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const { sport } = req.query;
    let query = `SELECT n.*, u.username as author FROM news n LEFT JOIN users u ON n.author_id=u.id`;
    const params = [];
    if (sport) { params.push(sport); query += ` WHERE n.sport=$1`; }
    // পাবলিক ও unauthenticated রুট, আগে কোনো LIMIT ছাড়াই পুরো news টেবিল পড়ত (P2-16)।
    params.push(100);
    query += ` ORDER BY n.created_at DESC LIMIT $${params.length}`;
    const news = await pool.query(query, params);
    res.render('news', { news: news.rows, sport });
  } catch (err) {
    res.render('news', { news: [], sport: null });
  }
});

// ত্রুটিপূর্ণ id (abc, 1e309, ইত্যাদি) আগে সরাসরি PostgreSQL-এ পৌঁছে 22P02/22003 এরর
// ঘটাত, তারপর catch ব্লক ধরে রিডাইরেক্ট করত। ইউজার নিরাপদ উত্তরই পেত, কিন্তু প্রতিটা
// এমন রিকোয়েস্টে অপ্রয়োজনীয় DB রাউন্ড-ট্রিপ হতো। এখন রুটে ঢোকার আগেই যাচাই হয়;
// গন্তব্য আগের catch ব্লকের মতোই।
router.get('/:id', requireIntParam('id', '/news'), async (req, res) => {
  try {
    await pool.query(`UPDATE news SET views=views+1 WHERE id=$1`, [req.params.id]);
    const article = await pool.query(`SELECT n.*, u.username as author FROM news n LEFT JOIN users u ON n.author_id=u.id WHERE n.id=$1`, [req.params.id]);
    if (!article.rows[0]) return res.redirect('/news');
    const related = await pool.query(`SELECT * FROM news WHERE sport=$1 AND id!=$2 ORDER BY created_at DESC LIMIT 3`, [article.rows[0].sport, req.params.id]);
    res.render('news-detail', { article: article.rows[0], related: related.rows });
  } catch (err) {
    res.redirect('/news');
  }
});

module.exports = router;
