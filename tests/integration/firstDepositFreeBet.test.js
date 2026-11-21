// tests/integration/firstDepositFreeBet.test.js
// প্রথম যোগ্য approved ডিপোজিটে ফ্রি বেট (reason='first_deposit') — আসল Postgres, আসল approve পথ
// (approvePaymentRequestById / creditApprovedDeposit)। কোনো mock নেই।
const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const payment = require('../../routes/payment');
const freebet = require('../../services/freebet');
const { makeUser, link, makeDeposit, coins, cleanup } = require('../helpers/referralDeposit');

const approve = (id) => payment.approvePaymentRequestById(id);

async function freeBets(userId, reason = 'first_deposit') {
  const r = await pool.query('SELECT * FROM free_bets WHERE user_id = $1 AND reason = $2 ORDER BY id', [userId, reason]);
  return r.rows;
}

describe('প্রথম-ডিপোজিট ফ্রি বেট', () => {
  jest.setTimeout(60000);
  const users = [];
  const mk = async () => { const id = await makeUser('fdfb'); users.push(id); return id; };

  afterAll(async () => { await cleanup(users); });

  test('৪৯৯ → ফ্রি বেট নেই', async () => {
    const u = await mk();
    const d = await makeDeposit(u, 499);
    expect((await approve(d)).success).toBe(true);
    expect(await freeBets(u)).toHaveLength(0);
  });

  test('৫০০ → ৩০', async () => {
    const u = await mk();
    const d = await makeDeposit(u, 500);
    expect((await approve(d)).success).toBe(true);
    const rows = await freeBets(u);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(30);
    expect(rows[0].status).toBe('active');
    // ডিপোজিটের ব্যালেন্স হিসাব অপরিবর্তিত: ক্লেইমের আগে ফ্রি বেট ব্যালেন্সে যোগ হয় না
    expect(await coins(u)).toBe(500);
  });

  test('১০০০০ → ৩০', async () => {
    const u = await mk();
    await approve(await makeDeposit(u, 10000));
    const rows = await freeBets(u);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(30);
  });

  test('১০০০১ → ৫০', async () => {
    const u = await mk();
    await approve(await makeDeposit(u, 10001));
    const rows = await freeBets(u);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(50);
  });

  test('দ্বিতীয় ডিপোজিটে নেই', async () => {
    const u = await mk();
    await approve(await makeDeposit(u, 600));
    await approve(await makeDeposit(u, 20000));
    const rows = await freeBets(u);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(30);
  });

  test('want_bonus নিলে নেই', async () => {
    const u = await mk();
    await approve(await makeDeposit(u, 1000, { wantBonus: true }));
    expect(await freeBets(u)).toHaveLength(0);
  });

  test('৩০০ পরে ৬০০ ডিপোজিটে ৩০', async () => {
    const u = await mk();
    await approve(await makeDeposit(u, 300));
    expect(await freeBets(u)).toHaveLength(0);
    await approve(await makeDeposit(u, 600));
    const rows = await freeBets(u);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(30);
  });

  test('ডিপোজিট রোলব্যাকে ফ্রি বেট নেই', async () => {
    const u = await mk();
    const d = await makeDeposit(u, 700);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [d]);
      await payment.creditApprovedDeposit(client, r.rows[0]);
      // একই transaction-এ সারিটা দেখা যায়...
      const inTx = await client.query(`SELECT 1 FROM free_bets WHERE user_id=$1 AND reason='first_deposit'`, [u]);
      expect(inTx.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    // ...রোলব্যাকের পর নেই (ডিপোজিট ও নোটিফিকেশনও নেই)
    expect(await freeBets(u)).toHaveLength(0);
    expect(await coins(u)).toBe(0);
    const n = await pool.query(`SELECT 1 FROM notifications WHERE user_id=$1`, [u]);
    expect(n.rowCount).toBe(0);
    // ডিপোজিট এখনও pending — পরে অনুমোদনে ফ্রি বেট পায়
    await approve(d);
    expect(await freeBets(u)).toHaveLength(1);
  });

  test('concurrent দুই অনুমোদনে একটাই ফ্রি বেট', async () => {
    const u = await mk();
    const [d1, d2] = [await makeDeposit(u, 800), await makeDeposit(u, 900)];
    const results = await Promise.all([approve(d1), approve(d2)]);
    expect(results.every((r) => r.success)).toBe(true);
    expect(await freeBets(u)).toHaveLength(1);
    const notifs = await pool.query(`SELECT 1 FROM notifications WHERE user_id=$1 AND title='ফ্রি বেট!'`, [u]);
    expect(notifs.rowCount).toBe(1);
    expect(await coins(u)).toBe(1700);
  });

  test('ক্লেইমে টার্নওভার ৩x (সেটিং সিডেড, বদলালে সেটাই)', async () => {
    const seeded = await pool.query(`SELECT value FROM site_settings WHERE key='free_bet_turnover_multiplier'`);
    expect(seeded.rowCount).toBe(1);

    const u = await mk();
    await approve(await makeDeposit(u, 500));
    const [fb] = await freeBets(u);
    const res = await freebet.claimFreeBet(u, fb.id);
    expect(res.success).toBe(true);
    const t = await pool.query(
      `SELECT * FROM deposit_turnovers WHERE user_id=$1 AND deposit_id IS NULL`, [u]);
    expect(t.rows).toHaveLength(1);
    expect(Number(t.rows[0].bonus_amount)).toBe(30);
    expect(Number(t.rows[0].multiplier)).toBe(Number(seeded.rows[0].value));
    expect(Number(t.rows[0].required)).toBe(30 * Number(seeded.rows[0].value));
    if (seeded.rows[0].value === '3') expect(Number(t.rows[0].required)).toBe(90);

    // সেটিং বদলালে নতুন ক্লেইমে সেটাই প্রযোজ্য
    const original = seeded.rows[0].value;
    await pool.query(`UPDATE site_settings SET value='5' WHERE key='free_bet_turnover_multiplier'`);
    try {
      const u2 = await mk();
      await approve(await makeDeposit(u2, 500));
      const [fb2] = await freeBets(u2);
      await freebet.claimFreeBet(u2, fb2.id);
      const t2 = await pool.query(`SELECT * FROM deposit_turnovers WHERE user_id=$1 AND deposit_id IS NULL`, [u2]);
      expect(Number(t2.rows[0].required)).toBe(150);
    } finally {
      await pool.query(`UPDATE site_settings SET value=$1 WHERE key='free_bet_turnover_multiplier'`, [original]);
    }
  });

  test('অন্য (admin) ফ্রি বেটে নতুন সেটিং নয় — বিদ্যমান আচরণ', async () => {
    const u = await mk();
    const orig = (await pool.query(`SELECT value FROM site_settings WHERE key='free_bet_turnover_multiplier'`)).rows[0].value;
    await pool.query(`UPDATE site_settings SET value='9' WHERE key='free_bet_turnover_multiplier'`);
    try {
      const ins = await pool.query(
        `INSERT INTO free_bets (user_id, amount, reason, status) VALUES ($1, 40, 'admin', 'active') RETURNING id`, [u]);
      await freebet.claimFreeBet(u, ins.rows[0].id);
      const t = await pool.query(`SELECT * FROM deposit_turnovers WHERE user_id=$1 AND deposit_id IS NULL`, [u]);
      expect(Number(t.rows[0].multiplier)).not.toBe(9);
      const cfg = await require('../../services/turnover').loadConfig(pool);
      expect(Number(t.rows[0].multiplier)).toBe(cfg.multiplier);
    } finally {
      await pool.query(`UPDATE site_settings SET value=$1 WHERE key='free_bet_turnover_multiplier'`, [orig]);
    }
  });

  test('রেফারার ও রেফার-করা ইউজারের নোটিফিকেশনে ফ্রি বেটের উল্লেখ নেই / রেফারেল সারি নেই', async () => {
    const referrer = await mk();
    const referred = await mk();
    await link(referrer, referred);
    await approve(await makeDeposit(referred, 600));
    const rn = await pool.query(`SELECT title, message FROM notifications WHERE user_id=$1`, [referrer]);
    for (const row of rn.rows) expect(`${row.title} ${row.message}`).not.toMatch(/ফ্রি বেট|free bet/i);
    // ফ্রি বেটের নোটিফিকেশনে রেফারেলের উল্লেখ নেই
    const fn = await pool.query(`SELECT message FROM notifications WHERE user_id=$1 AND title='ফ্রি বেট!'`, [referred]);
    expect(fn.rowCount).toBe(1);
    expect(fn.rows[0].message).not.toMatch(/রেফার|referr/i);
    // রেফারেল পাতা/সার্ভিসের উৎসে ফ্রি বেটের উল্লেখ নেই (রেফারেল পুরস্কারের নিজস্ব 'first_deposit' reason
    // আলাদা জিনিস — referral_rewards-এর, free_bets-এর নয়; তাই শুধু ফ্রি বেট শব্দ খোঁজা হয়)
    for (const f of ['views/profile/referral.ejs', 'services/referral.js', 'services/referralRewards.js']) {
      const p = path.join(__dirname, '..', '..', f);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.readFileSync(p, 'utf8')).not.toMatch(/free_bets?|freebet|ফ্রি বেট|free bet/i);
    }
  });
});

describe('অ্যাডমিন ফ্রি বেট — ইউনিক reason', () => {
  jest.setTimeout(60000);
  const users = [];
  afterAll(async () => { await cleanup(users); });

  test('একই ইউজারকে একাধিক admin ফ্রি বেট দেওয়া যায়; বিদ্যমান সারি অপরিবর্তিত', async () => {
    const u = await makeUser('fdadm'); users.push(u);
    await pool.query(`INSERT INTO free_bets (user_id, amount, reason, status) VALUES ($1, 11, 'admin', 'active')`, [u]);
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'admin.js'), 'utf8');
    expect(src).toMatch(/grantFreeBet\(req\.params\.id, amount, adminReason\)/);
    const mkReason = (id) => `admin:${id}:${require('crypto').randomBytes(6).toString('hex')}`;
    const r1 = mkReason(1); const r2 = mkReason(1);
    expect(r1.length).toBeLessThanOrEqual(40);
    await freebet.grantFreeBet(u, 20, r1);
    await freebet.grantFreeBet(u, 25, r2);
    const rows = await pool.query(`SELECT amount, reason FROM free_bets WHERE user_id=$1 ORDER BY id`, [u]);
    expect(rows.rows).toHaveLength(3);
    expect(Number(rows.rows[0].amount)).toBe(11);
    expect(rows.rows[0].reason).toBe('admin');
  });
});
