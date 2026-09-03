// tests/security/baccaratHouseEdge.test.js
// ---------------------------------------------------------------------------
// LIVO-02 রিগ্রেশন — ব্যাকারাটের Tie বাজিতে অস্বাভাবিক RTP।
//
// আগে ফলাফল ঠিক হতো `secureRandom.pick(['Player', 'Banker', 'Tie'])` দিয়ে —
// অর্থাৎ তিনটা ফলাফলই সমান ⅓ সম্ভাবনা পেত। কিন্তু পেআউটগুলো আসল ব্যাকারাটের
// কম্পাঙ্ক ধরে দাম করা: Tie-তে 8-for-1, Player/Banker-এ 1.95× (৫% কমিশনসহ)।
// আসল ব্যাকারাটে Tie হয় ~৯.৫% সময়ে, ⅓ সময়ে নয়। ফলে —
//
//     RTP(Tie) = (1/3) × 8 = 2.667
//
// লাইভ HTTP রাউন্ডে মাপা হয়েছে: Tie RTP ২.৭২ (৩০০ রাউন্ডে), অর্থাৎ প্রতি
// বাজিতে গড়ে স্টেকের ১.৭ গুণ প্লেয়ারের পক্ষে। Player/Banker-এ RTP ছিল
// ০.৬৭/০.৬৯ — তাই Tie-ই একমাত্র যুক্তিসঙ্গত বাজি হয়ে দাঁড়িয়েছিল।
//
// এই টেস্ট দুই স্তরে কাজ করে:
//   ১) বণ্টন স্তর — হ্যান্ডলার থেকে বড় নমুনা নিয়ে কম্পাঙ্ক ও RTP।
//      ছোট নমুনায় ~১০% এর Tie কম্পাঙ্ক নির্ভরযোগ্যভাবে মাপা যায় না, আর
//      HTTP-তে অত রাউন্ড চালানো রেট-লিমিটেই আটকে যায়।
//   ২) আর্থিক স্তর — আসল HTTP জার্নিতে স্টেক ডেবিট, পেআউট ক্রেডিট, লেজার,
//      ক্লায়েন্ট-ম্যানিপুলেশন ও ভ্যালিডেশন আগের মতোই আছে কি না।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');
const gameRegistry = require('../../services/gameRegistry');

const SLUG = 'baccarat';
const STAKE = 10;
const SELECTIONS = ['Player', 'Banker', 'Tie'];

// services/gameRegistry.js-এ কনফিগার করা পেআউট (মোট ফেরত, স্টেকসহ)।
// এগুলো এই ফিক্সে বদলানো হয়নি — টেস্ট শুধু নিশ্চিত করে যে এগুলোই ব্যবহৃত হচ্ছে।
const PAYOUT = { Player: 1.95, Banker: 1.95, Tie: 8 };

// আসল (৮-ডেক) ব্যাকারাটের কম্পাঙ্ক — যে মডেলের জন্য উপরের পেআউটগুলো দাম করা।
const EXPECTED_P = { Player: 0.4462, Banker: 0.4586, Tie: 0.0952 };

async function makeUser(coins) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').type('form').send({
    username,
    phone: uniquePhone(),
    password: 'SecurePass123',
    confirmPassword: 'SecurePass123',
    _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  const userId = r.rows[0].id;
  await pool.query('UPDATE users SET coins = $1 WHERE id = $2', [coins, userId]);
  const page = await agent.get('/games/baccarat');
  const csrf = (/<meta name="csrf-token" content="([^"]*)"/.exec(page.text) || [])[1];
  return { userId, post: (p, b) => agent.post(p).set('X-CSRF-Token', csrf).send(b) };
}

const coinsOf = async (userId) =>
  Number((await pool.query('SELECT coins FROM users WHERE id = $1', [userId])).rows[0].coins);

// শুধু ব্যাকারাট রাউন্ডের নিজস্ব সারি। ব্যাজ/স্ট্রিক/মিশনের অ্যাসিনক্রোনাস
// ক্রেডিট আলাদা টাইপে যায়, তাই ব্যালেন্স সরাসরি তুলনা না করে টাইপ ধরে দেখা হয়।
async function rounds(userId) {
  const r = await pool.query(
    `SELECT type, SUM(amount)::float AS total, COUNT(*)::int AS n
     FROM coin_transactions WHERE user_id = $1 AND type IN ('casino_bet', 'game_play')
     GROUP BY type`, [userId]);
  const out = { casino_bet: { total: 0, n: 0 }, game_play: { total: 0, n: 0 } };
  r.rows.forEach((row) => { out[row.type] = { total: row.total, n: row.n }; });
  return out;
}

describe('LIVO-02 — ব্যাকারাটের ফলাফল বণ্টন ও RTP', () => {
  const SAMPLES = 200000;
  const counts = { Player: 0, Banker: 0, Tie: 0 };
  const returned = { Player: 0, Banker: 0, Tie: 0 };

  beforeAll(() => {
    const handler = gameRegistry.getHandler(SLUG);
    for (let i = 0; i < SAMPLES; i++) {
      // প্রতিটা ড্র একবারই নেওয়া হয়, তারপর তিনটা বাজির বিপরীতে হিসাব করা হয় —
      // একই নমুনায় তুলনা করলে তিনটা RTP সরাসরি তুলনীয় থাকে।
      const { gameResult } = handler(STAKE, 'Player');
      const outcome = gameResult.outcome;
      counts[outcome] += 1;
      returned[outcome] += STAKE * PAYOUT[outcome];
    }
  });

  test('ফলাফল সবসময় তিনটা বৈধ মানের একটা', () => {
    expect(counts.Player + counts.Banker + counts.Tie).toBe(SAMPLES);
    SELECTIONS.forEach((s) => expect(counts[s]).toBeGreaterThan(0));
  });

  test('কম্পাঙ্ক আসল ব্যাকারাট মডেলের সঙ্গে মেলে (Tie আর ⅓ নয়)', () => {
    SELECTIONS.forEach((s) => {
      const p = counts[s] / SAMPLES;
      // ২ লাখ নমুনায় standard error ~0.001, তাই 0.01 সহনশীলতা যথেষ্ট চওড়া
      expect(p).toBeCloseTo(EXPECTED_P[s], 2);
    });
    // পুরনো implementation-এ এটাই ছিল মূল ত্রুটি: Tie ⅓ সময়ে ঘটত
    expect(counts.Tie / SAMPLES).toBeLessThan(0.15);
  });

  test('কোনো বাজিই প্লেয়ারের পক্ষে নয় — তিনটা selection-এই RTP < ১', () => {
    SELECTIONS.forEach((s) => {
      // RTP = P(এই selection জেতে) × পেআউট গুণিতক
      const measured = (counts[s] / SAMPLES) * PAYOUT[s];
      expect(measured).toBeLessThan(1);
    });
  });

  test('Tie-এর RTP আর ২-এর ওপরে নয়, বরং হাউসের পক্ষে', () => {
    const tieRtp = (counts.Tie * STAKE * PAYOUT.Tie) / (SAMPLES * STAKE);
    // পুরনো: (1/3) × 8 = 2.667 — এই assertion তখন ফেল করত
    expect(tieRtp).toBeLessThan(1);
    // গেমটা অখেলার মতো কঠিন করে ফেলা হয়নি
    expect(tieRtp).toBeGreaterThan(0.6);
  });

  test('পেআউট গুণিতক অপরিবর্তিত (এই ফিক্সে দাম বদলানো হয়নি)', () => {
    const handler = gameRegistry.getHandler(SLUG);
    for (let i = 0; i < 2000; i++) {
      const { winAmount, gameResult } = handler(100, gameResult_seed(i));
      expect(winAmount === 0 || Object.values(PAYOUT).map((m) => 100 * m).includes(winAmount)).toBe(true);
      expect(SELECTIONS).toContain(gameResult.outcome);
    }
    function gameResult_seed(i) { return SELECTIONS[i % 3]; }
  });
});

describe('LIVO-02 — আর্থিক অখণ্ডতা (HTTP স্তর)', () => {
  jest.setTimeout(60000);

  test('স্টেক ঠিক একবার ডেবিট, জয় হলে পেআউট ঠিক একবার ক্রেডিট, লেজার ব্যাখ্যাযোগ্য', async () => {
    const N = 40;
    const { userId, post } = await makeUser(100000);
    const start = await coinsOf(userId);
    let expectedReturn = 0;
    let winRounds = 0;

    for (let i = 0; i < N; i++) {
      const r = await post('/games/play', { gameSlug: SLUG, amount: STAKE, selection: 'Tie' });
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
      expect(SELECTIONS).toContain(r.body.gameResult.outcome);
      // পেআউট সার্ভারের ফলাফল অনুযায়ীই — Tie হলে 8×, নাহলে ০
      const due = r.body.gameResult.outcome === 'Tie' ? STAKE * PAYOUT.Tie : 0;
      expect(Number(r.body.winAmount)).toBe(due);
      expectedReturn += due;
      if (due > 0) winRounds += 1;
    }

    const led = await rounds(userId);
    // প্রতি বাজিতে ঠিক একটা ডেবিট সারি
    expect(led.casino_bet.n).toBe(N);
    expect(led.casino_bet.total).toBe(-N * STAKE);
    // প্রতি জয়ে ঠিক একটা ক্রেডিট সারি — হারলে কোনো সারি নয়
    expect(led.game_play.n).toBe(winRounds);
    expect(led.game_play.total).toBeCloseTo(expectedReturn, 2);

    // ওয়ালেট = শুরু + লেজারের সব সারি (ব্যাজ/স্ট্রিক ক্রেডিটসহ)
    const ledgerSum = Number((await pool.query(
      'SELECT COALESCE(SUM(amount),0)::float s FROM coin_transactions WHERE user_id = $1', [userId])).rows[0].s);
    expect(await coinsOf(userId)).toBeCloseTo(start + ledgerSum, 2);
  });

  test('ক্লায়েন্ট পেআউট/গুণিতক পাঠিয়ে জয় বাড়াতে পারে না', async () => {
    const { post } = await makeUser(100000);
    for (let i = 0; i < 12; i++) {
      const r = await post('/games/play', {
        gameSlug: SLUG, amount: STAKE, selection: 'Tie',
        // সার্ভার এগুলো সম্পূর্ণ উপেক্ষা করে
        winAmount: 999999, multiplier: 500, payout: 999999, gameResult: { outcome: 'Tie' }
      });
      expect(r.status).toBe(200);
      const due = r.body.gameResult.outcome === 'Tie' ? STAKE * PAYOUT.Tie : 0;
      expect(Number(r.body.winAmount)).toBe(due);
    }
  });

  // LIVO-04-এ এই আচরণ ইচ্ছাকৃতভাবে বদলেছে: অচেনা selection আগে নীরবে গ্রহণ করা
  // হতো (২০০, স্টেক কেটে নিশ্চিত পরাজয়), এখন ব্যালেন্স স্পর্শ করার আগেই ৪০০।
  // RTP-সংক্রান্ত আচরণ অপরিবর্তিত — বৈধ selection-এর পেআউট আগের মতোই।
  test('অচেনা selection বাজি হিসেবেই গৃহীত হয় না', async () => {
    const { userId, post } = await makeUser(100000);
    for (const bogus of ['Tie ', 'tie', 'TIE', 'Dragon', '', null, 123, { a: 1 }]) {
      const r = await post('/games/play', { gameSlug: SLUG, amount: STAKE, selection: bogus });
      expect(r.status).toBe(400);
      expect(r.body.success).toBe(false);
    }
    const led = await rounds(userId);
    expect(led.game_play.n).toBe(0); // একটাও জয়ের সারি নেই
    expect(led.casino_bet.n).toBe(0); // একটাও ডেবিটও নেই
  });

  test('স্টেক ভ্যালিডেশন: সর্বনিম্ন, সর্বোচ্চ ও অবৈধ মান', async () => {
    const { userId, post } = await makeUser(100000);
    const before = await coinsOf(userId);

    for (const bad of [0, -5, 9, 50001, 'abc', null]) {
      const r = await post('/games/play', { gameSlug: SLUG, amount: bad, selection: 'Player' });
      expect(r.status).toBe(400);
      expect(r.body.success).toBe(false);
    }
    // একটাও অবৈধ বাজি ব্যালেন্স স্পর্শ করেনি
    expect(await coinsOf(userId)).toBe(before);

    // সর্বনিম্ন বৈধ স্টেক গ্রহণযোগ্য
    const ok = await post('/games/play', { gameSlug: SLUG, amount: 10, selection: 'Player' });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
  });

  test('ভগ্নাংশ পেআউট (1.95×) সঠিকভাবে লেজারে বসে', async () => {
    const { userId, post } = await makeUser(100000);
    let wins = 0;
    for (let i = 0; i < 30; i++) {
      const r = await post('/games/play', { gameSlug: SLUG, amount: 11, selection: 'Banker' });
      expect(r.status).toBe(200);
      if (Number(r.body.winAmount) > 0) {
        // 11 × 1.95 = 21.45 — দুই দশমিক ঠিকঠাক থাকতে হবে
        expect(Number(r.body.winAmount)).toBeCloseTo(21.45, 2);
        wins += 1;
      }
    }
    const led = await rounds(userId);
    expect(led.game_play.n).toBe(wins);
    expect(led.game_play.total).toBeCloseTo(wins * 21.45, 2);
  });
});
