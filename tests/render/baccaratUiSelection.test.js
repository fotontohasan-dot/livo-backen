// tests/render/baccaratUiSelection.test.js
// ---------------------------------------------------------------------------
// LIVO-04 রিগ্রেশন — ব্যাকারাটের UI-তে বাজি নির্বাচন।
//
// views/games/play.ejs-এ শেয়ার্ড হেল্পারটা `placeBet(amount, selection = null)`,
// কিন্তু views/games/baccarat.ejs সেটাকে ডাকত `placeBet(amount)` — একটাই আর্গুমেন্ট।
// ফলে সার্ভারে সবসময় `selection: null` যেত, `outcome === selection` কখনো সত্য হতো না,
// এবং UI দিয়ে খেলা ব্যাকারাটের RTP ছিল ঠিক ০.০০০০ (৪০ রাউন্ডে ০ জয় — মাপা হয়েছে)।
// রেন্ডার করা পেজে Player/Banker/Tie বাছার কোনো কন্ট্রোলই ছিল না।
//
// এই টেস্ট প্রমাণ করে — UI-তে তিনটা বাজি বাছা যায়, প্রতিটা সার্ভার পর্যন্ত পৌঁছায়,
// সার্ভারই ফলাফল ও পেআউট ঠিক করে, অবৈধ selection টাকা স্পর্শ করার আগেই আটকে যায়,
// এবং প্রতি রিকোয়েস্টে ঠিক একটা বাজি ও সর্বোচ্চ একটা পেআউট লেজারে বসে।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');

const SLUG = 'baccarat';
const STAKE = 10;
const VALID = ['Player', 'Banker', 'Tie'];

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
  return {
    userId,
    html: page.text,
    post: (p, b) => agent.post(p).set('X-CSRF-Token', csrf).send(b)
  };
}

const coinsOf = async (userId) =>
  Number((await pool.query('SELECT coins FROM users WHERE id = $1', [userId])).rows[0].coins);

// শুধু এই রাউন্ডগুলোর নিজস্ব সারি। ব্যাজ/মিশন/স্ট্রিকের অ্যাসিনক্রোনাস ক্রেডিট
// আলাদা টাইপে যায়, তাই কাঁচা ব্যালেন্স তুলনা করলে টেস্ট ফ্লেকি হতো।
async function ledgerRows(userId) {
  const r = await pool.query(
    `SELECT type, COUNT(*)::int AS n, SUM(amount)::float AS total
     FROM coin_transactions WHERE user_id = $1 AND type IN ('casino_bet', 'game_play')
     GROUP BY type`, [userId]);
  const out = { casino_bet: { n: 0, total: 0 }, game_play: { n: 0, total: 0 } };
  r.rows.forEach((row) => { out[row.type] = { n: row.n, total: row.total }; });
  return out;
}

describe('LIVO-04 — ব্যাকারাট UI-তে বাজি নির্বাচন (রেন্ডার)', () => {
  let html;
  beforeAll(async () => { html = (await makeUser(1000)).html; });

  test('তিনটা বাজির কন্ট্রোলই পেজে আছে এবং সঠিক মান পাঠায়', () => {
    VALID.forEach((sel) => {
      // সার্ভার ঠিক এই বানানই আশা করে — data-selection মানটাই request-এ যায়
      expect(html).toContain(`data-selection="${sel}"`);
    });
  });

  test('selection ছাড়া placeBet() আর ডাকা হয় না', () => {
    const script = html.slice(html.indexOf('baccaratGame'));
    // পুরনো ত্রুটি: placeBet(amount) — একটাই আর্গুমেন্ট
    expect(script).not.toMatch(/placeBet\(\s*amount\s*\)/);
    // এখন selection সবসময় সঙ্গে যায়
    expect(script).toMatch(/placeBet\(\s*amount\s*,\s*\w+/);
  });

  test('কন্ট্রোলগুলো কিবোর্ড-অ্যাক্সেসিবল ও সিমান্টিক', () => {
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked');
    // বাটন হিসেবে রেন্ডার হলে টাইপ থাকতেই হবে, নাহলে ফর্ম সাবমিট করে বসতে পারে
    expect(html).toMatch(/<button[^>]+type="button"[^>]+data-selection=/);
  });

  test('ফলাফল ও লোডিং স্টেট দেখানোর জায়গা আছে', () => {
    expect(html).toContain('id="bcStatus"');
    expect(html).toContain('id="bcResult"');
  });
});

describe('LIVO-04 — প্রতিটা selection সার্ভার পর্যন্ত পৌঁছায়', () => {
  jest.setTimeout(60000);

  test('Player / Banker / Tie — সার্ভার নিজের ফলাফল অনুযায়ী পেআউট দেয়', async () => {
    for (const sel of VALID) {
      const { userId, post } = await makeUser(100000);
      const N = 25;
      let expectedReturn = 0;
      let winRounds = 0;

      for (let i = 0; i < N; i++) {
        const r = await post('/games/play', { gameSlug: SLUG, amount: STAKE, selection: sel });
        expect(r.status).toBe(200);
        expect(r.body.success).toBe(true);
        expect(VALID).toContain(r.body.gameResult.outcome);

        // জয়/পরাজয় সার্ভারের outcome আর ইউজারের selection মিলিয়ে ঠিক হয়
        const won = r.body.gameResult.outcome === sel;
        const due = won ? STAKE * (sel === 'Tie' ? 8 : 1.95) : 0;
        expect(Number(r.body.winAmount)).toBeCloseTo(due, 2);
        expectedReturn += due;
        if (due > 0) winRounds += 1;
      }

      const led = await ledgerRows(userId);
      // প্রতি রিকোয়েস্টে ঠিক একটা ডেবিট
      expect(led.casino_bet.n).toBe(N);
      expect(led.casino_bet.total).toBeCloseTo(-N * STAKE, 2);
      // প্রতি জয়ে সর্বোচ্চ একটা ক্রেডিট, হারলে কোনোটাই নয়
      expect(led.game_play.n).toBe(winRounds);
      expect(led.game_play.total).toBeCloseTo(expectedReturn, 2);
    }
  });

  test('একটা রিকোয়েস্ট = ঠিক একটা বাজি (কোনো ডাবল ডেবিট/পেআউট নয়)', async () => {
    const { userId, post } = await makeUser(100000);
    const r = await post('/games/play', { gameSlug: SLUG, amount: STAKE, selection: 'Player' });
    expect(r.status).toBe(200);

    const led = await ledgerRows(userId);
    expect(led.casino_bet.n).toBe(1);
    expect(led.game_play.n).toBeLessThanOrEqual(1);

    // ওয়ালেট = শুরু + লেজারের সব সারি (অ্যাসিনক্রোনাস ক্রেডিটসহ)
    const ledgerSum = Number((await pool.query(
      'SELECT COALESCE(SUM(amount),0)::float s FROM coin_transactions WHERE user_id = $1',
      [userId])).rows[0].s);
    expect(await coinsOf(userId)).toBeCloseTo(100000 + ledgerSum, 2);
  });
});

describe('LIVO-04 — সার্ভার-সাইড ভ্যালিডেশন ও নিরাপত্তা', () => {
  jest.setTimeout(60000);

  test('অবৈধ selection ৪০০ দেয় এবং টাকা স্পর্শ করে না', async () => {
    const { userId, post } = await makeUser(100000);
    const before = await coinsOf(userId);

    // কেস-সংবেদনশীল: সার্ভার ঠিক 'Player'/'Banker'/'Tie'-ই গ্রহণ করে
    const bogus = ['player', 'PLAYER', 'BANKER', 'tie', 'Tie ', ' Player', 'Dragon', '', null, undefined, 123, {}, []];
    for (const b of bogus) {
      const r = await post('/games/play', { gameSlug: SLUG, amount: STAKE, selection: b });
      expect(r.status).toBe(400);
      expect(r.body.success).toBe(false);
      expect(typeof r.body.message).toBe('string');
      // স্ট্যাক ট্রেস বা ভেতরের তথ্য ফাঁস হয় না
      expect(r.body.message).not.toMatch(/at |Error:|\.js:/);
    }

    // একটাও অবৈধ রিকোয়েস্ট ব্যালেন্স বা লেজার নাড়েনি
    expect(await coinsOf(userId)).toBe(before);
    const led = await ledgerRows(userId);
    expect(led.casino_bet.n).toBe(0);
    expect(led.game_play.n).toBe(0);
  });

  test('ক্লায়েন্টের পাঠানো আর্থিক মান সম্পূর্ণ উপেক্ষিত', async () => {
    const { post } = await makeUser(100000);
    for (let i = 0; i < 10; i++) {
      const r = await post('/games/play', {
        gameSlug: SLUG, amount: STAKE, selection: 'Tie',
        winAmount: 999999, payout: 999999, multiplier: 500,
        gameResult: { outcome: 'Tie' }, crashPoint: 99
      });
      expect(r.status).toBe(200);
      const due = r.body.gameResult.outcome === 'Tie' ? STAKE * 8 : 0;
      expect(Number(r.body.winAmount)).toBe(due);
    }
  });

  test('body-তে userId পাঠিয়ে অন্য ইউজারের ওয়ালেট ছোঁয়া যায় না', async () => {
    const victim = await makeUser(100000);
    const attacker = await makeUser(100000);
    const victimBefore = await coinsOf(victim.userId);

    const r = await attacker.post('/games/play', {
      gameSlug: SLUG, amount: STAKE, selection: 'Player',
      userId: victim.userId, user_id: victim.userId
    });
    expect(r.status).toBe(200);

    // ভিক্টিমের ব্যালেন্স ও লেজার অস্পর্শিত
    expect(await coinsOf(victim.userId)).toBe(victimBefore);
    expect((await ledgerRows(victim.userId)).casino_bet.n).toBe(0);
    // বাজিটা আক্রমণকারীর নিজের অ্যাকাউন্টেই বসেছে
    expect((await ledgerRows(attacker.userId)).casino_bet.n).toBe(1);
  });

  test('লগইন ছাড়া বাজি ধরা যায় না', async () => {
    const request = require('supertest');
    const { app } = require('../helpers/app');
    const r = await request(app).post('/games/play')
      .set('X-Forwarded-For', '10.9.9.9')
      .send({ gameSlug: SLUG, amount: STAKE, selection: 'Player' });
    // isAuth লগআউট অবস্থায় /login-এ পাঠায়
    expect([302, 401, 403]).toContain(r.status);
  });

  test('CSRF টোকেন ছাড়া বাজি ধরা যায় না', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    await agent.post('/register').type('form').send({
      username: uniqueUsername(), phone: uniquePhone(),
      password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
    });
    const r = await agent.post('/games/play').send({ gameSlug: SLUG, amount: STAKE, selection: 'Player' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('CSRF_TOKEN_INVALID');
  });

  test('স্টেক ভ্যালিডেশন: সর্বনিম্ন, সর্বোচ্চ ও অবৈধ মান', async () => {
    const { userId, post } = await makeUser(100000);
    const before = await coinsOf(userId);

    for (const bad of [0, -5, 9, 50001, 'abc', null]) {
      const r = await post('/games/play', { gameSlug: SLUG, amount: bad, selection: 'Player' });
      expect(r.status).toBe(400);
      expect(r.body.success).toBe(false);
    }
    expect(await coinsOf(userId)).toBe(before);
    expect((await ledgerRows(userId)).casino_bet.n).toBe(0);

    const min = await post('/games/play', { gameSlug: SLUG, amount: 10, selection: 'Player' });
    expect(min.status).toBe(200);
    const max = await post('/games/play', { gameSlug: SLUG, amount: 50000, selection: 'Player' });
    expect(max.status).toBe(200);
  });
});
