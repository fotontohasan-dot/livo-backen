// tests/integration/ticketInventoryIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 4 — টিকেট ইনভেন্টরির অপরিবর্তনীয় নিয়মগুলো।
//
// টিকেট বিক্রিতে একটাই বাগ সত্যিকারের ক্ষতি করে: **ওভারসেলিং**। ইভেন্টের
// দিন গেটে গিয়ে ইউজার জানতে পারে তার টিকেট বৈধ নয় — টাকা ফেরত দিলেও
// সেই ক্ষতি পোষায় না। তাই এখানে সবচেয়ে বেশি মনোযোগ ঠিক সেদিকেই।
//
// যা লক করা হচ্ছে:
//   ১. একই শেষ টিকেটে সমান্তরাল ২০টা রিকোয়েস্ট — ঠিক একজন সফল
//   ২. sold_qty কখনো total_qty ছাড়ায় না
//   ৩. ১৫ মিনিট পর অপরিশোধিত reservation নিজে থেকে ছেড়ে যায়
//   ৪. per-user সীমা প্রয়োগ হয়, কিন্তু বাতিল অর্ডার কোটা খায় না
//   ৫. পেমেন্টে ব্যালেন্স ও লেজার সঙ্গতিপূর্ণ থাকে; ডাবল-পে টাকা কাটে না
//   ৬. একই টিকেট দুবার স্ক্যান করা যায় না
//   ৭. রিফান্ডে টিকেট void হয় ও ইনভেন্টরি ফিরে আসে
//
// আসল PostgreSQL-এর বিরুদ্ধে চলে — যে race condition ঠেকানোর কথা, সেটা
// কেবল সত্যিকারের সমান্তরাল ট্রানজেকশনেই প্রকাশ পায়।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const tickets = require('../../services/tickets');

async function makeUser(coins = 100000) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ('tk_'||floor(random()*1e9), '019'||floor(random()*1e8), 'x', $1)
     RETURNING id`, [coins]
  );
  return r.rows[0].id;
}

async function makeEvent({ qty = 10, price = 500, maxPerUser = 4 } = {}) {
  const e = await pool.query(
    `INSERT INTO ticket_events (title, venue, event_date, status)
     VALUES ('Test Match '||floor(random()*1e9), 'Test Stadium', NOW() + INTERVAL '30 days', 'on_sale')
     RETURNING id`
  );
  const c = await pool.query(
    `INSERT INTO ticket_categories (event_id, name, price, total_qty, max_per_user)
     VALUES ($1, 'General', $2, $3, $4) RETURNING id`,
    [e.rows[0].id, price, qty, maxPerUser]
  );
  return { eventId: e.rows[0].id, categoryId: c.rows[0].id };
}

async function categoryState(categoryId) {
  const r = await pool.query('SELECT total_qty, sold_qty FROM ticket_categories WHERE id = $1', [categoryId]);
  return r.rows[0];
}

describe('ticket inventory integrity', () => {
  test('শেষ টিকেটে সমান্তরাল ২০টা চেষ্টা — ঠিক একজন সফল', async () => {
    const { categoryId } = await makeEvent({ qty: 1 });
    const users = await Promise.all(Array.from({ length: 20 }, () => makeUser()));

    const results = await Promise.all(users.map(uid =>
      tickets.reserve({ userId: uid, categoryId, qty: 1 })
        .then(() => 'ok')
        .catch(e => e.code)
    ));

    expect(results.filter(r => r === 'ok')).toHaveLength(1);
    expect(results.filter(r => r === tickets.CODES.SOLD_OUT)).toHaveLength(19);

    const state = await categoryState(categoryId);
    expect(Number(state.sold_qty)).toBe(1);
  });

  test('sold_qty কখনো total_qty ছাড়ায় না', async () => {
    const { categoryId } = await makeEvent({ qty: 5, maxPerUser: 10 });
    const users = await Promise.all(Array.from({ length: 12 }, () => makeUser()));

    await Promise.all(users.map(uid =>
      tickets.reserve({ userId: uid, categoryId, qty: 2 }).catch(() => null)
    ));

    const state = await categoryState(categoryId);
    expect(Number(state.sold_qty)).toBeLessThanOrEqual(Number(state.total_qty));
  });

  test('মেয়াদোত্তীর্ণ reservation নিজে থেকে ইনভেন্টরি ছেড়ে দেয়', async () => {
    const { categoryId } = await makeEvent({ qty: 3 });
    const userId = await makeUser();
    const order = await tickets.reserve({ userId, categoryId, qty: 2 });
    expect(Number((await categoryState(categoryId)).sold_qty)).toBe(2);

    // reserved_until অতীতে সরিয়ে দিয়ে ঠিক সেই অবস্থাটাই তৈরি করা হচ্ছে
    // যেটা ১৫ মিনিট পর বাস্তবে হয় — টেস্টে অপেক্ষা করা অবাস্তব।
    await pool.query(
      `UPDATE ticket_orders SET reserved_until = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [order.id]
    );
    const out = await tickets.expireReservations();
    expect(out.orders).toBeGreaterThanOrEqual(1);

    expect(Number((await categoryState(categoryId)).sold_qty)).toBe(0);
    const o = await pool.query('SELECT status FROM ticket_orders WHERE id = $1', [order.id]);
    expect(o.rows[0].status).toBe('cancelled');
  });

  test('per-user সীমা প্রয়োগ হয়', async () => {
    const { categoryId } = await makeEvent({ qty: 50, maxPerUser: 4 });
    const userId = await makeUser();
    await tickets.reserve({ userId, categoryId, qty: 3 });

    await expect(tickets.reserve({ userId, categoryId, qty: 2 }))
      .rejects.toMatchObject({ code: tickets.CODES.LIMIT_EXCEEDED });

    // ঠিক সীমা পর্যন্ত যাওয়া যায়
    await expect(tickets.reserve({ userId, categoryId, qty: 1 })).resolves.toBeDefined();
  });

  test('বাতিল হওয়া অর্ডার per-user কোটা খায় না', async () => {
    const { categoryId } = await makeEvent({ qty: 50, maxPerUser: 2 });
    const userId = await makeUser();
    const order = await tickets.reserve({ userId, categoryId, qty: 2 });

    await pool.query(
      `UPDATE ticket_orders SET reserved_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [order.id]
    );
    await tickets.expireReservations();

    // কোটা ফিরে পাওয়া উচিত — নাহলে একবার সময় পেরোলেই ইউজার চিরতরে ব্লক
    await expect(tickets.reserve({ userId, categoryId, qty: 2 })).resolves.toBeDefined();
  });

  test('ব্যালেন্স পেমেন্টে টাকা ও লেজার সঙ্গতিপূর্ণ; ডাবল-পে টাকা কাটে না', async () => {
    const { categoryId } = await makeEvent({ qty: 10, price: 500 });
    const userId = await makeUser(5000);
    const order = await tickets.reserve({ userId, categoryId, qty: 2 }); // মোট ১০০০

    await tickets.payWithBalance(userId, order.order_ref);
    let bal = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    expect(Number(bal.rows[0].coins)).toBe(4000);

    const led = await pool.query(
      `SELECT amount, type FROM coin_transactions WHERE user_id = $1 AND type = 'ticket_purchase'`, [userId]
    );
    expect(led.rows).toHaveLength(1);
    expect(Number(led.rows[0].amount)).toBe(-1000);

    // দ্বিতীয় কল — no-op
    await tickets.payWithBalance(userId, order.order_ref);
    bal = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    expect(Number(bal.rows[0].coins)).toBe(4000);
  });

  test('ব্যালেন্স কম হলে অর্ডার reserved-ই থাকে, টাকা কাটে না', async () => {
    const { categoryId } = await makeEvent({ qty: 10, price: 5000 });
    const userId = await makeUser(100);
    const order = await tickets.reserve({ userId, categoryId, qty: 1 });

    await expect(tickets.payWithBalance(userId, order.order_ref))
      .rejects.toMatchObject({ code: tickets.CODES.INSUFFICIENT_FUNDS });

    const bal = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    expect(Number(bal.rows[0].coins)).toBe(100);
    const o = await pool.query('SELECT status FROM ticket_orders WHERE id = $1', [order.id]);
    expect(o.rows[0].status).toBe('reserved');
  });

  test('টিকেট ইস্যু idempotent; একই টিকেট দুবার স্ক্যান করা যায় না', async () => {
    const { categoryId } = await makeEvent({ qty: 10, price: 100 });
    const userId = await makeUser(5000);
    const order = await tickets.reserve({ userId, categoryId, qty: 2 });
    await tickets.payWithBalance(userId, order.order_ref);

    await tickets.issueTickets(order.id);
    await tickets.issueTickets(order.id); // রিট্রাই সিমুলেশন

    const issued = await pool.query('SELECT ticket_code FROM issued_tickets WHERE order_id = $1', [order.id]);
    expect(issued.rows).toHaveLength(2);

    const code = issued.rows[0].ticket_code;
    await expect(tickets.verifyTicket(code)).resolves.toBeDefined();
    await expect(tickets.verifyTicket(code))
      .rejects.toMatchObject({ code: tickets.CODES.TICKET_ALREADY_USED });
  });

  test('রিফান্ডে টিকেট void হয়, ইনভেন্টরি ও ব্যালেন্স ফিরে আসে', async () => {
    const { categoryId } = await makeEvent({ qty: 10, price: 300 });
    const userId = await makeUser(5000);
    const order = await tickets.reserve({ userId, categoryId, qty: 2 });
    await tickets.payWithBalance(userId, order.order_ref);
    await tickets.issueTickets(order.id);

    expect(Number((await categoryState(categoryId)).sold_qty)).toBe(2);

    await tickets.refundOrder(order.id, { refundToBalance: true });

    expect(Number((await categoryState(categoryId)).sold_qty)).toBe(0);
    const bal = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    expect(Number(bal.rows[0].coins)).toBe(5000);
    const t = await pool.query('SELECT status FROM issued_tickets WHERE order_id = $1', [order.id]);
    t.rows.forEach(r => expect(r.status).toBe('void'));
  });

  test('অবৈধ পরিমাণ প্রত্যাখ্যাত', async () => {
    const { categoryId } = await makeEvent({ qty: 10 });
    const userId = await makeUser();
    for (const bad of [0, -1, 'abc', null, 999]) {
      await expect(tickets.reserve({ userId, categoryId, qty: bad })).rejects.toBeDefined();
    }
    expect(Number((await categoryState(categoryId)).sold_qty)).toBe(0);
  });
});
