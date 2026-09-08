// services/tickets.js
// ---------------------------------------------------------------------------
// ইভেন্ট টিকেট — ইনভেন্টরি, রিজার্ভেশন, পেমেন্ট, ইস্যু, যাচাই ও রিফান্ড।
//
// রুট লেয়ার ইচ্ছাকৃতভাবে পাতলা রাখা হয়েছে; ইনভেন্টরির সব নিয়ম এখানে —
// কারণ একই নিয়ম দুই জায়গায় (ইউজার চেকআউট ও অ্যাডমিন প্যানেল) লিখলে
// একদিন একটা জায়গা আপডেট হবে, অন্যটা নয়।
//
// কেন্দ্রীয় অপরিবর্তনীয় নিয়ম: **sold_qty কখনো total_qty ছাড়াবে না।**
// এটা তিন স্তরে রক্ষিত:
//   ১. `SELECT ... FOR UPDATE` — ক্যাটাগরির সারি lock করে পড়া ও লেখা একই
//      ট্রানজেকশনে। দুই ব্রাউজার থেকে একই শেষ টিকেট কিনতে চাইলে একজন সফল,
//      অন্যজন "sold out" — কারণ দ্বিতীয়জন প্রথমজনের commit-এর *পরে* পড়ে।
//   ২. CHECK constraint (migrations.js) — শেষ প্রতিরক্ষা, যদি ভবিষ্যতের কোনো
//      নতুন কোড-পথ lock নিতে ভুলে যায়।
//   ৩. Expiry worker — অপরিশোধিত reservation ছেড়ে দেয়, নাহলে ইনভেন্টরি
//      চিরতরে আটকে থাকত।
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { pool } = require('../db');
const queue = require('./queue');

const DEFAULT_RESERVATION_MINUTES = 15;

class TicketError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message || code);
    this.name = 'TicketError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const CODES = {
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  SOLD_OUT: 'SOLD_OUT',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  INVALID_QTY: 'INVALID_QTY',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_NOT_RESERVED: 'ORDER_NOT_RESERVED',
  RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
  TICKET_ALREADY_USED: 'TICKET_ALREADY_USED',
  TICKET_VOID: 'TICKET_VOID'
};

function reservationMinutes() {
  const n = parseInt(process.env.TICKET_RESERVATION_MINUTES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESERVATION_MINUTES;
}

/** পড়তে সহজ, অনুমান করা কঠিন — মানুষের চোখে বিভ্রান্তিকর অক্ষর বাদ। */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(prefix, len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${prefix}-${out}`;
}

// ==================== পাবলিক রিড ====================

async function listEvents({ limit = 50 } = {}) {
  const r = await pool.query(
    `SELECT e.*,
            COALESCE(MIN(c.price), 0) AS min_price,
            COALESCE(SUM(c.total_qty - c.sold_qty), 0) AS available
       FROM ticket_events e
       LEFT JOIN ticket_categories c ON c.event_id = e.id
      WHERE e.status = 'on_sale' AND e.event_date > NOW()
      GROUP BY e.id
      ORDER BY e.event_date ASC
      LIMIT $1`,
    [Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)]
  );
  return r.rows;
}

async function getEvent(eventId) {
  const e = await pool.query('SELECT * FROM ticket_events WHERE id = $1', [eventId]);
  if (!e.rows.length) throw new TicketError(CODES.EVENT_NOT_FOUND, 'event not found', 404);
  const c = await pool.query(
    `SELECT id, name, price, currency, total_qty, sold_qty, max_per_user,
            (total_qty - sold_qty) AS available
       FROM ticket_categories WHERE event_id = $1 ORDER BY price ASC`,
    [eventId]
  );
  return { event: e.rows[0], categories: c.rows };
}

async function myOrders(userId) {
  const r = await pool.query(
    `SELECT o.*, e.title, e.event_date, e.venue, c.name AS category_name,
            COALESCE(json_agg(json_build_object(
              'code', it.ticket_code, 'qr', it.qr_url,
              'seat', it.seat_label, 'status', it.status
            )) FILTER (WHERE it.id IS NOT NULL), '[]') AS tickets
       FROM ticket_orders o
       JOIN ticket_events e ON e.id = o.event_id
       JOIN ticket_categories c ON c.id = o.category_id
       LEFT JOIN issued_tickets it ON it.order_id = o.id
      WHERE o.user_id = $1
      GROUP BY o.id, e.title, e.event_date, e.venue, c.name
      ORDER BY o.created_at DESC`,
    [userId]
  );
  return r.rows;
}

// ==================== রিজার্ভেশন ====================
//
// এখানে টাকা নেওয়া হয় না — শুধু ইনভেন্টরি ধরে রাখা হয়। টাকার ধাপ আলাদা
// (payWithBalance বা payment_requests), কারণ পেমেন্ট ব্যর্থ হলে ইনভেন্টরি
// ছেড়ে দেওয়ার একটা পরিষ্কার অবস্থা দরকার।
async function reserve({ userId, categoryId, qty }) {
  const n = parseInt(qty, 10);
  if (!Number.isFinite(n) || n < 1 || n > 50) {
    throw new TicketError(CODES.INVALID_QTY, 'invalid quantity');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE — এই lock-ই ওভারসেলিং ঠেকানোর আসল ব্যবস্থা।
    const cat = await client.query(
      `SELECT c.*, e.id AS event_id, e.status AS event_status, e.event_date
         FROM ticket_categories c
         JOIN ticket_events e ON e.id = c.event_id
        WHERE c.id = $1
          FOR UPDATE OF c`,
      [categoryId]
    );
    if (!cat.rows.length) {
      await client.query('ROLLBACK');
      throw new TicketError(CODES.CATEGORY_NOT_FOUND, 'category not found', 404);
    }
    const c = cat.rows[0];

    if (c.event_status !== 'on_sale' || new Date(c.event_date) <= new Date()) {
      await client.query('ROLLBACK');
      throw new TicketError(CODES.EVENT_NOT_FOUND, 'event not on sale');
    }

    const available = Number(c.total_qty) - Number(c.sold_qty);
    if (available < n) {
      await client.query('ROLLBACK');
      throw new TicketError(CODES.SOLD_OUT, 'not enough tickets');
    }

    // per-user সীমা — বাতিল/রিফান্ড হওয়া অর্ডার গোনা হয় না, নাহলে একবার
    // বাতিল করলেই ইউজার চিরতরে কোটা হারাত।
    const mine = await client.query(
      `SELECT COALESCE(SUM(qty), 0)::int AS q FROM ticket_orders
        WHERE user_id = $1 AND category_id = $2 AND status IN ('reserved','paid')`,
      [userId, categoryId]
    );
    if (Number(mine.rows[0].q) + n > Number(c.max_per_user)) {
      await client.query('ROLLBACK');
      throw new TicketError(CODES.LIMIT_EXCEEDED, 'per-user limit exceeded');
    }

    await client.query(
      'UPDATE ticket_categories SET sold_qty = sold_qty + $1 WHERE id = $2',
      [n, categoryId]
    );

    const unitPrice = Number(c.price);
    const orderRef = randomCode('ORD', 10);
    const order = await client.query(
      `INSERT INTO ticket_orders
         (order_ref, user_id, event_id, category_id, qty, unit_price, total, status, reserved_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved', NOW() + ($8 || ' minutes')::interval)
       RETURNING *`,
      [orderRef, userId, c.event_id, categoryId, n, unitPrice, unitPrice * n, String(reservationMinutes())]
    );

    await client.query('COMMIT');
    return order.rows[0];
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ইতিমধ্যে rollback */ }
    throw err;
  } finally {
    client.release();
  }
}

// ==================== পেমেন্ট: ব্যালেন্স থেকে ====================
//
// ব্যালেন্স ডেবিট ও অর্ডারের status বদল একই ট্রানজেকশনে — নাহলে টাকা কেটে
// অর্ডার reserved থেকে গেলে expiry worker সেটা বাতিল করে দিত এবং ইউজার
// টাকাও হারাত, টিকেটও পেত না।
async function payWithBalance(userId, orderRef) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const o = await client.query(
      `SELECT * FROM ticket_orders WHERE order_ref = $1 AND user_id = $2 FOR UPDATE`,
      [orderRef, userId]
    );
    if (!o.rows.length) {
      await client.query('ROLLBACK');
      throw new TicketError(CODES.ORDER_NOT_FOUND, 'order not found', 404);
    }
    const order = o.rows[0];

    if (order.status === 'paid') {
      // ডাবল-সাবমিট — টাকা দ্বিতীয়বার কাটা হবে না, আগের ফলই ফেরত।
      await client.query('ROLLBACK');
      return order;
    }
    if (order.status !== 'reserved') {
      await client.query('ROLLBACK');
      throw new TicketError(CODES.ORDER_NOT_RESERVED, 'order not payable');
    }
    if (order.reserved_until && new Date(order.reserved_until) <= new Date()) {
      await client.query('ROLLBACK');
      throw new TicketError(CODES.RESERVATION_EXPIRED, 'reservation expired');
    }

    const u = await client.query('SELECT coins FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const balance = Number(u.rows[0].coins);
    const total = Number(order.total);
    if (balance < total) {
      await client.query('ROLLBACK');
      throw new TicketError(CODES.INSUFFICIENT_FUNDS, 'insufficient balance');
    }

    await client.query('UPDATE users SET coins = coins - $1 WHERE id = $2', [total, userId]);
    // লেজার এন্ট্রি ব্যালেন্স-পরিবর্তনের সমান ও ঋণাত্মক — কোডবেসের মূল
    // ইনভেরিয়েন্ট (balance == starting + SUM(coin_transactions)) অটুট থাকে।
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,$3,$4)`,
      [userId, -total, 'ticket_purchase', `টিকেট অর্ডার ${order.order_ref}`]
    );
    const updated = await client.query(
      `UPDATE ticket_orders SET status = 'paid', reserved_until = NULL WHERE id = $1 RETURNING *`,
      [order.id]
    );

    await client.query('COMMIT');

    // টিকেট ইস্যু ও ডেলিভারি ব্যাকগ্রাউন্ডে — QR জেনারেশন ও Cloudinary
    // আপলোড ধীর, চেকআউট রেসপন্স তার জন্য অপেক্ষা করবে না।
    queue.enqueue('ticket_issue', { orderId: order.id });
    return updated.rows[0];
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ইতিমধ্যে rollback */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * এক্সটার্নাল পেমেন্ট (payment_requests) অনুমোদিত হলে এই পথে অর্ডার paid হয়।
 * routes/payment.js-এর অনুমোদন-হ্যান্ডলার থেকে কল করার জন্য — নতুন কোনো
 * গেটওয়ে এখানে লেখা হয়নি, বিদ্যমান ম্যানুয়াল অনুমোদন প্রবাহই পুনর্ব্যবহৃত।
 */
async function markPaidByPaymentRequest(paymentRequestId) {
  const r = await pool.query(
    `UPDATE ticket_orders SET status = 'paid', reserved_until = NULL
      WHERE payment_request_id = $1 AND status = 'reserved'
      RETURNING id`,
    [paymentRequestId]
  );
  for (const row of r.rows) {
    queue.enqueue('ticket_issue', { orderId: row.id });
  }
  return r.rowCount;
}

// ==================== ইস্যু ====================

async function issueTickets(orderId) {
  const o = await pool.query('SELECT * FROM ticket_orders WHERE id = $1', [orderId]);
  if (!o.rows.length) throw new TicketError(CODES.ORDER_NOT_FOUND, 'order not found', 404);
  const order = o.rows[0];
  if (order.status !== 'paid') throw new TicketError(CODES.ORDER_NOT_RESERVED, 'order not paid');

  // ইতিমধ্যে ইস্যু হয়ে থাকলে আবার নয় — জব রিট্রাই হলে ডুপ্লিকেট টিকেট
  // তৈরি হওয়া মানেই ইনভেন্টরির চেয়ে বেশি টিকেট ছাড়া হয়ে যাওয়া।
  const existing = await pool.query('SELECT COUNT(*)::int AS c FROM issued_tickets WHERE order_id = $1', [orderId]);
  if (existing.rows[0].c >= order.qty) {
    return await pool.query('SELECT * FROM issued_tickets WHERE order_id = $1', [orderId]).then(r => r.rows);
  }

  const created = [];
  for (let i = existing.rows[0].c; i < order.qty; i++) {
    const code = randomCode('TKT', 12);
    const qrUrl = await makeQrUrl(code);
    const r = await pool.query(
      `INSERT INTO issued_tickets (order_id, ticket_code, qr_url, seat_label)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (ticket_code) DO NOTHING
       RETURNING *`,
      [orderId, code, qrUrl, `${i + 1}/${order.qty}`]
    );
    if (r.rows.length) created.push(r.rows[0]);
  }
  return created;
}

/**
 * QR তৈরি করে Cloudinary-তে তুলে CDN URL দেয়।
 * Cloudinary কনফিগার করা না থাকলে data-URL ফেরত যায় — টিকেট তখনো কাজ করে,
 * শুধু ছবিটা DB-তে ইনলাইন থাকে। ছবির জন্য পুরো ইস্যু আটকে থাকা অযৌক্তিক।
 */
async function makeQrUrl(code) {
  const QRCode = require('qrcode');
  const verifyUrl = `${process.env.PUBLIC_APP_URL || ''}/tickets/verify/${code}`;
  const dataUrl = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 400 });

  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY) return dataUrl;
  try {
    const cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });
    const up = await cloudinary.uploader.upload(dataUrl, {
      folder: 'livo/tickets', public_id: code, overwrite: false
    });
    return up.secure_url || dataUrl;
  } catch (e) {
    console.error('[tickets] QR আপলোড ব্যর্থ:', e.message);
    return dataUrl;
  }
}

// ==================== মেয়াদোত্তীর্ণ রিজার্ভেশন ====================
//
// অপরিশোধিত reservation ছেড়ে না দিলে ইনভেন্টরি চিরতরে আটকে থাকত এবং
// ইভেন্ট "sold out" দেখাত অথচ একটাও টিকেট বিক্রি হয়নি।
async function expireReservations() {
  const client = await pool.connect();
  let released = 0;
  try {
    await client.query('BEGIN');
    const expired = await client.query(
      `SELECT id, category_id, qty FROM ticket_orders
        WHERE status = 'reserved' AND reserved_until IS NOT NULL AND reserved_until < NOW()
        FOR UPDATE SKIP LOCKED`
    );
    for (const o of expired.rows) {
      await client.query(
        `UPDATE ticket_categories SET sold_qty = GREATEST(sold_qty - $1, 0) WHERE id = $2`,
        [o.qty, o.category_id]
      );
      await client.query(`UPDATE ticket_orders SET status = 'cancelled' WHERE id = $1`, [o.id]);
      released += o.qty;
    }
    await client.query('COMMIT');
    return { orders: expired.rows.length, released };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ইতিমধ্যে rollback */ }
    throw err;
  } finally {
    client.release();
  }
}

// ==================== গেটে যাচাই ====================

async function verifyTicket(code, { markUsed = true } = {}) {
  const r = await pool.query(
    `SELECT it.*, o.order_ref, o.user_id, e.title, e.event_date, e.venue, c.name AS category_name
       FROM issued_tickets it
       JOIN ticket_orders o ON o.id = it.order_id
       JOIN ticket_events e ON e.id = o.event_id
       JOIN ticket_categories c ON c.id = o.category_id
      WHERE it.ticket_code = $1`,
    [code]
  );
  if (!r.rows.length) throw new TicketError(CODES.TICKET_NOT_FOUND, 'ticket not found', 404);
  const t = r.rows[0];

  if (t.status === 'void') throw new TicketError(CODES.TICKET_VOID, 'ticket voided');
  if (t.status === 'used') throw new TicketError(CODES.TICKET_ALREADY_USED, 'ticket already used');

  if (markUsed) {
    // atomic claim — দুটো স্ক্যানার একসাথে একই কোড স্ক্যান করলে ঠিক একটাই
    // সফল হয়। `WHERE status = 'valid'` না থাকলে দুটোই "valid" দেখাত।
    const claim = await pool.query(
      `UPDATE issued_tickets SET status = 'used', used_at = NOW()
        WHERE ticket_code = $1 AND status = 'valid' RETURNING id`,
      [code]
    );
    if (claim.rowCount === 0) throw new TicketError(CODES.TICKET_ALREADY_USED, 'ticket already used');
  }
  return t;
}

// ==================== রিফান্ড (অ্যাডমিন) ====================

async function refundOrder(orderId, { refundToBalance = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const o = await client.query('SELECT * FROM ticket_orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!o.rows.length) {
      await client.query('ROLLBACK');
      throw new TicketError(CODES.ORDER_NOT_FOUND, 'order not found', 404);
    }
    const order = o.rows[0];
    if (order.status !== 'paid') {
      await client.query('ROLLBACK');
      throw new TicketError(CODES.ORDER_NOT_RESERVED, 'only paid orders can be refunded');
    }

    await client.query(`UPDATE issued_tickets SET status = 'void' WHERE order_id = $1`, [orderId]);
    await client.query(
      `UPDATE ticket_categories SET sold_qty = GREATEST(sold_qty - $1, 0) WHERE id = $2`,
      [order.qty, order.category_id]
    );
    await client.query(`UPDATE ticket_orders SET status = 'refunded' WHERE id = $1`, [orderId]);

    if (refundToBalance) {
      await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [order.total, order.user_id]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1,$2,$3,$4)`,
        [order.user_id, order.total, 'ticket_refund', `টিকেট রিফান্ড ${order.order_ref}`]
      );
    }

    await client.query('COMMIT');
    return order;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ইতিমধ্যে rollback */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  listEvents, getEvent, myOrders,
  reserve, payWithBalance, markPaidByPaymentRequest,
  issueTickets, expireReservations, verifyTicket, refundOrder,
  reservationMinutes, TicketError, CODES
};
