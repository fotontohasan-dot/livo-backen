// routes/adminTickets.js
// ---------------------------------------------------------------------------
// PHASE 4 — টিকেট ইভেন্ট ও অর্ডার ব্যবস্থাপনা (অ্যাডমিন)।
//
// প্রোভাইডার না থাকলেও পুরো মডিউলটা ব্যবহারযোগ্য: অ্যাডমিন হাতে ইভেন্ট ও
// ক্যাটাগরি তৈরি করতে পারেন। প্রোভাইডার sync (services/ticketProviders/)
// যোগ হলে সেটা একই টেবিলেই লিখবে।
//
// অ্যাডমিন রুটে কখনো requireFeature বসে না — ফিচার বন্ধ থাকলেও অ্যাডমিন
// যেন সেটা ম্যানেজ করতে পারেন (tests/unit/featureFlags.test.js এটা যাচাই করে)।
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const rbac = require('../services/rbac');
const tickets = require('../services/tickets');
const { logAdminAction } = require('../services/fraudDetection');
const { publicMessage } = require('../utils/safeError');

const PERM = 'games_manage'; // টিকেট মডিউল একই কন্টেন্ট-ব্যবস্থাপনার আওতায়

// ==================== GET /admin/tickets ====================
router.get('/', rbac.requirePermission(PERM), async (req, res) => {
  try {
    const events = await pool.query(
      `SELECT e.*,
              COALESCE(SUM(c.total_qty), 0)::int AS total_qty,
              COALESCE(SUM(c.sold_qty), 0)::int  AS sold_qty
         FROM ticket_events e
         LEFT JOIN ticket_categories c ON c.event_id = e.id
        GROUP BY e.id ORDER BY e.event_date DESC LIMIT 100`
    );
    const orders = await pool.query(
      `SELECT o.id, o.order_ref, o.qty, o.total, o.status, o.created_at,
              u.username, e.title
         FROM ticket_orders o
         JOIN users u ON u.id = o.user_id
         JOIN ticket_events e ON e.id = o.event_id
        ORDER BY o.created_at DESC LIMIT 100`
    );
    res.render('admin/tickets', {
      events: events.rows, orders: orders.rows,
      success: req.flash('success'), error: req.flash('error'), active: 'tickets'
    });
  } catch (err) {
    console.error('admin tickets error:', err && err.stack ? err.stack : err);
    res.render('admin/tickets', {
      loadError: true, events: [], orders: [],
      success: [], error: [], active: 'tickets'
    });
  }
});

// ==================== POST /admin/tickets/events ====================
router.post('/events', rbac.requirePermission(PERM), async (req, res) => {
  try {
    const { title, competition, home_team, away_team, venue, city, country, event_date, banner_url } = req.body;
    if (!String(title || '').trim()) throw new Error('title required');
    if (!event_date) throw new Error('event_date required');

    const r = await pool.query(
      `INSERT INTO ticket_events
         (title, competition, home_team, away_team, venue, city, country, event_date, banner_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, title`,
      [String(title).trim().slice(0, 200), competition || null, home_team || null, away_team || null,
       venue || null, city || null, country || null, event_date, banner_url || null]
    );
    await logAdminAction(req.session.user.id, req.session.user.username,
      'TICKET_EVENT_CREATED', `${r.rows[0].title} (#${r.rows[0].id})`, req.ip);
    req.flash('success', 'ইভেন্ট তৈরি হয়েছে');
  } catch (err) {
    console.error('ticket event create error:', err.message);
    req.flash('error', publicMessage(err, 'ইভেন্ট তৈরি করা যায়নি'));
  }
  res.redirect('/admin/tickets');
});

// ==================== POST /admin/tickets/events/:id/categories ====================
router.post('/events/:id/categories', rbac.requirePermission(PERM), async (req, res) => {
  try {
    const { name, price, total_qty, max_per_user } = req.body;
    const qty = parseInt(total_qty, 10);
    const p = Number(price);
    if (!String(name || '').trim()) throw new Error('name required');
    if (!Number.isFinite(qty) || qty < 1) throw new Error('invalid quantity');
    if (!Number.isFinite(p) || p < 0) throw new Error('invalid price');

    await pool.query(
      `INSERT INTO ticket_categories (event_id, name, price, total_qty, max_per_user)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, String(name).trim().slice(0, 100), p, qty, parseInt(max_per_user, 10) || 4]
    );
    req.flash('success', 'ক্যাটাগরি যোগ হয়েছে');
  } catch (err) {
    console.error('ticket category create error:', err.message);
    req.flash('error', publicMessage(err, 'ক্যাটাগরি যোগ করা যায়নি'));
  }
  res.redirect('/admin/tickets');
});

// ==================== POST /admin/tickets/events/:id/status ====================
router.post('/events/:id/status', rbac.requirePermission(PERM), async (req, res) => {
  try {
    const status = ['on_sale', 'paused', 'closed'].includes(req.body.status) ? req.body.status : 'paused';
    await pool.query('UPDATE ticket_events SET status = $1 WHERE id = $2', [status, req.params.id]);
    await logAdminAction(req.session.user.id, req.session.user.username,
      'TICKET_EVENT_STATUS', `ইভেন্ট #${req.params.id} → ${status}`, req.ip);
    req.flash('success', 'স্ট্যাটাস বদলানো হয়েছে');
  } catch (err) {
    req.flash('error', publicMessage(err, 'স্ট্যাটাস বদলানো যায়নি'));
  }
  res.redirect('/admin/tickets');
});

// ==================== POST /admin/tickets/orders/:id/refund ====================
// রিফান্ডে টিকেট void হয়, sold_qty কমে (ইনভেন্টরি ফিরে আসে) এবং টাকা
// ইউজারের ব্যালেন্সে ক্রেডিট হয় — তিনটাই একই ট্রানজেকশনে
// (services/tickets.js-এর refundOrder)।
router.post('/orders/:id/refund', rbac.requirePermission(PERM), async (req, res) => {
  try {
    const order = await tickets.refundOrder(req.params.id, { refundToBalance: true });
    await logAdminAction(req.session.user.id, req.session.user.username,
      'TICKET_ORDER_REFUNDED', `${order.order_ref} — ৳${order.total}`, req.ip);
    req.flash('success', `${order.order_ref} রিফান্ড হয়েছে`);
  } catch (err) {
    console.error('ticket refund error:', err.message);
    req.flash('error', publicMessage(err, 'রিফান্ড করা যায়নি'));
  }
  res.redirect('/admin/tickets');
});

module.exports = router;
