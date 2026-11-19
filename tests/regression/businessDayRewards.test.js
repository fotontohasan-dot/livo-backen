// tests/regression/businessDayRewards.test.js
// ---------------------------------------------------------------------------
// dailyReward / wheel / missions-এর "আজ" এখন Asia/Dhaka ব্যবসায়িক দিন
// (utils/businessTime.js), আগে ছিল toISOString().slice(0,10) = UTC দিন।
// আসল Postgres, কিছু mock নয়। শুধু Date ঘড়ি স্থির (জেস্টের fake timers, বাকি টাইমার আসল)।
// BD দিন বদলায় UTC ১৮:০০-এ, UTC দিন BD ০৬:০০-এ — এই ছয় ঘণ্টার ফাঁকেই পুরোনো কোড ভুল করত।
// পুরস্কারের পরিমাণ ও ওয়ালেট হিসাব এখানে শুধু যাচাই হয়, বদলানো হয়নি।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const dailyReward = require('../../services/dailyReward');
const wheel = require('../../services/wheel');
const missions = require('../../services/missions');

jest.setTimeout(60000);

const DATE_ONLY = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'];

async function at(isoUtc, fn) {
  jest.useFakeTimers({ now: new Date(isoUtc), doNotFake: DATE_ONLY });
  try { return await fn(); } finally { jest.useRealTimers(); }
}

const created = [];
let seq = 0;
async function makeUser() {
  seq += 1;
  const tag = `${Date.now().toString(36)}${seq}`.slice(-9);
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins) VALUES ($1, $2, 'x', 0) RETURNING id`,
    [`bd${tag}`, `017${String(Date.now()).slice(-7)}${seq}`.slice(0, 11)]
  );
  created.push(r.rows[0].id);
  return r.rows[0].id;
}
const coinsOf = async (id) => Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);

afterAll(async () => {
  for (const id of created) {
    for (const t of ['user_daily_rewards', 'wheel_spins', 'user_missions', 'mission_claims', 'coin_transactions', 'notifications', 'payment_requests']) {
      await pool.query(`DELETE FROM ${t} WHERE user_id=$1`, [id]).catch(() => {});
    }
    await pool.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});
  }
  await pool.end().catch(() => {});
});

// UTC ইনস্ট্যান্ট → tz-ছাড়া TIMESTAMP কলামে (সেশন টাইমজোনের স্থানীয় রূপ)
const naive = (iso) => pool.query(`SELECT ($1::timestamptz AT TIME ZONE current_setting('TimeZone')) AS v`, [iso]).then(r => r.rows[0].v);

// ---------------------------------------------------------------------------
describe('dailyReward — BD ব্যবসায়িক দিন', () => {
  const BEFORE = '2026-03-10T17:59:30Z'; // BD ১০ মার্চ ২৩:৫৯:৩০ (UTC-ও ১০ মার্চ)
  const AFTER = '2026-03-10T18:00:30Z';  // BD ১১ মার্চ ০০:০০:৩০ (UTC এখনও ১০ মার্চ!)

  test('BD মধ্যরাতের পরে নতুন দিনের রো/টার্নওভার; আগের দিনের রো ১০ মার্চেই থাকে', async () => {
    const u = await makeUser();
    await at(BEFORE, () => dailyReward.updateDailyTurnover(u, 1000));
    await at(AFTER, () => dailyReward.updateDailyTurnover(u, 300));

    const rows = (await pool.query(
      `SELECT reward_date::text AS d, sports_turnover FROM user_daily_rewards WHERE user_id=$1 ORDER BY reward_date`, [u])).rows;
    expect(rows.map(r => r.d)).toEqual(['2026-03-10', '2026-03-11']);
    expect(Number(rows[0].sports_turnover)).toBe(1000);
    expect(Number(rows[1].sports_turnover)).toBe(300);

    expect((await at(BEFORE, () => dailyReward.getTodayReward(u))).turnover).toBe(1000);
    expect((await at(AFTER, () => dailyReward.getTodayReward(u))).turnover).toBe(300);
  });

  test('ক্লেইম: মধ্যরাতের আগে একবার (পরিমাণ = টিয়ারের bonus_amount), একই BD দিনে দ্বিতীয়বার নয়, মধ্যরাতের পর রো না থাকলে নয়', async () => {
    const u = await makeUser();
    await at(BEFORE, () => dailyReward.updateDailyTurnover(u, 1000000));
    const tier = (await pool.query(
      `SELECT bonus_amount FROM daily_reward_tiers WHERE min_turnover <= $1 ORDER BY min_turnover DESC LIMIT 1`, [1000000])).rows[0];
    expect(tier).toBeDefined();

    const first = await at(BEFORE, () => dailyReward.claimDailyReward(u));
    expect(first.success).toBe(true);
    expect(first.amount).toBe(Number(tier.bonus_amount));
    expect(await coinsOf(u)).toBe(Number(tier.bonus_amount));

    const second = await at('2026-03-10T17:59:50Z', () => dailyReward.claimDailyReward(u));
    expect(second.success).toBe(false); // একই BD দিন
    expect(await coinsOf(u)).toBe(Number(tier.bonus_amount));

    // BD ১১ মার্চ: নতুন দিন, বেট নেই → রো নেই → ক্লেইম নেই (পুরোনো কোডে UTC-তে ১০ মার্চ, "claimed" দেখাত)
    const next = await at(AFTER, () => dailyReward.claimDailyReward(u));
    expect(next.success).toBe(false);
    expect((await at(AFTER, () => dailyReward.getTodayReward(u))).claimed).toBe(false);
    expect(await coinsOf(u)).toBe(Number(tier.bonus_amount));
  });
});

// ---------------------------------------------------------------------------
describe('wheel — BD ব্যবসায়িক দিন', () => {
  async function deposit(u, isoUtc) {
    const ts = await naive(isoUtc);
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, method, amount, status, created_at, updated_at)
       VALUES ($1, 'deposit', 'bkash', 500, 'approved', $2, $2)`, [u, ts]);
  }

  test('মধ্যরাতের আগে স্পিন (spin_date=BD ১০ মার্চ); মধ্যরাতের পর নতুন দিন — আগের দিনের ডিপোজিটে লক, "আজ স্পিন করা" নয়', async () => {
    const u = await makeUser();
    await deposit(u, '2026-03-10T17:30:00Z'); // BD ১০ মার্চ ২৩:৩০

    expect(await at('2026-03-10T17:59:30Z', () => wheel.canSpin(u))).toMatchObject({ canSpin: true, locked: false });
    const before = await coinsOf(u);
    const r = await at('2026-03-10T17:59:40Z', () => wheel.spin(u));
    expect(r.success).toBe(true);
    const spin = (await pool.query(`SELECT spin_date::text AS d, prize FROM wheel_spins WHERE user_id=$1`, [u])).rows;
    expect(spin).toHaveLength(1);
    expect(spin[0].d).toBe('2026-03-10');
    expect(await coinsOf(u)).toBe(before + Number(spin[0].prize)); // ওয়ালেট = শুধু পুরস্কার

    // BD ১১ মার্চ ০০:০০:৩০ — নতুন দিন: ডিপোজিট গতকালের, তাই লক (পুরোনো কোড: UTC ১০ মার্চ → "spun")
    const next = await at('2026-03-10T18:00:30Z', () => wheel.canSpin(u));
    expect(next).toMatchObject({ canSpin: false, prize: null, locked: true });
  });

  test('BD ০২:০০-র ডিপোজিট (UTC তখনও আগের দিন) BD দিনেই স্পিন আনলক করে, spin_date=BD দিন', async () => {
    const u = await makeUser();
    await deposit(u, '2026-03-10T20:00:00Z'); // BD ১১ মার্চ ০২:০০; ::date (UTC) = ১০ মার্চ
    const st = await at('2026-03-11T01:00:00Z', () => wheel.canSpin(u)); // BD ১১ মার্চ ০৬:০০
    expect(st).toMatchObject({ canSpin: true, locked: false });
    const r = await at('2026-03-11T01:00:10Z', () => wheel.spin(u));
    expect(r.success).toBe(true);
    const d = (await pool.query(`SELECT spin_date::text AS d FROM wheel_spins WHERE user_id=$1`, [u])).rows[0].d;
    expect(d).toBe('2026-03-11');
    // একই BD দিনে দ্বিতীয় স্পিন নয়
    expect((await at('2026-03-11T05:00:00Z', () => wheel.spin(u))).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('missions — BD ব্যবসায়িক দিন ও সপ্তাহ (সোমবার-শুরু)', () => {
  test('দৈনিক: মধ্যরাতের পর নতুন mission_date', async () => {
    const u = await makeUser();
    await at('2026-03-10T17:59:30Z', () => missions.updateMissionProgress(u, 50));
    await at('2026-03-10T18:00:30Z', () => missions.updateMissionProgress(u, 70));
    const rows = (await pool.query(
      `SELECT mission_date::text AS d, bet_count, turnover FROM user_missions WHERE user_id=$1 ORDER BY mission_date`, [u])).rows;
    expect(rows.map(r => r.d)).toEqual(['2026-03-10', '2026-03-11']);
    expect(Number(rows[0].turnover)).toBe(50);
    expect(Number(rows[1].turnover)).toBe(70);
    const m = await at('2026-03-10T18:00:30Z', () => missions.getMissions(u));
    const betDef = m.daily.find(x => x.target > 0);
    expect(betDef).toBeDefined();
  });

  test('উইকলি: রবিবার ২৩:৫৯ BD এখনও পুরোনো সপ্তাহ, সোমবার ০০:০০ BD থেকে নতুন সপ্তাহ', async () => {
    const u = await makeUser();
    const def = (await pool.query(
      `INSERT INTO mission_defs (title, target_type, target_value, reward, period)
       VALUES ('bd-week-test', 'bet_count', 1, 7, 'weekly') RETURNING id`)).rows[0].id;
    try {
      // সপ্তাহ ৯–১৫ মার্চ (সোম–রবি)। ১৫ মার্চ রবিবার।
      await at('2026-03-15T17:59:30Z', () => missions.updateMissionProgress(u, 10)); // BD রবি ১৫ মার্চ ২৩:৫৯
      const sun = (await at('2026-03-15T17:59:40Z', () => missions.getMissions(u))).weekly.find(x => x.id === def);
      expect(sun.progress).toBe(1); // এই সপ্তাহের ১৫ মার্চের বেট গোনা হচ্ছে

      // BD সোমবার ১৬ মার্চ ০০:০০:৩০ — নতুন সপ্তাহ, প্রোগ্রেস ০ (পুরোনো কোড: UTC এখনও রবি → একই সপ্তাহ)
      const mon = (await at('2026-03-15T18:00:30Z', () => missions.getMissions(u))).weekly.find(x => x.id === def);
      expect(mon.progress).toBe(0);

      // ক্লেইম: রবিবার রাতে সম্ভব, period_key = সোমবার ৯ মার্চ; ওয়ালেট = mission reward
      const c = await at('2026-03-15T17:59:50Z', () => missions.claimMission(u, def));
      expect(c.success).toBe(true);
      expect(await coinsOf(u)).toBe(7);
      const key = (await pool.query(`SELECT period_key FROM mission_claims WHERE user_id=$1 AND mission_id=$2`, [u, def])).rows[0].period_key;
      expect(String(key).slice(0, 10)).toBe('2026-03-09');
      // সোমবার BD-তে নতুন সপ্তাহের বেট ছাড়া ক্লেইম নয়
      const c2 = await at('2026-03-15T18:00:50Z', () => missions.claimMission(u, def));
      expect(c2.success).toBe(false);
    } finally {
      await pool.query(`DELETE FROM mission_claims WHERE mission_id=$1`, [def]);
      await pool.query(`DELETE FROM mission_defs WHERE id=$1`, [def]);
    }
  });

  test('স্পেশাল: start/end_date BD আজকের সঙ্গে তুলনা (UTC CURRENT_DATE নয়)', async () => {
    const u = await makeUser();
    const def = (await pool.query(
      `INSERT INTO mission_defs (title, target_type, target_value, reward, period, start_date, end_date)
       VALUES ('bd-special-test', 'bet_count', 1, 5, 'special', '2026-03-11', '2026-03-20') RETURNING id`)).rows[0].id;
    try {
      const ids = async (iso) => (await at(iso, () => missions.getMissions(u))).special.map(x => x.id);
      expect(await ids('2026-03-10T17:59:30Z')).not.toContain(def); // BD ১০ মার্চ — শুরুর আগে
      expect(await ids('2026-03-10T18:00:30Z')).toContain(def);     // BD ১১ মার্চ — চালু
    } finally {
      await pool.query(`DELETE FROM mission_defs WHERE id=$1`, [def]);
    }
  });
});
