// tests/regression/coinsDailyBonusBdDay.test.js
// ---------------------------------------------------------------------------
// /coins/daily-bonus-এর "আজ" এখন Asia/Dhaka ব্যবসায়িক দিন (utils/businessTime.js),
// আগে ছিল SQL CURRENT_DATE (UTC)। আসল Postgres + আসল HTTP — কিছু mock নয়।
//
// শুধু Date ঘড়ি স্থির করা হয় (জেস্টের modern fake timers, বাকি টাইমার আসল), যাতে
// BD মধ্যরাতের আগে/পরে নির্ধারিত মুহূর্ত সিমুলেট করা যায়। UTC দিন বদলায় BD ০৬:০০-এ,
// BD দিন বদলায় UTC ১৮:০০-এ — এই ছয় ঘণ্টার ফাঁকেই পুরোনো কোড ভুল করত।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken } = require('../helpers/app');

const DATE_ONLY = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'];

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const res = await pool.query('UPDATE users SET coins = 0, last_bonus_date = NULL WHERE username = $1 RETURNING id', [username]);
  if (!res.rows[0]) throw new Error('টেস্ট ইউজার তৈরি হয়নি');
  const page = await agent.get('/profile');
  return { agent, id: res.rows[0].id, csrf: extractCsrfToken(page.text) };
}

const coinsOf = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);
const bonusRows = async (id) => Number((await pool.query(
  `SELECT COUNT(*)::int AS c FROM coin_transactions WHERE user_id=$1 AND type='daily_bonus'`, [id])).rows[0].c);

// last_bonus_date TIMESTAMP (tz ছাড়া) — NOW() যেভাবে লেখে সেভাবেই বসানো: সেশন টাইমজোনের স্থানীয় সময়
async function setLastBonusAtUtcInstant(id, isoUtc) {
  await pool.query(
    `UPDATE users SET last_bonus_date = ($1::timestamptz AT TIME ZONE current_setting('TimeZone')) WHERE id=$2`,
    [isoUtc, id]);
}

async function claimAt(user, isoUtc) {
  jest.useFakeTimers({ now: new Date(isoUtc), doNotFake: DATE_ONLY });
  try {
    return await user.agent.post('/coins/daily-bonus').type('form').send({ _csrf: user.csrf });
  } finally {
    jest.useRealTimers();
  }
}

afterAll(async () => { await pool.end().catch(() => {}); });

describe('ডেইলি বোনাস — Asia/Dhaka ব্যবসায়িক দিন', () => {
  // ১০ মার্চ ২০২৬: BD মধ্যরাত = ১০ মার্চ ১৮:০০ UTC
  const BEFORE_BD_MIDNIGHT = '2026-03-10T17:59:30Z'; // BD ১০ মার্চ ২৩:৫৯:৩০ (UTC-ও ১০ মার্চ)
  const AFTER_BD_MIDNIGHT = '2026-03-10T18:00:30Z';  // BD ১১ মার্চ ০০:০০:৩০ (UTC এখনও ১০ মার্চ!)

  test('BD মধ্যরাতের আগে ক্লেইম আটকায়, পরে (UTC তখনও একই দিন) ক্লেইম হয়', async () => {
    const u = await makeUser();
    await setLastBonusAtUtcInstant(u.id, '2026-03-10T10:00:00Z'); // BD ১০ মার্চ ১৬:০০

    await claimAt(u, BEFORE_BD_MIDNIGHT);          // একই BD দিন
    expect(await coinsOf(u.id)).toBe(0);
    expect(await bonusRows(u.id)).toBe(0);

    await claimAt(u, AFTER_BD_MIDNIGHT);           // নতুন BD দিন
    expect(await coinsOf(u.id)).toBe(100);
    expect(await bonusRows(u.id)).toBe(1);
  });

  test('BD ভোরে (UTC আগের দিন) নেওয়া বোনাসের পর একই BD দিনে UTC তারিখ বদলালেও দ্বিতীয় ক্লেইম আটকায়', async () => {
    const u = await makeUser();
    await setLastBonusAtUtcInstant(u.id, '2026-03-10T19:00:00Z'); // BD ১১ মার্চ ০১:০০ (UTC ১০ মার্চ)

    await claimAt(u, '2026-03-11T06:30:00Z');      // BD ১১ মার্চ ১২:৩০ — UTC তারিখ ১১, পুরোনো কোডে অনুমোদিত হতো
    expect(await coinsOf(u.id)).toBe(0);
    expect(await bonusRows(u.id)).toBe(0);
  });

  test('একই BD দিনে প্রথম ক্লেইম সফল, দ্বিতীয় আটকায় (পরিমাণ ১০০ অপরিবর্তিত)', async () => {
    const u = await makeUser();
    const first = await u.agent.post('/coins/daily-bonus').type('form').send({ _csrf: u.csrf });
    expect([302, 303]).toContain(first.status);
    expect(await coinsOf(u.id)).toBe(100);

    await u.agent.post('/coins/daily-bonus').type('form').send({ _csrf: u.csrf });
    expect(await coinsOf(u.id)).toBe(100);
    expect(await bonusRows(u.id)).toBe(1);
  });
});
