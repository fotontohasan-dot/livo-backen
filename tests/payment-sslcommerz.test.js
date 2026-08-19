// SSLCommerz কলব্যাক হ্যান্ডলারগুলোর রিগ্রেশন টেস্ট।
// আসল স্যান্ডবক্সে নেটওয়ার্ক কল না করে services/sslcommerz মক করা হয়েছে — এখানে যাচাইয়ের বিষয়
// গেটওয়ে ইন্টিগ্রেশন নয়, বরং গেটওয়ের উত্তর পাওয়ার *পরে* আমাদের নিজেদের ক্রেডিট লজিক।
jest.mock('../services/sslcommerz', () => {
  const store = new Map(); // val_id -> { tran_id, amount }
  return {
    __store: store,
    initPayment: jest.fn(async ({ tranId }) => `https://sandbox.sslcommerz.com/pay/${tranId}`),
    validatePayment: jest.fn(async (valId) => {
      const rec = store.get(valId);
      if (!rec) return { status: 'INVALID_TRANSACTION' };
      return { status: 'VALID', tran_id: rec.tran_id, amount: rec.amount, val_id: valId };
    }),
    validateByTransactionId: jest.fn(async (tranId) => {
      for (const [, rec] of store) {
        if (rec.tran_id === tranId) return { status: 'VALID', amount: rec.amount, raw: {} };
      }
      return { status: 'NOT_FOUND', amount: null, raw: {} };
    })
  };
});

const sslcommerz = require('../services/sslcommerz');
const { getCsrfAgent, freshRequest, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  return { agent, token, username, userId: row.id };
}

const coinsOf = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);
const prById = async (id) => (await pool.query('SELECT * FROM payment_requests WHERE id=$1', [id])).rows[0];

async function initDeposit(user, amount) {
  const res = await user.agent.post('/payment/sslcommerz/init').type('form')
    .send({ amount: String(amount), _csrf: user.token });
  const row = (await pool.query(
    "SELECT * FROM payment_requests WHERE user_id=$1 AND gateway='sslcommerz' ORDER BY id DESC LIMIT 1", [user.userId]
  )).rows[0];
  return { res, row };
}

describe('SSLCommerz deposit callbacks', () => {
  test('init একটা pending রিকোয়েস্ট তৈরি করে গেটওয়েতে রিডাইরেক্ট করে', async () => {
    const u = await makeUser();
    const { res, row } = await initDeposit(u, 500);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/sslcommerz/);
    expect(row.status).toBe('pending');
    expect(Number(row.amount)).toBe(500);
  });

  // /payment/sslcommerz/init লগইন করা ইউজারের ব্রাউজার থেকে আসা state-changing POST,
  // গেটওয়ের সার্ভার-টু-সার্ভার কলব্যাক নয় — তাই CSRF টোকেন বাধ্যতামূলক।
  test('CSRF টোকেন ছাড়া init প্রত্যাখ্যাত হয় এবং কোনো রিকোয়েস্ট তৈরি হয় না', async () => {
    const u = await makeUser();
    const before = (await pool.query('SELECT COUNT(*) c FROM payment_requests WHERE user_id=$1', [u.userId])).rows[0].c;
    const res = await u.agent.post('/payment/sslcommerz/init').type('form').send({ amount: '500' });
    expect(res.status).toBe(403);
    const after = (await pool.query('SELECT COUNT(*) c FROM payment_requests WHERE user_id=$1', [u.userId])).rows[0].c;
    expect(after).toBe(before);
  });

  test('সঠিক val_id-তে ঠিক একবারই কয়েন ক্রেডিট হয়', async () => {
    const u = await makeUser();
    const start = await coinsOf(u.userId);
    const { row } = await initDeposit(u, 500);
    sslcommerz.__store.set('VAL_OK', { tran_id: row.gateway_tran_id, amount: 500 });

    await u.agent.post('/payment/sslcommerz/success').type('form')
      .send({ tran_id: row.gateway_tran_id, val_id: 'VAL_OK' });
    expect(await coinsOf(u.userId)).toBe(start + 500);
    expect((await prById(row.id)).status).toBe('approved');

    await u.agent.post('/payment/sslcommerz/success').type('form')
      .send({ tran_id: row.gateway_tran_id, val_id: 'VAL_OK' });
    expect(await coinsOf(u.userId)).toBe(start + 500);
  });

  test('অ্যামাউন্ট না মিললে ক্রেডিট হয় না', async () => {
    const u = await makeUser();
    const start = await coinsOf(u.userId);
    const { row } = await initDeposit(u, 500);
    sslcommerz.__store.set('VAL_AMT', { tran_id: row.gateway_tran_id, amount: 100 });
    await u.agent.post('/payment/sslcommerz/success').type('form')
      .send({ tran_id: row.gateway_tran_id, val_id: 'VAL_AMT' });
    expect(await coinsOf(u.userId)).toBe(start);
    expect((await prById(row.id)).status).toBe('rejected');
  });

  // রিগ্রেশন: val_id গেটভেতে ভ্যালিড হলেই যথেষ্ট নয় — সেটা *এই* ট্রানজেকশনেরই val_id কিনা
  // যাচাই করতে হবে। নাহলে একটা সফল পেমেন্টের val_id বারবার রিপ্লে করে সীমাহীন কয়েন নেওয়া যেত।
  test('অন্য ট্রানজেকশনের val_id দিয়ে success রিপ্লে করা যায় না', async () => {
    const payer = await makeUser();
    const attacker = await makeUser();

    const { row: pRow } = await initDeposit(payer, 500);
    sslcommerz.__store.set('VAL_REPLAY', { tran_id: pRow.gateway_tran_id, amount: 500 });
    await payer.agent.post('/payment/sslcommerz/success').type('form')
      .send({ tran_id: pRow.gateway_tran_id, val_id: 'VAL_REPLAY' });
    expect((await prById(pRow.id)).status).toBe('approved');

    const { row: aRow } = await initDeposit(attacker, 500);
    const before = await coinsOf(attacker.userId);
    await attacker.agent.post('/payment/sslcommerz/success').type('form')
      .send({ tran_id: aRow.gateway_tran_id, val_id: 'VAL_REPLAY' });

    expect((await prById(aRow.id)).status).not.toBe('approved');
    expect(await coinsOf(attacker.userId)).toBe(before);
  });

  test('IPN-এও অন্য ট্রানজেকশনের val_id দিয়ে ক্রেডিট নেওয়া যায় না', async () => {
    const payer = await makeUser();
    const attacker = await makeUser();

    const { row: pRow } = await initDeposit(payer, 700);
    sslcommerz.__store.set('VAL_IPN', { tran_id: pRow.gateway_tran_id, amount: 700 });
    await freshRequest().post('/payment/sslcommerz/ipn').type('form')
      .send({ tran_id: pRow.gateway_tran_id, val_id: 'VAL_IPN' });
    expect((await prById(pRow.id)).status).toBe('approved');

    const { row: aRow } = await initDeposit(attacker, 700);
    const before = await coinsOf(attacker.userId);
    await freshRequest().post('/payment/sslcommerz/ipn').type('form')
      .send({ tran_id: aRow.gateway_tran_id, val_id: 'VAL_IPN' });

    expect((await prById(aRow.id)).status).not.toBe('approved');
    expect(await coinsOf(attacker.userId)).toBe(before);
  });

  test('fail/cancel শুধু নিজের pending রিকোয়েস্টেই কাজ করে', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const { row } = await initDeposit(owner, 500);
    sslcommerz.__store.set('VAL_CANCEL', { tran_id: row.gateway_tran_id, amount: 500 });

    await other.agent.post('/payment/sslcommerz/fail').type('form').send({ tran_id: row.gateway_tran_id });
    expect((await prById(row.id)).status).toBe('pending');

    await owner.agent.post('/payment/sslcommerz/cancel').type('form').send({ tran_id: row.gateway_tran_id });
    expect((await prById(row.id)).status).toBe('rejected');
  });
  // success ও IPN — দুটো পথ একই ট্রানজেকশনকে দুইবার ক্রেডিট করতে পারে না।
  test('success-এর পর IPN এলে দ্বিতীয়বার ক্রেডিট হয় না', async () => {
    const u = await makeUser();
    const start = await coinsOf(u.userId);
    const { row } = await initDeposit(u, 900);
    sslcommerz.__store.set('VAL_BOTH', { tran_id: row.gateway_tran_id, amount: 900 });

    await u.agent.post('/payment/sslcommerz/success').type('form')
      .send({ tran_id: row.gateway_tran_id, val_id: 'VAL_BOTH' });
    expect(await coinsOf(u.userId)).toBe(start + 900);

    await freshRequest().post('/payment/sslcommerz/ipn').type('form')
      .send({ tran_id: row.gateway_tran_id, val_id: 'VAL_BOTH' });
    expect(await coinsOf(u.userId)).toBe(start + 900);

    const tx = await pool.query(
      "SELECT COUNT(*) c FROM coin_transactions WHERE user_id=$1 AND type='deposit'", [u.userId]);
    expect(Number(tx.rows[0].c)).toBe(1);
  });

  // গেটওয়ে যদি tran_id ফেরত না দেয়, ক্রেডিট হবে না (fail-closed) — নিরাপত্তার দিকে ঝুঁকে থাকা।
  test('verification-এ tran_id না থাকলে ক্রেডিট হয় না (fail-closed)', async () => {
    const u = await makeUser();
    const start = await coinsOf(u.userId);
    const { row } = await initDeposit(u, 500);
    // jest.spyOn(sslcommerz, ...).mockRestore() ব্যবহার করা হয়নি — sslcommerz ইতিমধ্যে
    // jest.mock() ফ্যাক্টরি দিয়ে সম্পূর্ণ মকড থাকায় এর ওপর spyOn().mockRestore() করলে
    // এই ফাইলের *পরবর্তী* টেস্টগুলোতে validatePayment স্থায়ীভাবে ভেঙে যায় (store-based
    // ডিফল্ট ইমপ্লিমেন্টেশনে আর ফিরে যায় না, ফলে পরের কলে undefined রিটার্ন হয়) —
    // ...Once ভ্যারিয়েন্ট নিজে থেকেই এক কলের পর ডিফল্টে ফিরে যায়, তাই restore লাগে না।
    sslcommerz.validatePayment.mockResolvedValueOnce({ status: 'VALID', amount: 500 }); // tran_id অনুপস্থিত
    await u.agent.post('/payment/sslcommerz/success').type('form')
      .send({ tran_id: row.gateway_tran_id, val_id: 'VAL_NO_TRAN' });
    expect(await coinsOf(u.userId)).toBe(start);
    expect((await prById(row.id)).status).toBe('rejected');
  });

  // রিগ্রেশন: IPN প্রসেসিং-এ অভ্যন্তরীণ ব্যর্থতা (DB এরর/গেটওয়ে timeout) হলেও আগে সবসময়
  // HTTP 200 ফেরত যেত — SSLCommerz সেটাকে "ডেলিভারড" ধরে নিয়ে আর রিট্রাই করত না, ফলে
  // আসলে সফল একটা ডিপোজিট চিরস্থায়ীভাবে pending থেকে যেতে পারত। এখন অভ্যন্তরীণ ব্যর্থতায়
  // non-2xx ফেরত যায় যাতে গেটওয়ে তার নিজস্ব রিট্রাই নীতি অনুযায়ী আবার IPN পাঠায়।
  test('IPN প্রসেসিং-এ অভ্যন্তরীণ ব্যর্থতা হলে non-200 রিটার্ন হয় (গেটওয়ে রিট্রাই করতে পারে)', async () => {
    const u = await makeUser();
    const start = await coinsOf(u.userId);
    const { row } = await initDeposit(u, 500);
    sslcommerz.__store.set('VAL_IPN_FAIL', { tran_id: row.gateway_tran_id, amount: 500 });

    // mockRejectedValueOnce সরাসরি জেস্ট মকের ওপর — jest.spyOn(...).mockRestore() এখানে
    // ব্যবহার করা হয়নি কারণ sslcommerz ইতিমধ্যে jest.mock() ফ্যাক্টরি দিয়ে সম্পূর্ণ মকড;
    // এটার ওপর spyOn().mockRestore() করলে পরবর্তী কলে undefined রিটার্ন হয় (ফ্যাক্টরির
    // আসল store-based ইমপ্লিমেন্টেশনে সঠিকভাবে ফিরে যায় না) — "...Once" নিজে থেকেই
    // এক কলের পর ডিফল্ট (store-based) ইমপ্লিমেন্টেশনে ফিরে যায়, তাই restore লাগে না।
    sslcommerz.validatePayment.mockRejectedValueOnce(new Error('gateway network boom'));
    const res = await freshRequest().post('/payment/sslcommerz/ipn').type('form')
      .send({ tran_id: row.gateway_tran_id, val_id: 'VAL_IPN_FAIL' });

    expect(res.status).not.toBe(200);
    // রো টা এখনো pending — হারিয়ে যায়নি, গেটওয়ে রিট্রাই করলে এখনো ক্রেডিট করা যায়।
    expect((await prById(row.id)).status).toBe('pending');
    expect(await coinsOf(u.userId)).toBe(start);

    // আসল রিট্রাই: একই IPN আবার আসলে এবার ঠিকভাবে ক্রেডিট হয়।
    await freshRequest().post('/payment/sslcommerz/ipn').type('form')
      .send({ tran_id: row.gateway_tran_id, val_id: 'VAL_IPN_FAIL' });
    expect(await coinsOf(u.userId)).toBe(start + 500);
  });

  // রিগ্রেশন: গেটওয়ে সেশন শুরু করা যায়নি (initPayment ব্যর্থ) হলে আগে insert করা pending
  // রো-টা চিরস্থায়ীভাবে pending থেকে যেত (কখনো ইউজার আর ফিরে আসবে না)। এখন সেটা rejected
  // হিসেবে বন্ধ হয়ে যাওয়া উচিত।
  test('initPayment ব্যর্থ হলে pending রো orphaned না থেকে rejected হয়', async () => {
    const u = await makeUser();
    const before = (await pool.query(
      "SELECT COUNT(*) c FROM payment_requests WHERE user_id=$1 AND status='pending'", [u.userId]
    )).rows[0].c;

    sslcommerz.initPayment.mockRejectedValueOnce(new Error('SSLCommerz গেটওয়ে সময়মতো সাড়া দেয়নি (timeout)'));
    await u.agent.post('/payment/sslcommerz/init').type('form')
      .send({ amount: '500', _csrf: u.token });

    const after = (await pool.query(
      "SELECT COUNT(*) c FROM payment_requests WHERE user_id=$1 AND status='pending'", [u.userId]
    )).rows[0].c;
    expect(Number(after)).toBe(Number(before)); // কোনো নতুন pending রো থেকে যায়নি

    const row = (await pool.query(
      "SELECT status FROM payment_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [u.userId]
    )).rows[0];
    expect(row.status).toBe('rejected');
  });

  // রিগ্রেশন: /sslcommerz/init আগে কোনো পেমেন্ট-নির্দিষ্ট rate limiter ছাড়াই ছিল (শুধু generalLimiter),
  // অথচ প্রতিটা কল একটা real আউটবাউন্ড গেটওয়ে কল ট্রিগার করে — /deposit ও /withdraw-এর মতোই
  // paymentLimiter (15/15min) দিয়ে বাউন্ড করা দরকার।
  test('/sslcommerz/init বারবার কল করলে rate-limit হয়ে যায়', async () => {
    const u = await makeUser();
    let sawLimit = false;
    for (let i = 0; i < 20; i++) {
      const res = await u.agent.post('/payment/sslcommerz/init').type('form')
        .send({ amount: '100', _csrf: u.token });
      if (res.status === 429) { sawLimit = true; break; }
    }
    expect(sawLimit).toBe(true);
  });
});
