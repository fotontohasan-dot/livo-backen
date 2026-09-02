// tests/security/crashHouseEdge.test.js
// ---------------------------------------------------------------------------
// LIVO-01 রিগ্রেশন — ক্র্যাশ গেমের বণ্টনে হাউস এজ।
//
// আগে crash point ছিল uniform [1, 10) (`1 + randomFloat() * 9`)। uniform
// বণ্টনে কোনো হাউস এজ নেই: m গুণিতকে ক্যাশআউট করলে P(win) = (10 − m)/9,
// অর্থাৎ RTP = m(10 − m)/9। এটা m ≈ ১.১৫ – ৮.৮ রেঞ্জে সবসময় ১-এর বেশি,
// ৫x-এ প্রায় ২.৭৮। লাইভ রাউন্ডে মাপা হয়েছিল ৫x-এ RTP ২.৭৩ — অর্থাৎ প্রতি
// রাউন্ডে স্টেকের ~১.৭ গুণ প্লেয়ারের পক্ষে।
//
// এই টেস্ট দুই স্তরে কাজ করে:
//
//   ১) বণ্টন স্তর — জেনারেটর থেকে সরাসরি বড় নমুনা নিয়ে RTP ইনভেরিয়েন্ট।
//      লাইভ HTTP রাউন্ড দিয়ে এটা যাচাই করা যায় না: ১% এজ ধরতে যত রাউন্ড
//      দরকার তা HTTP-তে অবাস্তব, আর কম নমুনায় পরিমাপের নয়েজই ১%-এর চেয়ে বড়।
//
//   ২) রাউন্ড স্তর — আসল HTTP জার্নি দিয়ে স্টেক, পেআউট, ওয়ালেট, লেজার,
//      settled_at, ডুপ্লিকেট ও অসময়ের ক্যাশআউট — সব আগের মতোই আছে কি না।
//      LIVO-01-এর ফিক্স যেন এই কোনোটাই না ভাঙে।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');
const gamesRouter = require('../../routes/games');

const SLUG = 'crash-game';
const STAKE = 10;

// ক্যাশআউট গুণিতক যত সেকেন্ড পরে বৈধ হয় — routes/games.js-এর
// maxReachableMultiplier() = 1 + elapsed^1.5 * 0.18 এর বিপরীত।
function secondsToReach(multiplier) {
  return Math.pow((multiplier - 1) / 0.18, 2 / 3);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const page = await agent.get('/games/crash-game');
  const csrf = (/<meta name="csrf-token" content="([^"]*)"/.exec(page.text) || [])[1];
  const post = (path, body) => agent.post(path).set('X-CSRF-Token', csrf).send(body);
  return { userId, post };
}

const coinsOf = async (userId) =>
  Number((await pool.query('SELECT coins FROM users WHERE id = $1', [userId])).rows[0].coins);

// এই ইউজারের ক্র্যাশ-জয়ের লেজার সারির সংখ্যা। ব্যালেন্স সরাসরি তুলনা করার চেয়ে
// এটা নির্ভরযোগ্য — /games/play-এর পরে ব্যাজ, মিশন, লয়্যালটি ইত্যাদি অ্যাসিনক্রোনাস
// ক্রেডিট বসতে পারে যা এই রাউন্ডের সাথে সম্পর্কিত নয়।
const winRowCount = async (userId) =>
  Number((await pool.query(
    "SELECT COUNT(*)::int AS c FROM coin_transactions WHERE user_id = $1 AND type = 'game_win'",
    [userId])).rows[0].c);

const latestRound = async (userId) =>
  (await pool.query('SELECT * FROM game_rounds WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId])).rows[0];

// রাউন্ডের নিজস্ব লেজার সারিগুলো — ব্যাজ/মিশন/ক্যাশব্যাকের মতো অ্যাসিনক্রোনাস
// ক্রেডিট আলাদা টাইপে যায়, তাই সেগুলো এই যোগফলে ঢোকে না।
async function roundLedger(userId) {
  const r = await pool.query(
    `SELECT type, SUM(amount)::float AS total FROM coin_transactions
     WHERE user_id = $1 AND type IN ('casino_bet', 'game_win') GROUP BY type`,
    [userId]
  );
  const out = {};
  r.rows.forEach((row) => { out[row.type] = row.total; });
  return out;
}

describe('LIVO-01 — ক্র্যাশ গেমের হাউস এজ (বণ্টন স্তর)', () => {
  const SAMPLES = 200000;
  let points;

  beforeAll(() => {
    points = new Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) points[i] = gamesRouter.generateCrashPoint();
  });

  test('জেনারেটর এক্সপোর্ট করা এবং সবসময় বৈধ crash point দেয়', () => {
    expect(typeof gamesRouter.generateCrashPoint).toBe('function');
    const min = Math.min(...points.slice(0, 50000));
    expect(min).toBeGreaterThanOrEqual(1);
    // NUMERIC(6,2) কলামে ধরতে হবে — ক্যাপ ছাড়া INSERT overflow করত
    expect(Math.max(...points.slice(0, 50000))).toBeLessThanOrEqual(1000);
    points.slice(0, 1000).forEach((p) => {
      // ঠিক ২ দশমিক। `p * 100` দিয়ে তুলনা করা যায় না — 2.47 * 100 জাভাস্ক্রিপ্টে
      // 247.00000000000003 দেয়, যা ভাসমান-বিন্দুর কারণ, মানের নয়।
      expect(Number(p.toFixed(2))).toBe(p);
    });
  });

  test('কোনো ক্যাশআউট-কৌশলই প্লেয়ারের পক্ষে নয় (RTP ≤ ১ সর্বত্র)', () => {
    // বণ্টনের প্রতিজ্ঞা: P(crash ≥ m) = (1 − edge)/m, তাই RTP = 1 − edge = 0.99।
    //
    // এটা সরাসরি "মাপা RTP < 1" দিয়ে যাচাই করা যায় না। বড় m-এ RTP-র মন্টে-কার্লো
    // অনুমানের ভেদাঙ্ক দ্রুত বাড়ে: sd(RTP̂) = m·√(p(1−p)/N)। m = 50, N = ২ লাখে
    // সেটা ≈ 0.0156, অর্থাৎ প্রকৃত ০.৯৯ থেকে ১.০ মাত্র ~০.৬ sd দূরে — ওই assertion
    // নমুনার খেয়ালেই ~২৫% রানে ফেল করত (একবার ধরাও পড়েছে)। ফ্লেকি টেস্ট কোনো
    // সুরক্ষা দেয় না, তাই এখানে প্রকৃত মডেলটাই যাচাই করা হয়:
    //   প্রতিটা m-এ মাপা P(crash ≥ m) তাত্ত্বিক (1 − edge)/m-এর ৫ sd-এর মধ্যে আছে কি না।
    // মডেল মিললে RTP বীজগণিতিকভাবেই 1 − edge, অর্থাৎ ১-এর নিচে।
    const EDGE = 0.01;
    const targets = [1.1, 1.5, 2, 3, 4, 5, 6, 7, 10, 20, 50];

    targets.forEach((m) => {
      const expectedP = (1 - EDGE) / m;
      const observedP = points.reduce((n, c) => n + (m <= c ? 1 : 0), 0) / SAMPLES;
      const sd = Math.sqrt((expectedP * (1 - expectedP)) / SAMPLES);
      // পুরনো uniform [1,10) বণ্টনে বিচ্যুতি ছিল ০.১ – ০.৩৬ — অর্থাৎ শত শত sd,
      // প্রতিটা m-এই ফেল করত।
      expect(Math.abs(observedP - expectedP)).toBeLessThan(5 * sd);
    });

    // ছোট m-এ ভেদাঙ্ক যথেষ্ট কম, তাই সেখানে সরাসরি RTP < 1 দাবি করা নিরাপদ
    // (১.৫x-এ ১.০ প্রকৃত মান থেকে ৬ sd-এর বেশি দূরে)।
    [1.1, 1.5, 2].forEach((m) => {
      const rtp = m * (points.reduce((n, c) => n + (m <= c ? 1 : 0), 0) / SAMPLES);
      expect(rtp).toBeLessThan(1);
      expect(rtp).toBeGreaterThan(0.95);
    });
  });

  test('বণ্টনটা কোনো গুণিতককে বিশেষ সুবিধা দেয় না (RTP সমতল)', () => {
    const rtps = [1.5, 2, 3, 5, 8].map((m) => {
      const wins = points.reduce((n, c) => n + (m <= c ? 1 : 0), 0);
      return m * (wins / SAMPLES);
    });
    // পুরনো বণ্টনে ৫x-এর RTP ১.৫x-এর প্রায় দ্বিগুণ ছিল — সেটাই শোষণযোগ্য
    // "সেরা কৌশল" তৈরি করত। এখন সব গুণিতকে কার্যত এক।
    expect(Math.max(...rtps) - Math.min(...rtps)).toBeLessThan(0.03);
  });
});

describe('LIVO-01 — রাউন্ড ও লেজার অখণ্ডতা অপরিবর্তিত (HTTP স্তর)', () => {
  jest.setTimeout(60000);

  test('বৈধ রাউন্ড: স্টেক ডেবিট, পেআউট, ওয়ালেট, লেজার, একবারই settle', async () => {
    const { userId, post } = await makeUser(100000);
    const startCoins = await coinsOf(userId);

    const play = await post('/games/play', { gameSlug: SLUG, amount: STAKE });
    expect(play.status).toBe(200);
    expect(play.body.success).toBe(true);

    // ১) রাউন্ড সার্ভারে রেকর্ড হয়েছে, ক্র্যাশ পয়েন্ট সার্ভার-নির্ধারিত
    const round = await latestRound(userId);
    expect(round).toBeTruthy();
    expect(round.game_slug).toBe(SLUG);
    expect(Number(round.crash_point)).toBeGreaterThanOrEqual(1);
    expect(round.settled_at).toBeNull();

    // ২) স্টেক ঠিক একবার ডেবিট হয়েছে।
    // ব্যালেন্স সরাসরি বিয়োগ করে দেখা যায় না — /games/play শেষে checkBadges,
    // recordGameResult, addPoints ইত্যাদি অ্যাসিনক্রোনাসভাবে চলে এবং সেগুলোর
    // কোনোটা কয়েন ক্রেডিট করতে পারে, যা এই দুই রিডের মাঝখানেই বসে যেতে পারে
    // (বাস্তবে ধরা পড়েছে: +২০ ব্যাজ ক্রেডিট)। ডেবিট সারিটাই একমাত্র নির্ভরযোগ্য প্রমাণ।
    const betRows = await pool.query(
      "SELECT amount::float AS amount FROM coin_transactions WHERE user_id = $1 AND type = 'casino_bet'",
      [userId]
    );
    expect(betRows.rows).toHaveLength(1);
    expect(betRows.rows[0].amount).toBe(-STAKE);

    const crashPoint = Number(round.crash_point);
    const target = 1.5;
    await sleep(Math.ceil(secondsToReach(target) * 1000) + 400);

    const co = await post('/games/cashout', { gameSlug: SLUG, multiplier: target });
    expect(co.status).toBe(200);
    expect(co.body.success).toBe(true);

    // ৩) পেআউট সার্ভারের crash_point অনুযায়ীই ঠিক হয়, ক্লায়েন্টের দাবি অনুযায়ী নয়
    if (target <= crashPoint) {
      expect(co.body.crashed).toBe(false);
      expect(co.body.winAmount).toBe(Math.floor(STAKE * target));
    } else {
      expect(co.body.crashed).toBe(true);
      expect(co.body.winAmount).toBe(0);
    }

    // ৪+৫) লেজার এই রাউন্ডের ব্যালেন্স-পরিবর্তনটাই ব্যাখ্যা করে
    const ledger = await roundLedger(userId);
    expect(ledger.casino_bet).toBe(-STAKE);
    if (co.body.winAmount > 0) expect(ledger.game_win).toBe(co.body.winAmount);

    // ৬) রাউন্ড ঠিক একবারই settle হয়েছে
    const settled = (await pool.query('SELECT settled_at FROM game_rounds WHERE id = $1', [round.id])).rows[0];
    expect(settled.settled_at).not.toBeNull();

    // ওয়ালেট = শুরু + লেজারের সব সারি। অ্যাসিনক্রোনাস ব্যাজ/স্ট্রিক ক্রেডিটও
    // লেজারে লেখা হয়, তাই এই রূপটা ফ্লেকি নয় এবং সরাসরি বিয়োগের চেয়ে কড়া।
    const ledgerSum = Number((await pool.query(
      'SELECT COALESCE(SUM(amount),0)::float s FROM coin_transactions WHERE user_id = $1', [userId])).rows[0].s);
    expect(await coinsOf(userId)).toBeCloseTo(startCoins + ledgerSum, 2);
  });

  test('৭) একই রাউন্ড দ্বিতীয়বার ক্যাশআউট করা যায় না', async () => {
    const { userId, post } = await makeUser(100000);
    await post('/games/play', { gameSlug: SLUG, amount: STAKE });
    await sleep(Math.ceil(secondsToReach(1.5) * 1000) + 400);

    const first = await post('/games/cashout', { gameSlug: SLUG, multiplier: 1.5 });
    const winsAfterFirst = await winRowCount(userId);

    const dup = await post('/games/cashout', { gameSlug: SLUG, multiplier: 1.5 });
    expect(dup.status).toBe(400);
    expect(dup.body.success).toBe(false);
    // ব্যালেন্স সরাসরি মেলানো হয় না — ব্যাজ/মিশনের মতো অ্যাসিনক্রোনাস ক্রেডিট
    // এর মধ্যেই বসতে পারে (সেগুলো আলাদা লেজার টাইপ, এই রাউন্ডের অংশ নয়)।
    // দ্বিতীয় ক্যাশআউট থেকে নতুন কোনো game_win সারি তৈরি হয়েছে কি না — সেটাই আসল প্রশ্ন।
    expect(await winRowCount(userId)).toBe(winsAfterFirst);
    expect(winsAfterFirst).toBe(first.body.winAmount > 0 ? 1 : 0);
  });

  test('৮) অসময়ের (না-পৌঁছানো) গুণিতকে ক্যাশআউট কোনো পেআউট তৈরি করে না', async () => {
    const { userId, post } = await makeUser(100000);
    await post('/games/play', { gameSlug: SLUG, amount: STAKE });

    // অপেক্ষা না করেই সর্বোচ্চ গুণিতক দাবি
    const prem = await post('/games/cashout', { gameSlug: SLUG, multiplier: 9.0 });
    expect(prem.status).toBe(400);
    expect(prem.body.success).toBe(false);
    // কোনো জয়ের লেজার সারিই তৈরি হয়নি — অর্থাৎ কোনো পেআউট হয়নি
    expect(await winRowCount(userId)).toBe(0);
  });

  test('৯) aviator একই রাউন্ড/ক্যাশআউট পথেই চলে (আচরণ অপরিবর্তিত)', async () => {
    const { userId, post } = await makeUser(100000);
    const play = await post('/games/play', { gameSlug: 'aviator', amount: STAKE });
    expect(play.status).toBe(200);

    const round = await latestRound(userId);
    expect(round.game_slug).toBe('aviator');
    expect(Number(round.crash_point)).toBeGreaterThanOrEqual(1);
    expect(round.settled_at).toBeNull();

    await sleep(Math.ceil(secondsToReach(1.5) * 1000) + 400);
    const co = await post('/games/cashout', { gameSlug: 'aviator', multiplier: 1.5 });
    expect(co.status).toBe(200);
    expect(co.body.success).toBe(true);
  });
});
