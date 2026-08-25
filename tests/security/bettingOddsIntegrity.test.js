// tests/security/bettingOddsIntegrity.test.js
// ---------------------------------------------------------------------------
// রিগ্রেশন গার্ড — অডিট P0-01 / P0-02 / P1-05।
//
// আগের আচরণ (পুনরুৎপাদন করা হয়েছিল): POST /matches/:id/bet ক্লায়েন্টের পাঠানো `odd`
// ফিল্ডটা হুবহু bets.odd-এ লিখে দিত, আর সেটেলমেন্ট payout = stake × bets.odd হিসাব
// করত। ফলে ১০ কয়েনের বাজিতে odd=9999999 পাঠিয়ে ১০ কোটি কয়েন তোলা যেত।
// অ্যাকুমুলেটরেও একই সমস্যা ছিল, শুধু runner কি-টা markets.odds-এ না থাকলে।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const { resolveOdd } = require('../../services/marketOdds');
const { placeAccumulator } = require('../../services/accumulator');

jest.setTimeout(60000);

const PASSWORD = 'Passw0rd!23';

async function makeUser(coins = 100000) {
  const u = uniqueUsername('odds');
  const email = `${u}@example.com`;
  // referral_code UNIQUE এবং কলামটা ছোট — username-এর প্রথম ৮ অক্ষর ব্যবহার করলে
  // একই প্রিফিক্সের (এই ফাইলের সব ইউজারই 'odds...') কোডগুলো সংঘর্ষে পড়ে। প্রোডাকশন
  // কোড এই সমস্যাটা insertWithUniqueReferralCode()-এর রিট্রাই দিয়ে সামলায়; টেস্ট
  // হেল্পার সেটা বাইপাস করে, তাই এখানে সরাসরি র‍্যান্ডম কোড ব্যবহার করা হচ্ছে।
  const referral = crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 12);
  const r = await pool.query(
    `INSERT INTO users (username, email, phone, password, role, coins, referral_code, email_verified)
     VALUES ($1,$2,$3,$4,'user',$5,$6,true) RETURNING id`,
    [u, email, uniquePhone(), await bcrypt.hash(PASSWORD, 10), coins, referral]
  );
  return { id: r.rows[0].id, username: u, email };
}

async function loginAs(email) {
  const { agent, token } = await getCsrfAgent('/login');
  await agent.post('/login').type('form').send({ identifier: email, password: PASSWORD, _csrf: token });
  const home = await agent.get('/');
  const m = /<meta name="csrf-token" content="([^"]*)"/.exec(home.text);
  return { agent, csrf: m ? m[1] : token };
}

async function makeMarket(odds = { A: '1.50', B: '2.50' }) {
  const match = await pool.query(
    `INSERT INTO matches (title, team_a, team_b, sport, status)
     VALUES ('Odds Regression','A','B','cricket','Upcoming') RETURNING id`
  );
  const market = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, status)
     VALUES ($1,'match_winner','Winner',$2,'open') RETURNING id`,
    [match.rows[0].id, JSON.stringify(odds)]
  );
  return { matchId: match.rows[0].id, marketId: market.rows[0].id };
}

async function latestBet(userId) {
  const r = await pool.query('SELECT * FROM bets WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [userId]);
  return r.rows[0] || null;
}

describe('services/marketOdds — authoritative odds resolver', () => {
  const market = { match_id: 1, name: 'W', odds: { A: '1.50', B: '2.50' } };

  test('বৈধ runner-এ DB-র অডস ফেরত দেয়', () => {
    expect(resolveOdd(market, 'A')).toEqual({ ok: true, odd: 1.5, runner: 'A' });
  });

  test('অজানা runner reject হয় (fail-closed)', () => {
    expect(resolveOdd(market, 'ZZZ').ok).toBe(false);
    expect(resolveOdd(market, 'ZZZ').reason).toBe('unknown_runner');
  });

  test('prototype-chain কী দিয়ে অডস বের করা যায় না', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(resolveOdd(market, key).ok).toBe(false);
    }
  });

  test('খালি odds map-এ কোনো বাজিই গ্রহণযোগ্য নয়', () => {
    expect(resolveOdd({ odds: {} }, 'A').reason).toBe('no_odds');
    expect(resolveOdd({ odds: null }, 'A').reason).toBe('no_odds');
  });

  test('অবাস্তব বড় বা ≤1 অডস reject হয়', () => {
    expect(resolveOdd({ odds: { A: '9999999' } }, 'A').reason).toBe('invalid_odd');
    expect(resolveOdd({ odds: { A: '1.00' } }, 'A').reason).toBe('invalid_odd');
    expect(resolveOdd({ odds: { A: 'abc' } }, 'A').reason).toBe('invalid_odd');
  });

  test('runner অবশ্যই non-empty স্ট্রিং হতে হবে', () => {
    for (const bad of [null, undefined, 42, {}, [], '', '   ']) {
      expect(resolveOdd(market, bad).ok).toBe(false);
    }
  });
});

describe('POST /matches/:id/bet — ক্লায়েন্টের odd কখনো বিশ্বাস করা হয় না (P0-01)', () => {
  test('অতিরঞ্জিত client odd উপেক্ষিত — stored odd = market odds', async () => {
    const user = await makeUser();
    const { agent, csrf } = await loginAs(user.email);
    const { matchId, marketId } = await makeMarket({ A: '1.50', B: '2.50' });

    const res = await agent.post(`/matches/${matchId}/bet`).type('form')
      .send({ market_id: marketId, runner: 'A', odd: '9999999', stake: '10', _csrf: csrf });

    expect(res.status).toBe(200);
    const bet = await latestBet(user.id);
    expect(Number(bet.odd)).toBe(1.5);          // DB-র মান, ক্লায়েন্টের নয়
    expect(Number(bet.odd)).not.toBe(9999999);
  });

  test('client odd মার্কেট থেকে ভিন্ন হলেও stored odd মার্কেটেরই থাকে', async () => {
    const user = await makeUser();
    const { agent, csrf } = await loginAs(user.email);
    const { matchId, marketId } = await makeMarket({ A: '3.25' });

    await agent.post(`/matches/${matchId}/bet`).type('form')
      .send({ market_id: marketId, runner: 'A', odd: '1.01', stake: '10', _csrf: csrf });

    const bet = await latestBet(user.id);
    expect(Number(bet.odd)).toBe(3.25);
  });

  test('odd ফিল্ড একেবারে না পাঠালেও বাজি স্বাভাবিকভাবে কাজ করে', async () => {
    const user = await makeUser();
    const { agent, csrf } = await loginAs(user.email);
    const { matchId, marketId } = await makeMarket({ A: '2.00' });

    const res = await agent.post(`/matches/${matchId}/bet`).type('form')
      .send({ market_id: marketId, runner: 'A', stake: '10', _csrf: csrf });

    expect(res.body.success).toBe(true);
    expect(Number((await latestBet(user.id)).odd)).toBe(2);
  });

  test('অজানা runner reject — কোনো বাজি তৈরি হয় না, ব্যালেন্স অপরিবর্তিত', async () => {
    const user = await makeUser();
    const { agent, csrf } = await loginAs(user.email);
    const { matchId, marketId } = await makeMarket({ A: '1.50' });
    const before = (await pool.query('SELECT coins FROM users WHERE id=$1', [user.id])).rows[0].coins;

    const res = await agent.post(`/matches/${matchId}/bet`).type('form')
      .send({ market_id: marketId, runner: 'GHOST', odd: '500', stake: '10', _csrf: csrf });

    expect(res.status).toBe(400);
    expect(await latestBet(user.id)).toBeNull();
    const after = (await pool.query('SELECT coins FROM users WHERE id=$1', [user.id])).rows[0].coins;
    expect(Number(after)).toBe(Number(before));
  });

  test('runner অনুপস্থিত থাকলে reject', async () => {
    const user = await makeUser();
    const { agent, csrf } = await loginAs(user.email);
    const { matchId, marketId } = await makeMarket({ A: '1.50' });

    const res = await agent.post(`/matches/${matchId}/bet`).type('form')
      .send({ market_id: marketId, odd: '500', stake: '10', _csrf: csrf });

    expect(res.status).toBe(400);
    expect(await latestBet(user.id)).toBeNull();
  });

  test('অন্য ম্যাচের market_id দিয়ে বাজি ধরা যায় না', async () => {
    const user = await makeUser();
    const { agent, csrf } = await loginAs(user.email);
    const a = await makeMarket({ A: '1.50' });
    const b = await makeMarket({ A: '1.50' });

    const res = await agent.post(`/matches/${a.matchId}/bet`).type('form')
      .send({ market_id: b.marketId, runner: 'A', stake: '10', _csrf: csrf });

    expect(res.status).toBe(400);
    expect(await latestBet(user.id)).toBeNull();
  });

  test('সেটেলমেন্ট পেআউট মার্কেট অডস থেকেই আসে (stake × market odd)', async () => {
    const user = await makeUser();
    const { agent, csrf } = await loginAs(user.email);
    const { matchId, marketId } = await makeMarket({ A: '2.00' });

    await agent.post(`/matches/${matchId}/bet`).type('form')
      .send({ market_id: marketId, runner: 'A', odd: '9999999', stake: '100', _csrf: csrf });

    const bet = await latestBet(user.id);
    // routes/admin.js-এর সেটেলমেন্ট ঠিক এই সূত্রটাই ব্যবহার করে:
    //   payout = Math.floor(Number(bet.stake) * Number(bet.odd))
    // তাই bets.odd authoritative হলে পেআউটও authoritative। ব্যালেন্স-ডেল্টা দিয়ে
    // যাচাই করা হয় না, কারণ বাজি ধরার পর cashback/loyalty/referral fire-and-forget
    // হিসেবে চলে এবং অনির্দিষ্ট সময়ে কয়েন যোগ করে — সেটা এই টেস্টকে flaky করে তুলত।
    const payout = Math.floor(Number(bet.stake) * Number(bet.odd));
    expect(payout).toBe(200);                  // 100 × 2.00
    expect(payout).not.toBe(100 * 9999999);    // ক্লায়েন্টের পাঠানো অডস নয়
  });
});

describe('services/accumulator — ক্লায়েন্ট অডস fallback নেই (P0-02) ও max_bet প্রযোজ্য (P1-05)', () => {
  test('runner odds-এ না থাকলে fail-closed, ক্লায়েন্ট অডস ব্যবহার হয় না', async () => {
    const user = await makeUser();
    const a = await makeMarket({ HOME: '1.80' });
    const b = await makeMarket({ HOME: '1.90' });
    const before = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [user.id])).rows[0].coins);

    const result = await placeAccumulator(user.id, 100, [
      { match_id: a.matchId, market_id: a.marketId, runner: 'GHOST', odd: 5000 },
      { match_id: b.matchId, market_id: b.marketId, runner: 'HOME', odd: 5000 }
    ], 'en');

    expect(result.success).toBe(false);
    const after = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [user.id])).rows[0].coins);
    expect(after).toBe(before); // ব্যালেন্স স্পর্শই হয়নি
    const accas = await pool.query('SELECT COUNT(*)::int AS c FROM accumulators WHERE user_id=$1', [user.id]);
    expect(accas.rows[0].c).toBe(0);
  });

  test('markets.odds খালি হলে ({}) কোনো acca তৈরি হয় না', async () => {
    const user = await makeUser();
    const a = await makeMarket({});
    const b = await makeMarket({});

    const result = await placeAccumulator(user.id, 100, [
      { match_id: a.matchId, market_id: a.marketId, runner: 'A', odd: 9999 },
      { match_id: b.matchId, market_id: b.marketId, runner: 'A', odd: 9999 }
    ], 'en');

    expect(result.success).toBe(false);
  });

  test('বৈধ সিলেকশনে potential_win সার্ভার-অডস থেকে হিসাব হয়, ক্লায়েন্ট-অডস থেকে নয়', async () => {
    const user = await makeUser();
    const a = await makeMarket({ HOME: '2.00' });
    const b = await makeMarket({ HOME: '3.00' });

    const result = await placeAccumulator(user.id, 100, [
      { match_id: a.matchId, market_id: a.marketId, runner: 'HOME', odd: 9999 },
      { match_id: b.matchId, market_id: b.marketId, runner: 'HOME', odd: 9999 }
    ], 'en');

    expect(result.success).toBe(true);
    expect(result.totalOdd).toBe(6);            // 2.00 × 3.00, ক্লায়েন্টের ৯৯৯৯ নয়
    expect(result.potentialWin).toBe(600);      // ২ সিলেকশনে boost ০%
  });

  test('max_bet-এর চেয়ে বড় stake reject হয় (P1-05)', async () => {
    const user = await makeUser(100000000);
    const a = await makeMarket({ HOME: '2.00' });
    const b = await makeMarket({ HOME: '3.00' });
    const before = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [user.id])).rows[0].coins);

    const result = await placeAccumulator(user.id, 50000000, [
      { match_id: a.matchId, market_id: a.marketId, runner: 'HOME', odd: 2 },
      { match_id: b.matchId, market_id: b.marketId, runner: 'HOME', odd: 3 }
    ], 'en');

    expect(result.success).toBe(false);
    const after = Number((await pool.query('SELECT coins FROM users WHERE id=$1', [user.id])).rows[0].coins);
    expect(after).toBe(before);
  });
});
