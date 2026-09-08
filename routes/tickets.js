// routes/tickets.js
// ---------------------------------------------------------------------------
// PHASE 4 — ইভেন্ট টিকেট (ইউজার-মুখী)।
//
// রুট লেয়ার পাতলা: ইনভেন্টরি, পেমেন্ট ও ইস্যুর সব নিয়ম services/tickets.js-এ।
// এখানে শুধু auth, ইনপুট যাচাই ও রেন্ডারিং।
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { requireFeature } = require('../middleware/featureGate');

// রাউটার-লেভেল ফিচার গেট — নতুন সাব-রুট যোগ হলেও আপনাআপনি সুরক্ষিত।
router.use(requireFeature('tickets'));

const { isAuth } = require('../middleware/auth');
const tickets = require('../services/tickets');

function fail(req, res, err, redirectTo) {
  const code = err instanceof tickets.TicketError ? err.code : 'SERVER_ERROR';
  if (!(err instanceof tickets.TicketError)) {
    console.error('tickets route error:', err.message);
  }
  // বার্তাগুলো ইউজারের ভাষায়; কোনো DB/অভ্যন্তরীণ বিবরণ যায় না।
  const messages = {
    SOLD_OUT: req.t('tickets_sold_out'),
    LIMIT_EXCEEDED: req.t('tickets_limit_exceeded'),
    RESERVATION_EXPIRED: req.t('tickets_reservation_expired'),
    INSUFFICIENT_FUNDS: req.t('balance_insufficient')
  };
  const msg = messages[code] || req.t('common_server_error_short');
  if (redirectTo) {
    req.flash('error', msg);
    return res.redirect(redirectTo);
  }
  const status = err instanceof tickets.TicketError ? err.httpStatus : 500;
  return res.status(status).json({ success: false, error: code, message: msg });
}

// ==================== ইভেন্ট তালিকা ====================
router.get('/', async (req, res) => {
  try {
    res.render('tickets/index', {
      user: req.session.user || null,
      events: await tickets.listEvents()
    });
  } catch (err) {
    return fail(req, res, err, '/');
  }
});

// ==================== একটি ইভেন্ট + ক্যাটাগরি ====================
router.get('/event/:id', async (req, res) => {
  try {
    const { event, categories } = await tickets.getEvent(req.params.id);
    res.render('tickets/event', {
      user: req.session.user || null,
      event, categories,
      reservationMinutes: tickets.reservationMinutes()
    });
  } catch (err) {
    return fail(req, res, err, '/tickets');
  }
});

// ==================== রিজার্ভ ====================
// টাকা এখানে কাটা হয় না — শুধু ইনভেন্টরি ধরে রাখা হয়, ১৫ মিনিটের জন্য
// (TICKET_RESERVATION_MINUTES)। এরপর checkout পেজে পেমেন্ট।
router.post('/reserve', isAuth, async (req, res) => {
  try {
    const order = await tickets.reserve({
      userId: req.session.user.id,
      categoryId: req.body.category_id,
      qty: req.body.qty
    });
    res.json({ success: true, orderRef: order.order_ref, redirect: `/tickets/checkout/${order.order_ref}` });
  } catch (err) {
    return fail(req, res, err);
  }
});

// ==================== চেকআউট ====================
router.get('/checkout/:ref', isAuth, async (req, res) => {
  try {
    const orders = await tickets.myOrders(req.session.user.id);
    const order = orders.find(o => o.order_ref === req.params.ref);
    if (!order) {
      req.flash('error', req.t('common_not_found'));
      return res.redirect('/tickets');
    }
    res.render('tickets/checkout', {
      user: req.session.user,
      order,
      balance: Number(req.session.user.coins || 0)
    });
  } catch (err) {
    return fail(req, res, err, '/tickets');
  }
});

router.post('/checkout/:ref/pay', isAuth, async (req, res) => {
  try {
    const order = await tickets.payWithBalance(req.session.user.id, req.params.ref);
    // সেশনের ব্যালেন্স মিরর DB থেকে রিফ্রেশ — অন্য সব financial route-এর মতোই
    const { pool } = require('../db');
    const u = await pool.query('SELECT coins FROM users WHERE id = $1', [req.session.user.id]);
    req.session.user.coins = Number(u.rows[0].coins);
    res.json({ success: true, orderRef: order.order_ref, redirect: '/tickets/my-tickets' });
  } catch (err) {
    return fail(req, res, err);
  }
});

// ==================== আমার টিকেট ====================
router.get('/my-tickets', isAuth, async (req, res) => {
  try {
    res.render('tickets/my-tickets', {
      user: req.session.user,
      orders: await tickets.myOrders(req.session.user.id)
    });
  } catch (err) {
    return fail(req, res, err, '/tickets');
  }
});

// ==================== গেটে যাচাই ====================
// QR স্ক্যান করলে এখানে আসে। ইচ্ছাকৃতভাবে GET এবং লগইন ছাড়াই — গেটের
// স্ক্যানার ডিভাইসে আমাদের সেশন থাকে না। কোডটাই একমাত্র প্রমাণ, এবং সেটা
// ১২ অক্ষরের র‍্যান্ডম (৩২^১২ সম্ভাবনা), তাই অনুমান করা অবাস্তব।
//
// একবার স্ক্যান হলেই status = used — দ্বিতীয় স্ক্যানে সাফ প্রত্যাখ্যান।
router.get('/verify/:code', async (req, res) => {
  try {
    const t = await tickets.verifyTicket(req.params.code, { markUsed: true });
    res.json({
      success: true, valid: true,
      event: t.title, date: t.event_date, venue: t.venue,
      category: t.category_name, seat: t.seat_label, order: t.order_ref
    });
  } catch (err) {
    const code = err instanceof tickets.TicketError ? err.code : 'SERVER_ERROR';
    const status = err instanceof tickets.TicketError ? err.httpStatus : 500;
    res.status(status).json({ success: false, valid: false, error: code });
  }
});

module.exports = router;
