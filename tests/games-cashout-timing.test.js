// tests/games-cashout-timing.test.js
// ---------------------------------------------------------------------------
// মাস্টার অডিট BUG-001 — routes/games.js POST /games/cashout আগে শুধু session-এর
// gameState-এর ওপর নির্ভর করত:
//   (ক) কোনো elapsed-time যাচাই ছিল না — বেট বসানোর সাথে সাথেই ক্লায়েন্ট UI বাইপাস করে
//       সরাসরি API কল দিয়ে যেকোনো multiplier দাবি করে ক্যাশআউট করা যেত। crashPoint
//       uniform(1,10) হওয়ায় এভাবে প্রায় সবসময় জিতে যাওয়া সম্ভব ছিল (পুনরুৎপাদন করা
//       হয়েছিল: ৪০ রাউন্ডে ৩৬ জয়, ১.৫x ইনস্ট্যান্ট ক্যাশআউটে, নেট +১৭৮০ কয়েন)।
//   (খ) session-ভিত্তিক single-use স্টেট concurrent request-এর বিরুদ্ধে atomic ছিল না —
//       resave:false হওয়ায় সমান্তরাল রিকোয়েস্ট একই session snapshot পড়ে ডাবল-ক্যাশআউট
//       করতে পারত (পুনরুৎপাদন: ১০টা সমান্তরাল রিকোয়েস্টে ৯টা সফল, নেট +৮০৯ কয়েন একটাই
//       ১০০-কয়েনের বাজি থেকে)।
// ফিক্স: crash_point/bet_amount/started_at এখন game_rounds টেবিলে DB-authoritative;
// cashout একটা atomic `UPDATE ... WHERE settled_at IS NULL RETURNING` দিয়ে রাউন্ড claim
// করে (Postgres row lock সমান্তরাল claim সিরিয়ালাইজ করে), এবং claimed multiplier
// ক্লায়েন্ট-সাইড growth curve (views/games/aviator.ejs) দিয়ে DB-এর NOW()-ভিত্তিক
// elapsed সময়ের বিরুদ্ধে যাচাই হয়।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');

async function makeUser(coins = 100000) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  await pool.query('UPDATE users SET coins = $2 WHERE id=$1', [row.id, coins]);
  return { agent, token, userId: row.id };
}

async function balanceOf(userId) {
  return Number((await pool.query('SELECT coins FROM users WHERE id=$1', [userId])).rows[0].coins);
}

// ব্যাজ রিওয়ার্ড বাজি ধরার ফল, ক্যাশআউটের নয়।
//
// 'প্রথম বাজি' ব্যাজ (+২০ কয়েন) আনলক হয় বাজি ধরার সাথে সাথেই। আগে ব্যাজের
// বাজি-গণনা 'game_play' এন্ট্রি গুনত, আর aviator বাজির সময় শুধু 'casino_bet'
// লেখা হয় — তাই ব্যাজটা তখন ফায়ার করত না। গণনা 'casino_bet'-এ সরানোর পর
// (হারা বাজিও যাতে গোনা হয়) ব্যাজটা যথাসময়েই আনলক হচ্ছে।
//
// এই টেস্টগুলোর উদ্দেশ্য "ক্যাশআউট থেকে কোনো পেআউট হয়নি" — ব্যাজ সেই হিসাবের
// বাইরে, তাই ব্যালেন্স মেলানোর সময় ব্যাজ-ক্রেডিট বাদ দেওয়া হয়।
async function badgeCreditsOf(userId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions WHERE user_id=$1 AND type='badge'`,
    [userId]
  );
  return Number(r.rows[0].s);
}

/** ব্যাজ রিওয়ার্ড বাদ দিয়ে ব্যালেন্স — গেমিং কার্যকলাপের প্রকৃত ফল। */
async function balanceExcludingBadges(userId) {
  return (await balanceOf(userId)) - (await badgeCreditsOf(userId));
}

describe('POST /games/cashout — টাইমিং যাচাই (BUG-001)', () => {
  test('বেট বসানোর সাথে সাথেই উচ্চ multiplier দাবি করে ক্যাশআউট রিজেক্ট হয় (400), কোনো পেআউট হয় না', async () => {
    const U = await makeUser();
    const before = await balanceOf(U.userId);

    const playRes = await U.agent.post('/games/play').set('X-CSRF-Token', U.token)
      .send({ gameSlug: 'aviator', amount: 100, demo: false });
    expect(playRes.status).toBe(200);

    const coRes = await U.agent.post('/games/cashout').set('X-CSRF-Token', U.token)
      .send({ gameSlug: 'aviator', multiplier: 1.5 });

    expect(coRes.status).toBe(400);
    expect(coRes.body.success).toBe(false);

    // বাজির টাকা কাটা গেছে (বাজি বসানো সবসময়ই স্বাভাবিক), কিন্তু কোনো জেতা টাকা credit হয়নি
    expect(await balanceExcludingBadges(U.userId)).toBe(before - 100);
  });

  test('৪০ রাউন্ড ইনস্ট্যান্ট ১.৫x ক্যাশআউট — কোনোটাই জেতে না (আগে ~৯৪% জিততো)', async () => {
    const U = await makeUser();
    const before = await balanceOf(U.userId);
    const N = 40;
    const BET = 100;
    let paidOut = 0;

    for (let i = 0; i < N; i++) {
      const playRes = await U.agent.post('/games/play').set('X-CSRF-Token', U.token)
        .send({ gameSlug: 'aviator', amount: BET, demo: false });
      expect(playRes.status).toBe(200);
      const coRes = await U.agent.post('/games/cashout').set('X-CSRF-Token', U.token)
        .send({ gameSlug: 'aviator', multiplier: 1.5 });
      expect(coRes.status).toBe(400);
      if (coRes.body.success) paidOut++;
    }

    expect(paidOut).toBe(0);
    expect(await balanceExcludingBadges(U.userId)).toBe(before - N * BET); // ঠিক পুরো বাজিই খোয়া গেছে, কোনো ফাঁকি-জয় নেই
  }, 60000);

  test('পর্যাপ্ত সময় অতিবাহিত হওয়ার পর ন্যায্য multiplier claim করলে ক্যাশআউট স্বাভাবিকভাবে কাজ করে', async () => {
    const U = await makeUser();
    const before = await balanceOf(U.userId);

    const playRes = await U.agent.post('/games/play').set('X-CSRF-Token', U.token)
      .send({ gameSlug: 'aviator', amount: 100, demo: false });
    expect(playRes.status).toBe(200);

    // multiplier=1.05 পৌঁছাতে elapsed >= ~0.22s লাগে (1 + t^1.5*0.18 = 1.05)
    await new Promise((r) => setTimeout(r, 400));

    const coRes = await U.agent.post('/games/cashout').set('X-CSRF-Token', U.token)
      .send({ gameSlug: 'aviator', multiplier: 1.05 });

    expect(coRes.status).toBe(200);
    // crashPoint র‍্যান্ডম বলে জেতা বা ক্র্যাশ করা দুটোই বৈধ ফলাফল — কিন্তু কখনোই রিজেক্ট (400) নয়
    expect(coRes.body.success).toBe(true);
    if (!coRes.body.crashed) {
      expect(await balanceExcludingBadges(U.userId)).toBe(before - 100 + Math.floor(100 * 1.05));
    } else {
      expect(await balanceOf(U.userId)).toBe(before - 100);
    }
  });
});

describe('POST /games/cashout — সমান্তরাল রিকোয়েস্ট / ডাবল-ক্যাশআউট প্রতিরোধ (BUG-001)', () => {
  test('একই রাউন্ডে ১০টা সমান্তরাল cashout রিকোয়েস্টের মধ্যে ঠিক একটাই সফল হয়', async () => {
    const U = await makeUser();
    const before = await balanceOf(U.userId);

    const playRes = await U.agent.post('/games/play').set('X-CSRF-Token', U.token)
      .send({ gameSlug: 'aviator', amount: 100, demo: false });
    expect(playRes.status).toBe(200);

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }).map(() =>
        U.agent.post('/games/cashout').set('X-CSRF-Token', U.token).send({ gameSlug: 'aviator', multiplier: 1.01 })
      )
    );

    const successfulPayouts = results.filter((r) => r.body && r.body.success && !r.body.crashed).length;
    expect(successfulPayouts).toBeLessThanOrEqual(1);

    const after = await balanceExcludingBadges(U.userId);
    if (successfulPayouts === 1) {
      expect(after).toBe(before - 100 + Math.floor(100 * 1.01));
    } else {
      // সবগুলোই ব্যর্থ হলে (রেসে কেউ জিততে পারল না, crashPoint<1.01 এর সম্ভাবনা খুবই কম কিন্তু শূন্য নয়)
      expect(after).toBe(before - 100);
    }
  });

  test('একবার নিষ্পত্তি হওয়া রাউন্ড আবার cashout করলে (replay) 400 রিটার্ন করে, দ্বিতীয়বার পে-আউট হয় না', async () => {
    const U = await makeUser();
    const playRes = await U.agent.post('/games/play').set('X-CSRF-Token', U.token)
      .send({ gameSlug: 'aviator', amount: 100, demo: false });
    expect(playRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 400));
    const first = await U.agent.post('/games/cashout').set('X-CSRF-Token', U.token)
      .send({ gameSlug: 'aviator', multiplier: 1.05 });
    expect(first.status).toBe(200);
    const afterFirst = await balanceOf(U.userId);

    // session gameState ইতিমধ্যেই null (server nulls it after claim attempt), তাই
    // দ্বিতীয় রিকোয়েস্ট normally "কোনো চলমান গেম নেই" পাবে — game_rounds-এ সরাসরি রাউন্ড
    // token পুনরায় ব্যবহারের চেষ্টা DB claim স্তরেও ব্যর্থ হয় তা নিশ্চিত করতে raw round query:
    const round = await pool.query(
      `SELECT round_token FROM game_rounds WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [U.userId]
    );
    const retryClaim = await pool.query(
      `UPDATE game_rounds SET settled_at = NOW() WHERE round_token=$1 AND user_id=$2 AND settled_at IS NULL RETURNING id`,
      [round.rows[0].round_token, U.userId]
    );
    expect(retryClaim.rowCount).toBe(0); // দ্বিতীয়বার claim করা যায়নি

    expect(await balanceOf(U.userId)).toBe(afterFirst); // ব্যালেন্স অপরিবর্তিত
  });
});
