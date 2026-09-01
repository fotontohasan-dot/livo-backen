// tests/security/rewardConcurrency.test.js
// ---------------------------------------------------------------------------
// রিওয়ার্ড এন্ডপয়েন্টে ডাবল-ক্লেইম ও রেস কন্ডিশন যাচাই।
//
// এই suite কোনো সার্ভিস mock করে না — আসল HTTP এন্ডপয়েন্টে সমান্তরাল রিকোয়েস্ট
// পাঠিয়ে দেখা হয় একই রিওয়ার্ড একাধিকবার পাওয়া যায় কি না, এবং প্রতিবার
// লেজার-ইনভেরিয়েন্ট (balance পরিবর্তন == coin_transactions-এর যোগফল) অটুট
// থাকে কি না। কোড পড়ে "গার্ড আছে" বলার চেয়ে এটা শক্ত প্রমাণ, কারণ গার্ড
// থাকা আর গার্ড কাজ করা এক জিনিস নয়।
//
// লক্ষ্য: রিগ্রেশন-জাল। ভবিষ্যতে কেউ কোনো ক্লেইম পথ থেকে লক/UNIQUE
// কনস্ট্রেইন্ট সরালে এখানেই ধরা পড়বে।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken } = require('../helpers/app');

const PARALLEL = 5;

async function makeUser({ coins = 0 } = {}) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const res = await pool.query(
    'UPDATE users SET coins = $1 WHERE username = $2 RETURNING id', [coins, username]
  );
  if (!res.rows[0]) throw new Error('টেস্ট ইউজার তৈরি হয়নি');
  const page = await agent.get('/profile');
  return { agent, id: res.rows[0].id, csrf: extractCsrfToken(page.text) };
}

const coinsOf = async (id) =>
  Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);

const ledgerSum = async (id) => Number((await pool.query(
  'SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions WHERE user_id=$1', [id]
)).rows[0].s);

// একটি এন্ডপয়েন্টে PARALLEL সংখ্যক রিকোয়েস্ট একসাথে পাঠায়
async function hammer(user, path, body = {}) {
  return Promise.all(Array.from({ length: PARALLEL }, () =>
    user.agent.post(path).type('form').send({ _csrf: user.csrf, ...body })
      .catch(e => ({ status: 0, error: e.message }))
  ));
}

// একটি ক্লেইম-টাইপের coin_transactions সারি গুনে দেখা
const claimRows = async (id, types) => Number((await pool.query(
  `SELECT COUNT(*)::int AS c FROM coin_transactions WHERE user_id=$1 AND type = ANY($2)`,
  [id, types]
)).rows[0].c);

afterAll(async () => { await pool.end().catch(() => {}); });

describe('ডেইলি বোনাস — সমান্তরাল ক্লেইম', () => {
  test('একসাথে ৫টি রিকোয়েস্ট পাঠালেও বোনাস একবারের বেশি জমা হয় না', async () => {
    const u = await makeUser();
    const before = await coinsOf(u.id);

    await hammer(u, '/coins/daily-bonus');

    const after = await coinsOf(u.id);
    const rows = await claimRows(u.id, ['daily_bonus', 'daily_reward', 'bonus']);
    // শূন্য বা এক — কোনোভাবেই একাধিক নয়
    expect(rows).toBeLessThanOrEqual(1);
    if (rows === 0) expect(after).toBe(before);
  });

  test('ডেইলি বোনাসের পর ব্যালেন্স == লেজারের যোগফল', async () => {
    const u = await makeUser();
    await hammer(u, '/coins/daily-bonus');
    expect(await coinsOf(u.id)).toBe(await ledgerSum(u.id));
  });
});

describe('লাকি হুইল — সমান্তরাল স্পিন', () => {
  test('একসাথে ৫টি স্পিন পাঠালেও দৈনিক সীমার বেশি স্পিন হয় না', async () => {
    const u = await makeUser({ coins: 10000 });
    const results = await hammer(u, '/profile/wheel/spin');

    const succeeded = results.filter(r => {
      try { return r.status === 200 && JSON.parse(r.text).success; } catch { return false; }
    }).length;

    const spins = Number((await pool.query(
      `SELECT COUNT(*)::int AS c FROM daily_rewards
       WHERE user_id=$1 AND reward_type='wheel' AND claim_date=CURRENT_DATE`, [u.id]
    )).rows[0].c);

    // daily_rewards-এ UNIQUE(user_id, reward_type, claim_date) আছে — সমান্তরাল
    // স্পিনে একাধিক সারি বসতে পারলে সেই কনস্ট্রেইন্ট বা লেনদেন ভেঙেছে
    expect(spins).toBeLessThanOrEqual(1);
    expect(succeeded).toBeLessThanOrEqual(1);
  });

  test('স্পিনের পর ব্যালেন্স == শুরুর ব্যালেন্স + লেজারের যোগফল', async () => {
    const START = 10000;
    const u = await makeUser({ coins: START });
    await hammer(u, '/profile/wheel/spin');
    expect(await coinsOf(u.id)).toBe(START + await ledgerSum(u.id));
  });
});

describe('রেড প্যাকেট ও গোল্ডেন এগ — সমান্তরাল ক্লেইম', () => {
  test.each([
    ['red-packet', '/profile/daily-rewards/red-packet/claim'],
    ['golden-egg', '/profile/daily-rewards/golden-egg/claim']
  ])('%s — একসাথে ৫টি ক্লেইমে একটির বেশি সারি বসে না', async (type, path) => {
    const u = await makeUser({ coins: 5000 });
    await hammer(u, path);

    const rows = Number((await pool.query(
      `SELECT COUNT(*)::int AS c FROM daily_rewards WHERE user_id=$1 AND claim_date=CURRENT_DATE`,
      [u.id]
    )).rows[0].c);
    expect(rows).toBeLessThanOrEqual(1);
    expect(await coinsOf(u.id)).toBe(5000 + await ledgerSum(u.id));
  });
});

describe('ক্যাশব্যাক ও শেয়ার — সমান্তরাল ক্লেইম', () => {
  test('ক্যাশব্যাক ক্লেইম সমান্তরালে চালালে একাধিকবার জমা হয় না', async () => {
    const u = await makeUser();
    await hammer(u, '/profile/cashback/claim');
    const rows = await claimRows(u.id, ['cashback']);
    expect(rows).toBeLessThanOrEqual(1);
    expect(await coinsOf(u.id)).toBe(await ledgerSum(u.id));
  });

  test('শেয়ার রিওয়ার্ড সমান্তরালে চালালে একাধিকবার জমা হয় না', async () => {
    const u = await makeUser();
    await hammer(u, '/profile/share/claim');
    const rows = Number((await pool.query(
      `SELECT COUNT(*)::int AS c FROM social_shares WHERE user_id=$1 AND share_date=CURRENT_DATE`,
      [u.id]
    )).rows[0].c);
    expect(rows).toBeLessThanOrEqual(1);
    expect(await coinsOf(u.id)).toBe(await ledgerSum(u.id));
  });
});

describe('ঋণাত্মক ব্যালেন্স ও রিওয়ার্ড ইনফ্লেশন', () => {
  test('কোনো ক্লেইম পথ ব্যালেন্স ঋণাত্মক করতে পারে না', async () => {
    const u = await makeUser({ coins: 0 });
    await hammer(u, '/profile/wheel/spin');
    await hammer(u, '/profile/cashback/claim');
    await hammer(u, '/coins/daily-bonus');
    expect(await coinsOf(u.id)).toBeGreaterThanOrEqual(0);
  });

  test('সব ক্লেইমের পরেও ব্যালেন্স == শুরুর ব্যালেন্স + লেজার', async () => {
    const START = 2500;
    const u = await makeUser({ coins: START });
    await hammer(u, '/coins/daily-bonus');
    await hammer(u, '/profile/wheel/spin');
    await hammer(u, '/profile/cashback/claim');
    await hammer(u, '/profile/share/claim');
    await hammer(u, '/profile/daily-rewards/red-packet/claim');
    expect(await coinsOf(u.id)).toBe(START + await ledgerSum(u.id));
  });
});
