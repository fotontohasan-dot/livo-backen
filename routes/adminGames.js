// routes/adminGames.js
// Games Management — List, Add, Edit, Toggle, Delete, Sort
// সব action admin_logs-এ audit হয়। isAdmin middleware দিয়ে সুরক্ষিত।

const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const { redirectBack } = require('../utils/redirectBack');
const { logAdminAction } = require('../services/fraudDetection');
const rbac = require('../services/rbac');

// ==================== Validation ====================
const VALID_CATEGORIES = ['slots', 'live', 'sports', 'poker', 'casino', 'fishing', 'table'];
const VALID_BADGES     = ['', 'hot', 'pop', 'new', 'live'];
const SLUG_RE          = /^[a-z0-9-]+$/;

function makeSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function validateGame(body) {
  const errors = [];
  const name     = (body.name     || '').trim();
  const slug     = (body.slug     || '').trim() || makeSlug(name);
  const category = (body.category || '').trim();
  const provider = (body.provider || '').trim();
  const emoji    = (body.emoji    || '🎮').trim();
  const badge    = (body.badge    || '').trim();

  if (!name)                          errors.push('গেমের নাম আবশ্যক');
  else if (name.length > 100)         errors.push('নাম ১০০ অক্ষরের বেশি হবে না');
  if (!slug || !SLUG_RE.test(slug))   errors.push('স্লাগ শুধু lowercase, সংখ্যা ও হাইফেন দিয়ে হবে');
  if (!VALID_CATEGORIES.includes(category)) errors.push('অবৈধ ক্যাটাগরি: ' + category);
  if (!provider)                      errors.push('প্রোভাইডার আবশ্যক');
  if (provider.length > 80)           errors.push('প্রোভাইডার নাম ৮০ অক্ষরের বেশি হবে না');
  if (!VALID_BADGES.includes(badge))  errors.push('অবৈধ ব্যাজ: ' + badge);

  return { errors, data: { name, slug, category, provider, emoji: emoji.slice(0,4)||'🎮', badge: badge||null } };
}

// ==================== GET /admin/games ====================
router.get('/', rbac.requirePermission('games_manage'), async (req, res) => {
  try {
    const {
      category = 'all', provider = 'all', badge = 'all',
      status = 'all', q = '', page = '1'
    } = req.query;

    const conditions = [];
    const params     = [];

    if (category && category !== 'all') {
      if (category === 'hot') { params.push('hot'); conditions.push(`badge = $${params.length}`); }
      else { params.push(category); conditions.push(`category = $${params.length}`); }
    }
    if (provider && provider !== 'all') {
      params.push(provider); conditions.push(`provider = $${params.length}`);
    }
    if (badge === 'hot') {
      params.push('hot'); conditions.push(`badge = $${params.length}`);
    }
    if (status === 'active')   conditions.push('is_active = true');
    if (status === 'inactive') conditions.push('is_active = false');
    if (q.trim()) {
      params.push('%' + q.trim() + '%');
      conditions.push(`(name ILIKE $${params.length} OR slug ILIKE $${params.length} OR provider ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const LIMIT  = 50;
    const offset = (Math.max(1, parseInt(page) || 1) - 1) * LIMIT;

    const countRes = await pool.query(`SELECT COUNT(*) FROM games ${where}`, params);
    const total    = parseInt(countRes.rows[0].count);

    const games = await pool.query(
      `SELECT * FROM games ${where} ORDER BY sort_order ASC, created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, LIMIT, offset]
    );

    const totalRes  = await pool.query('SELECT COUNT(*) FROM games');
    const activeRes = await pool.query('SELECT COUNT(*) FROM games WHERE is_active = true');

    const providersInCategory = await pool.query(`
      SELECT provider, COUNT(*) AS count FROM games
      ${category && category !== 'all' && category !== 'hot' ? `WHERE category = $1` : ''}
      GROUP BY provider ORDER BY count DESC
    `, category && category !== 'all' && category !== 'hot' ? [category] : []);

    res.render('admin/games', {
      games: games.rows,
      totalGames:   parseInt(totalRes.rows[0].count),
      activeGames:  parseInt(activeRes.rows[0].count),
      selectedCategory: category,
      selectedProvider: provider,
      selectedBadge:    badge,
      selectedStatus:   status,
      searchQ: q,
      providersInCategory: providersInCategory.rows,
      page:       Math.max(1, parseInt(page) || 1),
      totalPages: Math.max(1, Math.ceil(total / LIMIT)),
      total,
      success: req.flash('success'),
      error:   req.flash('error'),
      active: 'games'
    });
  } catch (err) {
    console.error('admin games list error:', err.message);
    req.flash('error', 'গেম লোড করতে সমস্যা হয়েছে: ' + err.message);
    res.redirect('/admin');
  }
});

// ==================== POST /admin/games/add ====================
router.post('/add', rbac.requirePermission('games_manage'), async (req, res) => {
  const { errors, data } = validateGame(req.body);

  if (errors.length) {
    req.flash('error', errors.join(' | '));
    return res.redirect('/admin/games');
  }

  try {
    // max sort_order + 1
    const sortRes = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM games');
    const nextSort = parseInt(sortRes.rows[0].next);

    const r = await pool.query(
      `INSERT INTO games (name, slug, emoji, category, provider, badge, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`,
      [data.name, data.slug, data.emoji, data.category, data.provider, data.badge, nextSort]
    );

    await logAdminAction(
      req.session.user.id, req.session.user.username,
      'GAME_ADDED',
      `নতুন গেম যোগ: "${data.name}" (slug: ${data.slug}, category: ${data.category}, id: ${r.rows[0].id})`,
      req.ip
    );

    req.flash('success', `"${data.name}" সফলভাবে যোগ করা হয়েছে।`);
  } catch (err) {
    if (err.code === '23505') {
      req.flash('error', `স্লাগ "${data.slug}" ইতোমধ্যে বিদ্যমান। অন্য স্লাগ ব্যবহার করুন।`);
    } else {
      console.error('game add error:', err.message);
      req.flash('error', 'গেম যোগ করতে সমস্যা: ' + err.message);
    }
  }
  res.redirect('/admin/games');
});

// ==================== POST /admin/games/:id/edit ====================
router.post('/:id/edit', rbac.requirePermission('games_manage'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) { req.flash('error', 'অবৈধ গেম ID'); return res.redirect('/admin/games'); }

  const { errors, data } = validateGame(req.body);

  if (errors.length) {
    req.flash('error', errors.join(' | '));
    return res.redirect('/admin/games');
  }

  try {
    const existing = await pool.query('SELECT * FROM games WHERE id = $1', [id]);
    if (!existing.rows.length) { req.flash('error', 'গেম পাওয়া যায়নি'); return res.redirect('/admin/games'); }

    await pool.query(
      `UPDATE games SET name=$1, slug=$2, emoji=$3, category=$4, provider=$5, badge=$6 WHERE id=$7`,
      [data.name, data.slug, data.emoji, data.category, data.provider, data.badge, id]
    );

    await logAdminAction(
      req.session.user.id, req.session.user.username,
      'GAME_EDITED',
      `গেম এডিট: id=${id} নাম="${data.name}" slug="${data.slug}" category="${data.category}" provider="${data.provider}" badge="${data.badge||'-'}"`,
      req.ip
    );

    req.flash('success', `"${data.name}" সফলভাবে আপডেট করা হয়েছে।`);
  } catch (err) {
    if (err.code === '23505') {
      req.flash('error', `স্লাগ "${data.slug}" ইতোমধ্যে বিদ্যমান।`);
    } else {
      console.error('game edit error:', err.message);
      req.flash('error', 'গেম আপডেট করতে সমস্যা: ' + err.message);
    }
  }
  res.redirect('/admin/games');
});

// ==================== POST /admin/games/:id/toggle ====================
router.post('/:id/toggle', rbac.requirePermission('games_manage'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) { req.flash('error', 'অবৈধ গেম ID'); return res.redirect('/admin/games'); }

  try {
    const r = await pool.query(
      `UPDATE games SET is_active = NOT is_active WHERE id = $1 RETURNING name, is_active`,
      [id]
    );
    if (!r.rows.length) { req.flash('error', 'গেম পাওয়া যায়নি'); return res.redirect('/admin/games'); }

    const { name, is_active } = r.rows[0];
    await logAdminAction(
      req.session.user.id, req.session.user.username,
      'GAME_STATUS_CHANGED',
      `গেম status পরিবর্তন: "${name}" (id=${id}) → ${is_active ? 'সক্রিয়' : 'নিষ্ক্রিয়'}`,
      req.ip
    );

    req.flash('success', `"${name}" ${is_active ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে।`);
  } catch (err) {
    console.error('game toggle error:', err.message);
    req.flash('error', 'স্ট্যাটাস পরিবর্তনে সমস্যা: ' + err.message);
  }
  redirectBack(req, res, '/admin/games');
});

// ==================== POST /admin/games/:id/delete ====================
router.post('/:id/delete', rbac.requirePermission('games_manage'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) { req.flash('error', 'অবৈধ গেম ID'); return res.redirect('/admin/games'); }

  try {
    const existing = await pool.query('SELECT name, slug FROM games WHERE id = $1', [id]);
    if (!existing.rows.length) { req.flash('error', 'গেম পাওয়া যায়নি'); return res.redirect('/admin/games'); }

    const { name, slug } = existing.rows[0];
    await pool.query('DELETE FROM games WHERE id = $1', [id]);

    await logAdminAction(
      req.session.user.id, req.session.user.username,
      'GAME_DELETED',
      `গেম মুছে ফেলা হয়েছে: "${name}" (slug=${slug}, id=${id})`,
      req.ip
    );

    req.flash('success', `"${name}" সফলভাবে মুছে ফেলা হয়েছে।`);
  } catch (err) {
    console.error('game delete error:', err.message);
    req.flash('error', 'গেম মুছতে সমস্যা: ' + err.message);
  }
  res.redirect('/admin/games');
});

// ==================== POST /admin/games/bulk-toggle ====================
router.post('/bulk-toggle', rbac.requirePermission('games_manage'), async (req, res) => {
  const { ids, action } = req.body;
  if (!ids || !action) { req.flash('error', 'অবৈধ রিকোয়েস্ট'); return res.redirect('/admin/games'); }

  const idList = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(n => n > 0);
  if (!idList.length) { req.flash('error', 'কোনো গেম নির্বাচিত হয়নি'); return res.redirect('/admin/games'); }

  const isActive = action === 'activate';
  try {
    await pool.query(`UPDATE games SET is_active = $1 WHERE id = ANY($2)`, [isActive, idList]);
    await logAdminAction(
      req.session.user.id, req.session.user.username,
      'GAME_BULK_TOGGLE',
      `${idList.length}টি গেম ${isActive ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে (ids: ${idList.join(',')})`,
      req.ip
    );
    req.flash('success', `${idList.length}টি গেম ${isActive ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে।`);
  } catch (err) {
    console.error('bulk toggle error:', err.message);
    req.flash('error', 'Bulk toggle-এ সমস্যা: ' + err.message);
  }
  res.redirect('/admin/games');
});

// ==================== POST /admin/games/sort ====================
// body: { order: [id1, id2, ...] } — drag-drop sort (JSON POST)
router.post('/sort', rbac.requirePermission('games_manage'), async (req, res) => {
  try {
    const order = req.body.order;
    if (!Array.isArray(order)) return res.status(400).json({ ok: false, error: 'Invalid order' });
    for (let i = 0; i < order.length; i++) {
      await pool.query('UPDATE games SET sort_order = $1 WHERE id = $2', [i, parseInt(order[i])]);
    }
    await logAdminAction(
      req.session.user.id, req.session.user.username,
      'GAME_SORT_CHANGED',
      `গেম সর্ট অর্ডার পরিবর্তন করা হয়েছে (${order.length}টি গেম)`,
      req.ip
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('game sort error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
