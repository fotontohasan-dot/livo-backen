// tests/integration/paymentIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 03 — পেমেন্ট ও আর্থিক ইন্টিগ্রিটি রিগ্রেশন টেস্ট।
// আসল PostgreSQL-এর বিরুদ্ধে চলে; ডাটাবেজের যে আচরণ পরীক্ষা করা হচ্ছে তা mock করা হয়নি।
//
// এই ফেজে যে দুটো বাস্তব ফাঁক ধরা পড়েছিল এবং এখানে লক করা হচ্ছে:
//
//  ১) SSLCommerz কলব্যাকে currency কখনো যাচাই হতো না। initPayment() সবসময়
//     currency:'BDT' পাঠায়, কিন্তু /success ও /ipn শুধু status, amount ও tran_id
//     মেলাত। ফলে ট্রানজেকশন অন্য মুদ্রায় সেটল হলে সংখ্যাগত তুলনা (100 === 100)
//     পাস করে যেত যদিও আসল মূল্য বহুগুণ কম হতে পারত। তার উপর অঙ্ক তুলনার সময়
//     currency_amount-কে অগ্রাধিকার দেওয়া হতো, যা লেনদেনের মূল মুদ্রার অঙ্ক —
//     স্টোর-কারেন্সির (BDT) অঙ্ক নয়।
//
//  ২) payment_requests টেবিলে একটাও CHECK কনস্ট্রেইন্ট ছিল না — শুধু PK আর
//     user_id FK। অ্যাপ-লেভেল ভ্যালিডেশন ফাঁকি দিয়ে amount = -5000 বা
//     status = 'anything' ডাটাবেজে বসানো সম্ভব ছিল।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const paymentVerification = require('../../services/paymentVerification');

async function makeUser(coins = 1000) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ('payint_'||floor(random()*1e9), '019'||floor(random()*1e8), 'x', $1)
     RETURNING id`, [coins]
  );
  return r.rows[0].id;
}

describe('কলব্যাক কারেন্সি যাচাই', () => {
  test('BDT ট্রানজেকশন গ্রহণ করা হয়', () => {
    expect(paymentVerification.isExpectedCurrency({ currency_type: 'BDT', amount: '500' })).toBe(true);
    expect(paymentVerification.isExpectedCurrency({ currency: 'bdt' })).toBe(true); // কেস-ইনসেনসিটিভ
  });

  test('ভিন্ন মুদ্রার ট্রানজেকশন প্রত্যাখ্যাত হয়', () => {
    expect(paymentVerification.isExpectedCurrency({ currency_type: 'USD', amount: '500' })).toBe(false);
    expect(paymentVerification.isExpectedCurrency({ currency_type: 'EUR' })).toBe(false);
    expect(paymentVerification.isExpectedCurrency({ currency: 'INR' })).toBe(false);
  });

  test('প্রোভাইডার currency ফিল্ড না পাঠালে amount তুলনার উপরেই নির্ভর করা হয়', () => {
    // fail-closed করলে সব বৈধ পেমেন্ট আটকে যেত; তাই currency দিয়ে reject করা হয় না
    expect(paymentVerification.isExpectedCurrency({ amount: '500' })).toBe(true);
    expect(paymentVerification.isExpectedCurrency({})).toBe(true);
  });

  test('অঙ্ক তুলনায় স্টোর-কারেন্সির amount ব্যবহার হয়, currency_amount নয়', () => {
    // SSLCommerz-এ amount = স্টোর কারেন্সির অঙ্ক, currency_amount = মূল মুদ্রার অঙ্ক
    expect(paymentVerification.storeAmountOf({ amount: '500', currency_amount: '6' })).toBe(500);
    // amount না থাকলে fallback
    expect(paymentVerification.storeAmountOf({ currency_amount: '6' })).toBe(6);
  });

  test('অবৈধ/অনুপস্থিত অঙ্ক null হয় — NaN কখনো তুলনায় যায় না', () => {
    expect(paymentVerification.storeAmountOf({ amount: 'abc' })).toBeNull();
    expect(paymentVerification.storeAmountOf({})).toBeNull();
    expect(paymentVerification.storeAmountOf(null)).toBeNull();
    // NaN === NaN কখনোই true নয়, তাই null রিটার্ন করে স্পষ্টভাবে reject করা হয়
    expect(Number.isNaN(paymentVerification.storeAmountOf({ amount: 'abc' }))).toBe(false);
  });

  test('যাচাইয়ের যুক্তি গেটওয়ে মডিউলের বাইরে — mock করে নিষ্ক্রিয় করা যায় না', () => {
    // tests/payment-sslcommerz.test.js পুরো services/sslcommerz মডিউলটা jest.mock()
    // দিয়ে বদলে ফেলে। যাচাই ওই মডিউলে থাকলে মকড টেস্টে currency/amount চেক নিঃশব্দে
    // অদৃশ্য হয়ে যেত — অর্থাৎ একটা নিরাপত্তা পরীক্ষা টেস্ট-ডাবল দিয়ে বন্ধ করা যেত।
    const fs = require('fs');
    const path = require('path');
    const gateway = fs.readFileSync(
      path.join(__dirname, '..', '..', 'services', 'sslcommerz.js'), 'utf8');
    expect(gateway).not.toMatch(/function isExpectedCurrency/);
    expect(gateway).not.toMatch(/function amountMatchesRequest/);

    const route = fs.readFileSync(
      path.join(__dirname, '..', '..', 'routes', 'payment.js'), 'utf8');
    expect(route).toContain("require('../services/paymentVerification')");
    expect(route).toContain('paymentVerification.isExpectedCurrency');
    expect(route).toContain('paymentVerification.amountMatchesRequest');
  });

  test('উভয় কলব্যাকেই currency যাচাই যুক্ত হয়েছে', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'payment.js'), 'utf8');
    // /success (নেগেটিভ শর্ত) ও /ipn (পজিটিভ শর্ত) — দুটোতেই
    expect(src).toContain('!validStatus || !amountMatches || !tranMatches || !currencyMatches');
    expect(src).toContain('validStatus && amountMatches && tranMatches && currencyMatches');
  });
});

describe('payment_requests — ডাটাবেজ CHECK কনস্ট্রেইন্ট', () => {
  let userId;

  beforeAll(async () => { userId = await makeUser(); });
  afterAll(async () => {
    await pool.query('DELETE FROM payment_requests WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  test('চারটি আর্থিক কনস্ট্রেইন্টই VALID অবস্থায় বিদ্যমান', async () => {
    const r = await pool.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('payment_requests_amount_positive','payment_requests_status_valid',
                          'payment_requests_type_valid','users_coins_non_negative')`
    );
    expect(r.rows.length).toBe(4);
    for (const row of r.rows) expect(row.convalidated).toBe(true);
  });

  test('ঋণাত্মক amount ডাটাবেজ প্রত্যাখ্যান করে', async () => {
    await expect(
      pool.query(
        `INSERT INTO payment_requests (user_id, type, method, amount, status)
         VALUES ($1,'deposit','bkash',-5000,'pending')`, [userId]
      )
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  test('শূন্য amount প্রত্যাখ্যাত হয়', async () => {
    await expect(
      pool.query(
        `INSERT INTO payment_requests (user_id, type, method, amount, status)
         VALUES ($1,'deposit','bkash',0,'pending')`, [userId]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('অবৈধ status প্রত্যাখ্যাত হয়', async () => {
    await expect(
      pool.query(
        `INSERT INTO payment_requests (user_id, type, method, amount, status)
         VALUES ($1,'deposit','bkash',500,'completed')`, [userId]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('অবৈধ type প্রত্যাখ্যাত হয়', async () => {
    await expect(
      pool.query(
        `INSERT INTO payment_requests (user_id, type, method, amount, status)
         VALUES ($1,'transfer','bkash',500,'pending')`, [userId]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('বৈধ রিকোয়েস্ট আগের মতোই গ্রহণ করা হয় — আচরণ ভাঙেনি', async () => {
    const r = await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, status)
       VALUES ($1,'deposit','bkash',500,'pending') RETURNING id, amount`, [userId]
    );
    expect(Number(r.rows[0].amount)).toBe(500);

    // বৈধ স্ট্যাটাস ট্রানজিশনও কাজ করে
    await pool.query(`UPDATE payment_requests SET status='approved' WHERE id=$1`, [r.rows[0].id]);
    const after = await pool.query('SELECT status FROM payment_requests WHERE id=$1', [r.rows[0].id]);
    expect(after.rows[0].status).toBe('approved');
  });

  test('অবৈধ স্ট্যাটাসে UPDATE করাও প্রত্যাখ্যাত হয়', async () => {
    const r = await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, status)
       VALUES ($1,'withdraw','bkash',300,'pending') RETURNING id`, [userId]
    );
    await expect(
      pool.query(`UPDATE payment_requests SET status='settled' WHERE id=$1`, [r.rows[0].id])
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('ব্যালেন্স invariant', () => {
  test('ঋণাত্মক ব্যালেন্স ডাটাবেজ প্রত্যাখ্যান করে', async () => {
    const userId = await makeUser(100);
    await expect(
      pool.query('UPDATE users SET coins = -50 WHERE id = $1', [userId])
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  test('একসাথে একাধিক ডেবিট চেষ্টা করলেও ব্যালেন্স ঋণাত্মক হয় না', async () => {
    const userId = await makeUser(100);
    const debit = () => pool.query(
      'UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins',
      [80, userId]
    );

    const results = await Promise.all([debit(), debit(), debit(), debit()]);
    const ok = results.filter((r) => r.rowCount === 1).length;
    expect(ok).toBe(1); // check-then-update রেস নেই

    const after = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    expect(Number(after.rows[0].coins)).toBe(20);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });
});

describe('গেটওয়ে ট্রানজেকশন idempotency (বিদ্যমান সুরক্ষা অক্ষত)', () => {
  test('একই gateway_tran_id দুইবার ব্যবহার করা যায় না', async () => {
    const userId = await makeUser();
    const tranId = `LIVOTEST${Date.now()}`;

    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, status, gateway_tran_id)
       VALUES ($1,'deposit','sslcommerz',500,'pending',$2)`, [userId, tranId]
    );
    await expect(
      pool.query(
        `INSERT INTO payment_requests (user_id, type, method, amount, status, gateway_tran_id)
         VALUES ($1,'deposit','sslcommerz',500,'pending',$2)`, [userId, tranId]
      )
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation

    await pool.query('DELETE FROM payment_requests WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });
});

describe('আর্থিক ডেটার বাস্তব অবস্থা', () => {
  test('কোনো ঋণাত্মক ব্যালেন্স, অবৈধ অঙ্ক বা অসম্ভব স্ট্যাটাস নেই', async () => {
    const checks = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE coins < 0)                                       AS negative_balances,
        (SELECT COUNT(*) FROM payment_requests WHERE amount IS NULL OR amount <= 0)        AS bad_amounts,
        (SELECT COUNT(*) FROM payment_requests
          WHERE status NOT IN ('pending','approved','rejected'))                           AS bad_statuses,
        (SELECT COUNT(*) FROM payment_requests WHERE type NOT IN ('deposit','withdraw'))   AS bad_types,
        (SELECT COUNT(*) FROM payment_requests p
          WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id))                 AS orphans
    `);
    const row = checks.rows[0];
    expect(Number(row.negative_balances)).toBe(0);
    expect(Number(row.bad_amounts)).toBe(0);
    expect(Number(row.bad_statuses)).toBe(0);
    expect(Number(row.bad_types)).toBe(0);
    expect(Number(row.orphans)).toBe(0);
  });

  test('আর্থিক কলামগুলো NUMERIC — floating point নয়', async () => {
    const r = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name='payment_requests' AND column_name='amount'`
    );
    expect(r.rows[0].data_type).toBe('numeric');
  });
});
