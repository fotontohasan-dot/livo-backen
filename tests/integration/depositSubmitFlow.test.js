// tests/integration/depositSubmitFlow.test.js
// ---------------------------------------------------------------------------
// PHASE 2 — Deposit "জমা দিন / Submit" প্রকৃতপক্ষে কাজ করে কিনা তার প্রমাণ।
//
// আসল PostgreSQL-এর বিরুদ্ধে চলে (mock নয়) — একটা active payment method সিড
// করে, প্রকৃত লগইন সেশন দিয়ে পুরো ফর্ম POST করে, তারপর সরাসরি DB-তে
// payment_requests সারি তৈরি হয়েছে কিনা যাচাই করে। এটাই ধরে যে বাটন ক্লিক
// করলে "কিছু একটা দেখায়" তার বদলে আসল ডিপোজিট রিকোয়েস্ট তৈরি হয়েছে কিনা।
//
// এটা যা লক করছে:
//  ১) বৈধ সাবমিশনে payment_requests-এ ঠিক একটা সারি তৈরি হয় এবং /payment/history-এ
//     রিডাইরেক্ট হয় (আগে থেকেই কাজ করত — regression guard)।
//  ২) ভ্যালিডেশন ব্যর্থ হলে (যেমন duplicate transaction_id) req.flash('error', ...)
//     সেট হওয়ার পর deposit পেজে ফিরে গেলে সেই বার্তাটা আসলেই HTML-এ দেখা যায় —
//     এটাই Phase 2-র root-cause ফিক্স (আগে views/payment/deposit.ejs partials/flash
//     include করত না, তাই এরর নীরবে হারিয়ে যেত এবং বাটন "কাজ করছে না" মনে হতো)।
//  ৩) দ্বিতীয়বার একই transaction_id দিয়ে সাবমিট করলে দ্বিতীয় সারি তৈরি হয় না।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const paymentMethods = require('../../services/paymentMethods');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

async function registerAndLogin() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('dep');
  const phone = uniquePhone();
  const res = await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  expect(res.status).toBe(302);
  const userRow = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, userId: userRow.rows[0].id, username };
}

async function freshCsrfToken(agent, path = '/payment/deposit') {
  const res = await agent.get(path);
  const match = /<meta name="csrf-token" content="([^"]*)"/.exec(res.text || '');
  return { token: match ? match[1] : '', html: res.text };
}

describe('Deposit submit ফ্লো — Phase 2', () => {
  let methodRow;

  beforeAll(async () => {
    // টেস্ট রান ইউনিক — একই bank নম্বর আগের রান থেকে না থাকলে normalize/duplicate
    // এড়াতে র‍্যান্ডম সাফিক্স।
    const acct = 'TESTBANK' + Math.floor(Math.random() * 1e8);
    methodRow = await paymentMethods.create(
      { method: 'bank', accountNumber: acct, accountName: 'Phase2 Test Bank', status: 'active', accountType: 'personal' },
      null
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM payment_methods WHERE id = $1', [methodRow.id]);
  });

  test('বৈধ সাবমিশনে প্রকৃত payment_requests সারি তৈরি হয় এবং history-তে রিডাইরেক্ট করে', async () => {
    const { agent, userId } = await registerAndLogin();
    const { token } = await freshCsrfToken(agent);
    const trxId = 'TRX' + Date.now() + Math.floor(Math.random() * 1000);

    const res = await agent
      .post('/payment/deposit')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({
        method: 'bank',
        amount: '500',
        transaction_id: trxId,
        account_number: '01712345678',
        want_bonus: 'no',
        _csrf: token
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/payment/history');

    const row = await pool.query(
      `SELECT * FROM payment_requests WHERE user_id = $1 AND type = 'deposit' AND transaction_id = $2`,
      [userId, trxId]
    );
    expect(row.rows.length).toBe(1);
    expect(Number(row.rows[0].amount)).toBe(500);
    expect(row.rows[0].method).toBe('bank');
    expect(row.rows[0].status).toBe('pending');
  });

  test('root-cause ফিক্স: ভ্যালিডেশন এরর (duplicate transaction_id) আসলেই deposit পেজের HTML-এ দেখা যায়', async () => {
    const { agent, userId } = await registerAndLogin();
    const { token: t1 } = await freshCsrfToken(agent);
    const trxId = 'DUPTRX' + Date.now();

    const first = await agent
      .post('/payment/deposit')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ method: 'bank', amount: '500', transaction_id: trxId, account_number: '01712345678', want_bonus: 'no', _csrf: t1 });
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/payment/history');

    // একই ট্রানজেকশন আইডি দিয়ে দ্বিতীয়বার — সার্ভার req.flash('error', 'payment_duplicate_transaction_id')
    // সেট করে /payment/deposit-এ ফিরিয়ে দেয়।
    const { token: t2 } = await freshCsrfToken(agent);
    const second = await agent
      .post('/payment/deposit')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ method: 'bank', amount: '500', transaction_id: trxId, account_number: '01712345678', want_bonus: 'no', _csrf: t2 });
    expect(second.status).toBe(302);
    expect(second.headers.location).toBe('/payment/deposit');

    // এই রিডাইরেক্ট অনুসরণ করে আসল deposit পেজ লোড করে দেখা হচ্ছে এরর বার্তা
    // সত্যিই HTML-এ প্রিন্ট হচ্ছে কিনা (partials/flash include করার আগে এটা
    // কখনোই দেখা যেত না — ব্যবহারকারী শুধু ফাঁকা ফর্ম দেখতেন)।
    const followUp = await agent.get('/payment/deposit');
    expect(followUp.status).toBe(200);
    expect(followUp.text).toMatch(/alert-error/);

    // এবং দ্বিতীয়বার কোনো নতুন সারি তৈরি হয়নি — একটাই থাকা উচিত।
    const rows = await pool.query(
      `SELECT id FROM payment_requests WHERE user_id = $1 AND type = 'deposit' AND transaction_id = $2`,
      [userId, trxId]
    );
    expect(rows.rows.length).toBe(1);
  });

  test('পূর্ণসংখ্যা নয় এমন amount সার্ভার প্রত্যাখ্যান করে (কোনো সারি তৈরি হয় না)', async () => {
    const { agent, userId } = await registerAndLogin();
    const { token } = await freshCsrfToken(agent);
    const trxId = 'DECIMAL' + Date.now();

    const res = await agent
      .post('/payment/deposit')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({ method: 'bank', amount: '500.50', transaction_id: trxId, account_number: '01712345678', want_bonus: 'no', _csrf: token });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/payment/deposit');

    const rows = await pool.query(
      `SELECT id FROM payment_requests WHERE user_id = $1 AND type = 'deposit' AND transaction_id = $2`,
      [userId, trxId]
    );
    expect(rows.rows.length).toBe(0);
  });
});
