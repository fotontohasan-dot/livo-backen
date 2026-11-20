// tests/regression/fridayBonusBdDay.test.js
// ---------------------------------------------------------------------------
// শুক্রবার-রিলোড (৮০%) এখন Asia/Dhaka ব্যবসায়িক বার দিয়ে ঠিক হয় (utils/businessTime
// .businessWeekday), আগে ছিল new Date().getDay() = সার্ভারের (UTC) বার।
// BD শুক্রবার = UTC বৃহস্পতি ১৮:০০ থেকে UTC শুক্র ১৮:০০। আসল Postgres, কিছু mock নয়;
// শুধু Date ঘড়ি স্থির। বোনাসের শতাংশ/ক্যাপ/ওয়ালেট হিসাব এখানে শুধু যাচাই হয়, বদলানো হয়নি।
//
// দুটো জায়গা: (১) approve/credit পথ (routes/payment.js creditApprovedDeposit),
// (২) ডিপোজিট পেজের লেবেল (GET /payment/deposit)।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const payment = require('../../routes/payment');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

jest.setTimeout(60000);

const DATE_ONLY = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'];

async function at(isoUtc, fn) {
  jest.useFakeTimers({ now: new Date(isoUtc), doNotFake: DATE_ONLY });
  try { return await fn(); } finally { jest.useRealTimers(); }
}

// 2026-03-13 = শুক্রবার (BD)
const FRI_0030_BD = '2026-03-12T18:30:00Z'; // UTC বৃহস্পতি, BD শুক্র ০০:৩০
const FRI_2330_BD = '2026-03-13T17:30:00Z'; // UTC শুক্র,     BD শুক্র ২৩:৩০
const SAT_0030_BD = '2026-03-13T18:30:00Z'; // UTC শুক্র,     BD শনি ০০:৩০ (UTC ভুলভাবে শুক্র)

const created = [];
async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('fri');
  const res = await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  expect(res.status).toBe(302);
  const id = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0].id;
  created.push(id);
  return { agent, id };
}

async function approvedDeposit(userId, amount = 1000) {
  await pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, status, want_bonus) VALUES ($1,'deposit','bkash',$2,'approved',false)`,
    [userId, amount]);
}

// pending ডিপোজিট বানিয়ে আসল approve পথে ক্রেডিট; ফেরত দেয় দেওয়া বোনাস
async function approveAt(userId, isoUtc, amount = 1000) {
  const r = await pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, status, want_bonus) VALUES ($1,'deposit','bkash',$2,'pending',true) RETURNING id`,
    [userId, amount]);
  const out = await at(isoUtc, () => payment.approvePaymentRequestById(r.rows[0].id));
  expect(out.success).toBe(true);
  return out.bonusGiven;
}

async function pageLabelPct(agent, isoUtc) {
  const res = await at(isoUtc, () => agent.get('/payment/deposit'));
  expect(res.status).toBe(200);
  return res.text;
}

afterAll(async () => {
  for (const id of created) {
    for (const t of ['coin_transactions', 'notifications', 'payment_requests', 'turnover_requirements']) {
      await pool.query(`DELETE FROM ${t} WHERE user_id=$1`, [id]).catch(() => {});
    }
  }
  await pool.end().catch(() => {});
});

describe('শুক্রবার ৮০% — BD ব্যবসায়িক বার (credit পথ)', () => {
  test('BD শুক্র ০০:৩০ (UTC বৃহস্পতি ১৮:৩০) = ৮০%', async () => {
    const { id } = await makeUser(); await approvedDeposit(id);
    expect(await approveAt(id, FRI_0030_BD)).toBe(800);
  });
  test('BD শুক্র ২৩:৩০ = ৮০%', async () => {
    const { id } = await makeUser(); await approvedDeposit(id);
    expect(await approveAt(id, FRI_2330_BD)).toBe(800);
  });
  test('BD শনি ০০:৩০ (UTC তখনও শুক্র) = ৫০%', async () => {
    const { id } = await makeUser(); await approvedDeposit(id);
    expect(await approveAt(id, SAT_0030_BD)).toBe(500);
  });
  test('প্রথম ডিপোজিট সবসময় ১০০% — শুক্র/শনি দুই সীমানাতেই', async () => {
    for (const iso of [FRI_0030_BD, FRI_2330_BD, SAT_0030_BD]) {
      const { id } = await makeUser();
      expect(await approveAt(id, iso)).toBe(1000);
    }
  });
});

describe('শুক্রবার ৮০% — ডিপোজিট পেজের লেবেল', () => {
  // লেবেল: bn "এই জমায় {pct}% বোনাস পাবেন" / en "Get {pct}% bonus on this deposit"
  const label = (pct) => new RegExp(`(?:এই জমায়|Get) ${pct}%`);
  test('BD শুক্র ০০:৩০ → ৮০%, BD শুক্র ২৩:৩০ → ৮০%, BD শনি ০০:৩০ → ৫০%', async () => {
    const { agent, id } = await makeUser(); await approvedDeposit(id);
    const a = await pageLabelPct(agent, FRI_0030_BD);
    const b = await pageLabelPct(agent, FRI_2330_BD);
    const c = await pageLabelPct(agent, SAT_0030_BD);
    expect(a).toMatch(label(80));
    expect(b).toMatch(label(80));
    expect(c).toMatch(label(50));
    expect(c).not.toMatch(label(80));
  });
  test('প্রথম ডিপোজিটের আগে লেবেল ১০০% (৮০/৫০ নয়) — শুক্র/শনি সীমানায়', async () => {
    const { agent } = await makeUser();
    for (const iso of [FRI_0030_BD, SAT_0030_BD]) {
      const html = await pageLabelPct(agent, iso);
      expect(html).toMatch(/১০০%|100%/);
      expect(html).not.toMatch(label(80));
      expect(html).not.toMatch(label(50));
    }
  });
});
