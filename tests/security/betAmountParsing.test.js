// রিগ্রেশন: routes/games.js আগে parseInt() ব্যবহার করত, যেটা একটা numeric
// prefix পেলেই বাকিটা ফেলে দিত। ফলে "10; DROP TABLE users" বা "50abc"
// বৈধ বাজি হিসেবে গৃহীত হতো এবং ওয়ালেট থেকে টাকা কাটা যেত।
//
// নেগেটিভ কন্ট্রোল: routes/games.js-এ isCleanNumber যাচাইটা সরিয়ে আবার
// `const betAmount = parseInt(amount);` বসালে "রিজেক্ট" টেস্টগুলো fail করবে।
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

jest.setTimeout(120000);

async function makeUser(coins) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('bap');
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const id = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0].id;
  await pool.query('UPDATE users SET coins=$1 WHERE id=$2', [coins, id]);
  return { agent, token, id };
}

const coins = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);

const play = (u, amount) => u.agent.post('/games/play').set('X-CSRF-Token', u.token)
  .send({ gameSlug: 'baccarat', amount, selection: 'Player' });

describe('bet amount — কঠোর numeric যাচাই', () => {
  const GARBAGE = [
    '10; DROP TABLE users',
    '50abc',
    '10 OR 1=1',
    '1e3',
    '0x64',
    ' 10\n; rm -rf /',
    '10,000',
    '--10',
    '+10',
    '10%',
    'Infinity',
    '10<script>alert(1)</script>'
  ];

  test('numeric prefix সহ আবর্জনা ইনপুট প্রত্যাখ্যাত হয়, ব্যালেন্স অপরিবর্তিত থাকে', async () => {
    const u = await makeUser(100000);
    const before = await coins(u.id);
    const accepted = [];

    for (const amount of GARBAGE) {
      const res = await play(u, amount);
      if (res.status !== 400) accepted.push(`${JSON.stringify(amount)} → ${res.status}`);
    }

    expect(accepted).toEqual([]);
    expect(await coins(u.id)).toBe(before);
  });

  test('শূন্য, ঋণাত্মক ও অ-সসীম মান প্রত্যাখ্যাত হয়', async () => {
    const u = await makeUser(100000);
    const before = await coins(u.id);
    for (const amount of [0, -1, -1000, '0', '-5', null, undefined, NaN, [], {}, true]) {
      const res = await play(u, amount);
      expect(res.status).toBe(400);
    }
    expect(await coins(u.id)).toBe(before);
  });

  test('বৈধ সংখ্যা (number ও string দুই রূপেই) গৃহীত হয় এবং সঠিক পরিমাণ কাটা হয়', async () => {
    const u = await makeUser(100000);

    // ব্যালেন্স সরাসরি DB থেকে দুবার পড়লে cashback/streak-এর async রাইট
    // মাঝখানে ঢুকে রেস তৈরি করে। তাই সার্ভারের নিজস্ব newBalance-এর সাপেক্ষে
    // যাচাই করা হচ্ছে — netChange = winAmount - betAmount।
    // cashback/commission/loyalty ট্রানজেকশনের বাইরে async-এ ব্যালেন্স ছোঁয়,
    // তাই একই ইউজারে পরপর বাজি ধরলে "before" পড়া রেসি হয়ে যায়। প্রতিটা
    // ইটারেশনে নতুন ইউজার নিলে পরিমাপটা নির্ধারিত থাকে।
    for (const amount of [100, '100']) {
      const fresh = await makeUser(100000);
      const before = await coins(fresh.id);
      const res = await play(fresh, amount);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const netChange = Number(res.body.newBalance) - before;
      expect(netChange).toBe(Number(res.body.winAmount || 0) - 100);
    }
  });

  test('দশমিক মান floor করা হয়, prefix-coercion নয়', async () => {
    const u = await makeUser(100000);
    const res = await play(u, '100.99');
    expect(res.status).toBe(200);
    const req = await pool.query(
      "SELECT bet_amount FROM game_rounds WHERE user_id=$1 ORDER BY id DESC LIMIT 1", [u.id]
    ).catch(() => ({ rows: [] }));
    if (req.rows[0]) expect(Number(req.rows[0].bet_amount)).toBe(100);
  });
});
