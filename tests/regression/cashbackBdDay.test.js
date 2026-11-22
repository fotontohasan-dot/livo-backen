// tests/regression/cashbackBdDay.test.js
// ---------------------------------------------------------------------------
// cashback (daily_losses.loss_date লেখা/পড়া) ও periodicReward (সাপ্তাহিক/মাসিক)
// এখন Asia/Dhaka ব্যবসায়িক তারিখ ব্যবহার করে; আগে লেখা ছিল UTC দিনে এবং পড়া
// UTC/DB CURRENT_DATE-এ। BD দিন বদলায় UTC ১৮:০০-এ — ওই ছয় ঘণ্টায় পুরোনো কোড ভুল দিনে যেত।
// আসল Postgres; শুধু Date ঘড়ি স্থির। ক্যাশব্যাকের হার/পরিমাণ/ক্যাপ বদলানো হয়নি।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const cashback = require('../../services/cashback');
const periodic = require('../../services/periodicReward');

jest.setTimeout(60000);

const DATE_ONLY = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'];
async function at(isoUtc, fn) {
  jest.useFakeTimers({ now: new Date(isoUtc), doNotFake: DATE_ONLY });
  try { return await fn(); } finally { jest.useRealTimers(); }
}

const BEFORE = '2026-03-10T17:59:30Z'; // BD ১০ মার্চ ২৩:৫৯:৩০ (UTC-ও ১০ মার্চ)
const AFTER = '2026-03-10T18:00:30Z';  // BD ১১ মার্চ ০০:০০:৩০ (UTC এখনও ১০ মার্চ!)

const created = [];
let seq = 0;
async function makeUser() {
  seq += 1;
  const tag = `${Date.now().toString(36)}${seq}`.slice(-9);
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins) VALUES ($1, $2, 'x', 0) RETURNING id`,
    [`cb${tag}`, `017${String(Date.now()).slice(-7)}${seq}`.slice(0, 11)]);
  created.push(r.rows[0].id);
  return r.rows[0].id;
}
const coinsOf = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);
const lossRows = async (id) => (await pool.query(
  `SELECT to_char(loss_date,'YYYY-MM-DD') d, category, total_bet::int bet, total_win::int win FROM daily_losses WHERE user_id=$1 ORDER BY loss_date, category`, [id])).rows;
const seed = (id, date, bet, win = 0, category = 'sports') => pool.query(
  `INSERT INTO daily_losses (user_id, loss_date, category, total_bet, total_win) VALUES ($1,$2,$3,$4,$5)`,
  [id, date, category, bet, win]);

afterAll(async () => {
  for (const id of created) {
    for (const t of ['daily_losses', 'periodic_claims', 'coin_transactions', 'notifications']) {
      await pool.query(`DELETE FROM ${t} WHERE user_id=$1`, [id]).catch(() => {});
    }
    await pool.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});
  }
  await pool.end().catch(() => {});
});

describe('cashback — loss_date লেখা (addBet/addWin)', () => {
  test('BD মধ্যরাতের আগে ১০ মার্চ, পরে ১১ মার্চে লেখা হয়', async () => {
    const u = await makeUser();
    await at(BEFORE, () => cashback.addBet(u, 100));
    await at(AFTER, async () => { await cashback.addBet(u, 200); await cashback.addWin(u, 50); });
    expect(await lossRows(u)).toEqual([
      { d: '2026-03-10', category: 'sports', bet: 100, win: 0 },
      { d: '2026-03-11', category: 'sports', bet: 200, win: 50 }
    ]);
  });
});

describe('cashback — গতকাল (পড়া) লেখার একই নিয়মে', () => {
  test('BD ০০:৩০-এ (UTC তখনও আগের দিন) লেখা "আজকের" সারি পরদিন BD গতকাল হিসেবে ক্লেইম হয়', async () => {
    const u = await makeUser();
    await at(BEFORE, () => cashback.addBet(u, 1000)); // BD ১০ মার্চ-এ লেখা, নিট লস ১০০০ → ৫% = ৫০
    const early = await at(BEFORE, () => cashback.claimCashback(u, 'sports', 'bn')); // তখনও "আজ" — গতকালে সারি নেই
    expect(early.success).toBe(false);
    const status = await at(AFTER, () => cashback.getCashbackStatus(u));
    expect(status.yesterday).toBe('2026-03-10');
    expect(status.byCategory.sports).toMatchObject({ available: true, amount: 50, claimed: false });
    const before = await coinsOf(u);
    const ok = await at(AFTER, () => cashback.claimCashback(u, 'sports', 'bn'));
    expect(ok.success).toBe(true);
    expect(ok.amount).toBe(50); // হার ৫% অপরিবর্তিত
    expect(await coinsOf(u) - before).toBe(50);
    const again = await at(AFTER, () => cashback.claimCashback(u, 'sports', 'bn'));
    expect(again.success).toBe(false); // ডুপ্লিকেট এখনও আটকায়
  });

  test('UTC-গতকালের (৯ মার্চ) সারি BD ১১ মার্চ ০০:৩০-এ গতকাল নয়', async () => {
    const u = await makeUser();
    await seed(u, '2026-03-09', 1000);
    const r = await at(AFTER, () => cashback.claimCashback(u, 'sports', 'bn'));
    expect(r.success).toBe(false);
    expect(await coinsOf(u)).toBe(0);
  });

  test('সপ্তাহ/মাস সামারির সীমা BD আজ থেকে (DB CURRENT_DATE নয়)', async () => {
    const u = await makeUser();
    await seed(u, '2026-03-04', 100, 0, 'sports'); // BD আজ (১১ মার্চ) - ৭
    await seed(u, '2026-03-03', 900, 0, 'casino'); // ৮ দিন আগে — বাদ
    const s = await at(AFTER, () => cashback.getPeriodSummary(u, 7));
    expect(s.totalBet).toBe(100);
    const m = await at(AFTER, () => cashback.getPeriodSummary(u, 30));
    expect(m.totalBet).toBe(1000);
  });
});

describe('periodicReward — BD তারিখ', () => {
  test('সাপ্তাহিক: ৭ দিনের উইন্ডো ও weekKey BD দিন ধরে', async () => {
    const u = await makeUser();
    await seed(u, '2026-03-04', 1000, 0, 'sports'); // BD আজ-৭ — ভেতরে
    await seed(u, '2026-03-03', 5000, 0, 'casino'); // বাইরে
    const st = await at(AFTER, () => periodic.getWeeklyStatus(u));
    expect(st.netLoss).toBe(1000);
    expect(st.amount).toBe(100); // ১০% অপরিবর্তিত
    expect(st.weekKey).toBe('2026-W11'); // ১১ মার্চ ২০২৬ (বুধ)
  });

  test('weekKey: BD সোমবার ০০:৩০ (UTC রবিবার ১৮:৩০) নতুন সপ্তাহ', async () => {
    const u = await makeUser();
    const sunUtc = await at('2026-03-15T17:30:00Z', () => periodic.getWeeklyStatus(u)); // BD রবি ২৩:৩০
    const monBd = await at('2026-03-15T18:30:00Z', () => periodic.getWeeklyStatus(u));  // BD সোম ০০:৩০
    expect(sunUtc.weekKey).toBe('2026-W11');
    expect(monBd.weekKey).toBe('2026-W12');
  });

  test('মাসিক: BD ১ এপ্রিল ০০:৩০ (UTC ৩১ মার্চ) এ "গত মাস" = মার্চ', async () => {
    const u = await makeUser();
    await seed(u, '2026-03-31', 60000, 0, 'sports');
    const bdApril = await at('2026-03-31T18:30:00Z', () => periodic.getMonthlyStatus(u));
    expect(bdApril.monthKey).toBe('2026-03');
    expect(bdApril.turnover).toBe(60000);
    expect(bdApril.bonus).toBe(500); // টিয়ার অপরিবর্তিত
    const bdMarch = await at('2026-03-31T17:30:00Z', () => periodic.getMonthlyStatus(u));
    expect(bdMarch.monthKey).toBe('2026-02');
  });

  test('মাসিক: জানুয়ারির BD ১ তারিখে গত মাস = আগের বছরের ডিসেম্বর', async () => {
    const u = await makeUser();
    const st = await at('2025-12-31T18:30:00Z', () => periodic.getMonthlyStatus(u)); // BD ১ জানু ২০২৬
    expect(st.monthKey).toBe('2025-12');
  });
});
