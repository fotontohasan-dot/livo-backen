const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { isAdmin } = require('../middleware/auth');
const { sanitizeText } = require('../middleware/validate');

router.use(isAdmin);

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'game';
}

router.get('/games', async (req, res) => {
  try {
    const selectedCategory = req.query.category || 'all';
    const selectedProvider = req.query.provider || 'all';
    const selectedBadge = req.query.badge || 'all';
    const selectedStatus = req.query.status || 'all';
    const searchQ = (req.query.q || '').trim();

    const conditions = [];
    const params = [];

    if (selectedCategory === 'hot') {
      conditions.push(`badge = 'hot'`);
    } else if (selectedCategory && selectedCategory !== 'all') {
      params.push(selectedCategory);
      conditions.push(`category = $${params.length}`);
    }
    if (selectedProvider && selectedProvider !== 'all') {
      params.push(selectedProvider);
      conditions.push(`provider = $${params.length}`);
    }
    if (selectedBadge === 'hot') {
      conditions.push(`badge = 'hot'`);
    }
    if (selectedStatus === 'active') conditions.push('is_active = true');
    if (selectedStatus === 'inactive') conditions.push('is_active = false');
    if (searchQ) {
      params.push('%' + searchQ + '%');
      conditions.push(`name ILIKE $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const gamesRes = await pool.query(
      `SELECT * FROM games ${where} ORDER BY sort_order ASC, name ASC LIMIT 500`,
      params
    );

    const statsRes = await pool.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS active FROM games`
    );

    let providersInCategory = [];
    if (selectedCategory && selectedCategory !== 'all' && selectedCategory !== 'hot') {
      const pRes = await pool.query(
        `SELECT provider, COUNT(*)::int AS count FROM games WHERE category = $1 AND provider IS NOT NULL GROUP BY provider ORDER BY count DESC`,
        [selectedCategory]
      );
      providersInCategory = pRes.rows;
    } else {
      const pRes = await pool.query(
        `SELECT provider, COUNT(*)::int AS count FROM games WHERE provider IS NOT NULL GROUP BY provider ORDER BY count DESC`
      );
      providersInCategory = pRes.rows;
    }

    res.render('admin/games', {
      games: gamesRes.rows,
      totalGames: statsRes.rows[0].total,
      activeGames: statsRes.rows[0].active,
      selectedCategory,
      selectedProvider,
      selectedBadge,
      selectedStatus,
      searchQ,
      providersInCategory,
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (err) {
    console.error('admin games list error:', err.message);
    res.render('admin/games', {
      games: [],
      totalGames: 0,
      activeGames: 0,
      selectedCategory: 'all',
      selectedProvider: 'all',
      selectedBadge: 'all',
      selectedStatus: 'all',
      searchQ: '',
      providersInCategory: [],
      success: [],
      error: ['গেম লোড করতে সমস্যা হয়েছে']
    });
  }
});

router.post('/games/add', async (req, res) => {
  try {
    const name = sanitizeText(req.body.name || '', { maxLen: 100 });
    let slug = sanitizeText(req.body.slug || '', { maxLen: 80 }) || slugify(name);
    const emoji = (req.body.emoji || '🎮').slice(0, 8);
    const category = ['slots', 'live', 'sports', 'poker'].includes(req.body.category) ? req.body.category : 'slots';
    const provider = sanitizeText(req.body.provider || '', { maxLen: 50 }) || 'Unknown';
    const badge = ['hot', 'pop', 'new'].includes(req.body.badge) ? req.body.badge : null;
    if (!name) {
      req.flash('error', 'গেমের নাম আবশ্যক');
      return res.redirect('/admin/games');
    }
    await pool.query(
      `INSERT INTO games (name, slug, emoji, category, provider, badge, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,true,0)
       ON CONFLICT (slug) DO UPDATE SET name=$1, emoji=$3, category=$4, provider=$5, badge=$6`,
      [name, slug, emoji, category, provider, badge]
    );
    req.flash('success', 'গেম যোগ/আপডেট হয়েছে');
  } catch (err) {
    console.error('games add error:', err.message);
    req.flash('error', 'গেম যোগ করতে সমস্যা হয়েছে');
  }
  res.redirect('/admin/games');
});

router.post('/games/:id/edit', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const name = sanitizeText(req.body.name || '', { maxLen: 100 });
    let slug = sanitizeText(req.body.slug || '', { maxLen: 80 }) || slugify(name);
    const emoji = (req.body.emoji || '🎮').slice(0, 8);
    const category = ['slots', 'live', 'sports', 'poker'].includes(req.body.category) ? req.body.category : 'slots';
    const provider = sanitizeText(req.body.provider || '', { maxLen: 50 }) || 'Unknown';
    const badge = ['hot', 'pop', 'new'].includes(req.body.badge) ? req.body.badge : null;
    await pool.query(
      `UPDATE games SET name=$1, slug=$2, emoji=$3, category=$4, provider=$5, badge=$6 WHERE id=$7`,
      [name, slug, emoji, category, provider, badge, id]
    );
    req.flash('success', 'গেম আপডেট হয়েছে');
  } catch (err) {
    console.error('games edit error:', err.message);
    req.flash('error', 'আপডেট ব্যর্থ');
  }
  res.redirect('/admin/games');
});

router.post('/games/:id/toggle', async (req, res) => {
  try {
    await pool.query('UPDATE games SET is_active = NOT is_active WHERE id = $1', [req.params.id]);
  } catch (err) {
    console.error('games toggle error:', err.message);
  }
  res.redirect(req.get('Referer') || '/admin/games');
});

router.post('/games/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM games WHERE id = $1', [req.params.id]);
    req.flash('success', 'গেম মুছে ফেলা হয়েছে');
  } catch (err) {
    req.flash('error', 'ডিলিট ব্যর্থ');
  }
  res.redirect('/admin/games');
});

module.exports = router;
