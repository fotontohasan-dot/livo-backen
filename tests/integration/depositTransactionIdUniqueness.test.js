// tests/integration/depositTransactionIdUniqueness.test.js
// ---------------------------------------------------------------------------
// ডিপোজিটের ট্রানজেকশন আইডি (TrxID) ইউনিকনেস — আসল PostgreSQL-এর বিরুদ্ধে।
//
// যা লক করছে:
//  ১) normalize: ট্রিম, ফরম্যাট ও দৈর্ঘ্য যাচাই।
//  ২) একই TrxID ভিন্ন মেথডে (bkash → nagad) আর জমা দেওয়া যায় না।
//  ৩) case/whitespace বদলালেও (abc → ABC, " ABC ") ডুপ্লিকেট ধরা পড়ে।
//  ৪) অন্য ইউজারের TrxID কখনোই চলে না; নিজের rejected TrxID আবার দেওয়া যায়।
//  ৫) একসাথে দুটো রিকোয়েস্ট (race) পাঠালে ঠিক একটাই সফল হয়।
//  ৬) ডাটাবেজের unique index নিজেই (অ্যাপ-চেক ছাড়া) ডুপ্লিকেট INSERT আটকায়।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const trxIds = require('../../services/transactionId');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

describe('normalizeTransactionId', () => {
  test('ট্রিম করে এবং বড়হাতের key দেয়', () => {
    const r = trxIds.normalizeTransactionId('  abc123XYZ  ');
    expect(r).toEqual({ ok: true, value: 'abc123XYZ', key: 'ABC123XYZ' });
  });

  test('খালি/অস্ট্রিং ইনপুটকে missing ধরে', () => {
    expect(trxIds.normalizeTransactionId('')).toEqual({ ok: false, reason: 'missing' });
    expect(trxIds.normalizeTransactionId('   ')).toEqual({ ok: false, reason: 'missing' });
    expect(trxIds.normalizeTransactionId(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(trxIds.normalizeTransactionId(['A1B2C3D4'])).toEqual({ ok: false, reason: 'missing' });
  });

  test('ছোট, বড়, ভেতরে স্পেস বা অদ্ভুত অক্ষর থাকলে invalid', () => {
    expect(trxIds.normalizeTransactionId('ab1').reason).toBe('invalid');
    expect(trxIds.normalizeTransactionId('A'.repeat(101)).reason).toBe('invalid');
    expect(trxIds.normalizeTransactionId('AB CD 1234').reason).toBe('invalid');
    expect(trxIds.normalizeTransactionId("AB12'; DROP TABLE x;--").reason).toBe('invalid');
    expect(trxIds.normalizeTransactionId('-ABC1234').reason).toBe('invalid');
  });

  test('বাস্তব ফরম্যাট (bKash TrxID, ক্রিপ্টো হ্যাশ) গ্রহণযোগ্য', () => {
    expect(trxIds.normalizeTransactionId('9K3L2M1N0P').ok).toBe(true);
    expect(trxIds.normalizeTransactionId('0x' + 'a1'.repeat(32)).ok).toBe(true);
  });
});

async function registerAndLogin() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('trx');
  const res = await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  expect(res.status).toBe(302);
  const row = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, userId: row.rows[0].id };
}

async function csrf(agent) {
  const res = await agent.get('/payment/deposit');
  const m = /<meta name="csrf-token" content="([^"]*)"/.exec(res.text || '');
  return m ? m[1] : '';
}

async function submit(agent, { method = 'bkash', trx, amount = '500', account = '01712345678' }) {
  const token = await csrf(agent);
  return agent
    .post('/payment/deposit')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ method, amount, transaction_id: trx, account_number: account, want_bonus: 'no', _csrf: token });
}

const countByKey = async (key) =>
  Number((await pool.query(
    `SELECT COUNT(*)::int AS c FROM payment_requests
      WHERE type = 'deposit' AND UPPER(BTRIM(transaction_id)) = $1`, [key])).rows[0].c);

const uid = () => (Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)).toUpperCase();

describe('ডিপোজিট TrxID ইউনিকনেস (DB-ভিত্তিক)', () => {
  test('প্রথম সাবমিশন সফল; একই মেথডে একই TrxID আবার দিলে ব্লক', async () => {
    const { agent } = await registerAndLogin();
    const trx = 'SAME' + uid();
    expect((await submit(agent, { trx })).status).toBe(302);
    expect(await countByKey(trx)).toBe(1);

    await submit(agent, { trx });
    expect(await countByKey(trx)).toBe(1);
  });

  test('একই TrxID ভিন্ন পেমেন্ট মেথডে (bkash → nagad/rocket/bank) আর জমা দেওয়া যায় না', async () => {
    const { agent } = await registerAndLogin();
    const trx = 'XMETH' + uid();
    await submit(agent, { method: 'bkash', trx });
    for (const method of ['nagad', 'rocket', 'upay', 'bank', 'crypto']) {
      await submit(agent, { method, trx });
    }
    expect(await countByKey(trx)).toBe(1);
  });

  test('একই TrxID অন্য ইউজার আর ব্যবহার করতে পারে না — মেথড বদলালেও', async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const trx = 'XUSER' + uid();
    await submit(a.agent, { method: 'bkash', trx });
    await submit(b.agent, { method: 'bkash', trx });
    await submit(b.agent, { method: 'nagad', trx });
    expect(await countByKey(trx)).toBe(1);
  });

  test('বড়/ছোট হাতের অক্ষর ও আগে-পরের স্পেস বদলালেও ডুপ্লিকেট ধরা পড়ে', async () => {
    const { agent } = await registerAndLogin();
    const trx = 'CASE' + uid();
    await submit(agent, { trx: trx.toLowerCase() });
    await submit(agent, { method: 'nagad', trx: trx.toUpperCase() });
    await submit(agent, { method: 'rocket', trx: `  ${trx}  ` });
    expect(await countByKey(trx)).toBe(1);
  });

  test('নিজের rejected TrxID আবার জমা দেওয়া যায়; অন্যের rejected TrxID যায় না', async () => {
    const a = await registerAndLogin();
    const b = await registerAndLogin();
    const trx = 'REJ' + uid();
    await submit(a.agent, { trx });
    await pool.query(
      `UPDATE payment_requests SET status = 'rejected'
        WHERE type = 'deposit' AND UPPER(BTRIM(transaction_id)) = $1`, [trx]);

    // অন্য ইউজার — ব্লক
    await submit(b.agent, { trx });
    expect(await countByKey(trx)).toBe(1);

    // মালিক নিজে — চলবে
    await submit(a.agent, { trx });
    expect(await countByKey(trx)).toBe(2);
  });

  test('একসাথে একই TrxID-র একাধিক রিকোয়েস্ট পাঠালে ঠিক একটাই সফল হয় (race)', async () => {
    const users = await Promise.all([registerAndLogin(), registerAndLogin(), registerAndLogin()]);
    const trx = 'RACE' + uid();
    const methods = ['bkash', 'nagad', 'rocket'];
    await Promise.all(users.map((u, i) => submit(u.agent, { method: methods[i], trx })));
    expect(await countByKey(trx)).toBe(1);
  });

  test('অবৈধ ফরম্যাটের TrxID সারি তৈরি করে না', async () => {
    const { agent, userId } = await registerAndLogin();
    await submit(agent, { trx: 'ab' });
    await submit(agent, { trx: 'AB CD 1234' });
    const rows = await pool.query(
      `SELECT 1 FROM payment_requests WHERE user_id = $1 AND type = 'deposit'`, [userId]);
    expect(rows.rowCount).toBe(0);
  });
});

describe('ডাটাবেজ unique index — অ্যাপ-চেক ছাড়াই', () => {
  test('idx_pr_deposit_trxid_global_unique বিদ্যমান', async () => {
    const r = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_pr_deposit_trxid_global_unique'`);
    expect(r.rowCount).toBe(1);
  });

  test('সরাসরি INSERT-এও ভিন্ন মেথড/কেস-এর ডুপ্লিকেট 23505-এ ব্যর্থ হয়', async () => {
    const { userId } = await registerAndLogin();
    const trx = 'DBIDX' + uid();
    const ins = (method, id) => pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status)
       VALUES ($1, 'deposit', $2, 500, $3, '01700000000', 'pending')`, [userId, method, id]);
    await ins('bkash', trx);
    await expect(ins('nagad', trx.toLowerCase())).rejects.toMatchObject({ code: '23505' });
    await expect(ins('rocket', ` ${trx} `)).rejects.toMatchObject({ code: '23505' });
  });

  test('উইথড্র সারি (admin ref) ডিপোজিট TrxID-র সাথে সংঘর্ষ করে না', async () => {
    const { userId } = await registerAndLogin();
    const trx = 'WDREF' + uid();
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status)
       VALUES ($1, 'deposit', 'bkash', 500, $2, '01700000000', 'pending')`, [userId, trx]);
    await expect(pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, account_number, status)
       VALUES ($1, 'withdraw', 'bkash', 500, $2, '01700000000', 'pending')`, [userId, trx])
    ).resolves.toBeDefined();
  });
});
