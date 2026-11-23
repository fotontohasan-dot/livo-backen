// tests/integration/firstDepositFreeBet.test.js
// প্রথম যোগ্য approved ডিপোজিটে একবার ফ্রি বেট (reason='first_deposit') — আসল Postgres, আসল
// approvePaymentRequestById / creditApprovedDeposit। কোনো mock নেই (শুধু এরর-লগ চুপ করানো)।
const { pool } = require('../../db');
const payment = require('../../routes/payment');
const freebet = require('../../services/freebet');
const settings = require('../../services/settings');
const businessTime = require('../../utils/businessTime');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { makeUser, makeDeposit, coins, cleanup } = require('../helpers/referralDeposit');

jest.setTimeout(120000);

const users = [];
const mk = async () => { const id = await makeUser('fdfb'); users.push(id); return id; };
const approve = (id) => payment.approvePaymentRequestById(id);
const rows = async (userId, reason = 'first_deposit') =>
  (await pool.query('SELECT * FROM free_bets WHERE user_id = $1 AND reason = $2 ORDER BY id', [userId, reason])).rows;
const raw = async (key) => {
  const r = await pool.query('SELECT value FROM site_settings WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
};
const setRaw = async (key, value) => {
  if (value === null) await pool.query('DELETE FROM site_settings WHERE key = $1', [key]);
  else await pool.query(`INSERT INTO site_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
  await settings.invalidateSettingsCache();
};

afterAll(async () => { await cleanup(users); });

describe('প্রথম-ডিপোজিট ফ্রি বেট — পরিমাণ ও শর্ত', () => {
  test('৪৯৯ → নেই', async () => {
    const u = await mk();
    expect((await approve(await makeDeposit(u, 499))).success).toBe(true);
    expect(await rows(u)).toHaveLength(0);
  });

  test('৫০০ → ৩০ (active); ব্যালেন্স ডিপোজিটের সমান, নোটিফিকেশনে ফ্রি বেটের উল্লেখ নেই', async () => {
    const u = await mk();
    expect((await approve(await makeDeposit(u, 500))).success).toBe(true);
    const r = await rows(u);
    expect(r).toHaveLength(1);
    expect(Number(r[0].amount)).toBe(30);
    expect(r[0].status).toBe('active');
    expect(await coins(u)).toBe(500); // ক্লেইমের আগে ফ্রি বেট ব্যালেন্সে নেই
    const n = await pool.query(
      `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND (title ILIKE '%ফ্রি%' OR message ILIKE '%ফ্রি%' OR title ILIKE '%free%' OR message ILIKE '%free bet%')`, [u]);
    expect(Number(n.rows[0].count)).toBe(0);
  });

  test('১০০০০ → ৩০', async () => {
    const u = await mk();
    await approve(await makeDeposit(u, 10000));
    const r = await rows(u);
    expect(r).toHaveLength(1);
    expect(Number(r[0].amount)).toBe(30);
  });

  test('১০০০১ → ৫০', async () => {
    const u = await mk();
    await approve(await makeDeposit(u, 10001));
    const r = await rows(u);
    expect(r).toHaveLength(1);
    expect(Number(r[0].amount)).toBe(50);
  });

  test('দ্বিতীয় যোগ্য ডিপোজিটে নেই (একবারই)', async () => {
    const u = await mk();
    await approve(await makeDeposit(u, 600));
    await approve(await makeDeposit(u, 20000));
    const r = await rows(u);
    expect(r).toHaveLength(1);
    expect(Number(r[0].amount)).toBe(30);
  });

  test('want_bonus নিলে সেই ডিপোজিটে নেই', async () => {
    const u = await mk();
    await approve(await makeDeposit(u, 1000, { wantBonus: true }));
    expect(await rows(u)).toHaveLength(0);
  });

  test('৩০০ পরে ৬০০ ডিপোজিটে ৩০ ("সারি আছে কিনা" — ডিপোজিট গুনে নয়)', async () => {
    const u = await mk();
    await approve(await makeDeposit(u, 300));
    expect(await rows(u)).toHaveLength(0);
    await approve(await makeDeposit(u, 600));
    const r = await rows(u);
    expect(r).toHaveLength(1);
    expect(Number(r[0].amount)).toBe(30);
  });

  test('ডিপোজিট রোলব্যাকে ফ্রি বেটও যায়', async () => {
    const u = await mk();
    const depId = await makeDeposit(u, 700);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const req = (await client.query('SELECT * FROM payment_requests WHERE id = $1', [depId])).rows[0];
      await payment.creditApprovedDeposit(client, req);
      expect((await client.query(`SELECT COUNT(*) FROM free_bets WHERE user_id=$1 AND reason='first_deposit'`, [u])).rows[0].count).toBe('1');
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect(await rows(u)).toHaveLength(0);
    expect(await coins(u)).toBe(0);
  });

  test('ফ্রি বেটে এরর হলেও ডিপোজিট চলে (SAVEPOINT), এরর লগ হয়', async () => {
    const u = await mk();
    await pool.query(`CREATE OR REPLACE FUNCTION fdfb_fail() RETURNS trigger AS $$
      BEGIN IF NEW.user_id = ${Number(u)} THEN RAISE EXCEPTION 'fdfb test failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pool.query('CREATE TRIGGER fdfb_fail_trg BEFORE INSERT ON free_bets FOR EACH ROW EXECUTE FUNCTION fdfb_fail()');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await approve(await makeDeposit(u, 800));
      expect(out.success).toBe(true);
      expect(err.mock.calls.some((c) => String(c[0]).includes('grantFirstDepositFreeBet error'))).toBe(true);
    } finally {
      err.mockRestore();
      await pool.query('DROP TRIGGER IF EXISTS fdfb_fail_trg ON free_bets');
      await pool.query('DROP FUNCTION IF EXISTS fdfb_fail()');
    }
    expect(await coins(u)).toBe(800);
    expect(await rows(u)).toHaveLength(0);
    const st = (await pool.query(`SELECT status FROM payment_requests WHERE user_id=$1`, [u])).rows[0].status;
    expect(st).toBe('approved');
  });

  test('একই ইউজারের দুই ডিপোজিট একসাথে অনুমোদনে ফ্রি বেট একটাই', async () => {
    for (let i = 0; i < 4; i++) {
      const u = await mk();
      const [a, b] = [await makeDeposit(u, 600), await makeDeposit(u, 700)];
      const out = await Promise.all([approve(a), approve(b)]);
      expect(out.every((o) => o.success)).toBe(true);
      expect(await rows(u)).toHaveLength(1);
      expect(await coins(u)).toBe(1300);
    }
  });
});

describe('ডিপোজিট বোনাস হার — একই ইউজারের দুই ডিপোজিট একসাথে (ইউজার-সারি FOR UPDATE)', () => {
  test('বোনাস [১০০%, ৫০%] (শুক্রবারে ৮০%); দুটো ১০০% কখনো নয় — ১২ ট্রায়াল', async () => {
    const second = businessTime.businessWeekday() === 5 ? 1000 * 0.8 : 1000 * 0.5;
    for (let i = 0; i < 12; i++) {
      const u = await mk();
      const [a, b] = [await makeDeposit(u, 1000, { wantBonus: true }), await makeDeposit(u, 1000, { wantBonus: true })];
      const out = await Promise.all([approve(a), approve(b)]);
      expect(out.every((o) => o.success)).toBe(true);
      const bonuses = (await pool.query(
        `SELECT amount FROM coin_transactions WHERE user_id=$1 AND type='deposit_bonus' ORDER BY amount DESC`, [u])).rows.map((r) => Number(r.amount));
      expect(bonuses).toEqual([1000, second]);
      expect(bonuses.filter((x) => x === 1000)).toHaveLength(1);
      expect(await rows(u)).toHaveLength(0); // want_bonus ডিপোজিটে ফ্রি বেট নেই
    }
  });
});

describe('ক্লেইম — টার্নওভার free_bet_turnover_multiplier (শুধু first_deposit সারিতে)', () => {
  let saved;
  beforeAll(async () => { saved = await raw('free_bet_turnover_multiplier'); });
  afterAll(async () => { await setRaw('free_bet_turnover_multiplier', saved); });

  const bonusRow = async (u, type) => (await pool.query(
    `SELECT * FROM bonuses WHERE user_id = $1 AND bonus_type = $2 ORDER BY id DESC LIMIT 1`, [u, type])).rows[0];

  test('ক্লেইমে ৩x (সেটিং-এর মান); ব্যালেন্স +৩০', async () => {
    await setRaw('free_bet_turnover_multiplier', '3');
    const u = await mk();
    await approve(await makeDeposit(u, 500));
    const fb = (await rows(u))[0];
    const res = await freebet.claimFreeBet(u, fb.id);
    expect(res.success).toBe(true);
    expect(await coins(u)).toBe(530);
    const b = await bonusRow(u, 'free_bet');
    expect(Number(b.bonus_amount)).toBe(30);
    expect(Number(b.sports_required)).toBe(90);
    expect(Number(b.casino_required)).toBe(90);
    expect(b.status).toBe('active');
  });

  test('সেটিং বদলালে নতুন গুণক (৪x); সারি না থাকলে ডিফল্ট ৩x', async () => {
    await setRaw('free_bet_turnover_multiplier', '4');
    const u1 = await mk();
    await approve(await makeDeposit(u1, 500));
    await freebet.claimFreeBet(u1, (await rows(u1))[0].id);
    expect(Number((await bonusRow(u1, 'free_bet')).sports_required)).toBe(120);

    await setRaw('free_bet_turnover_multiplier', null);
    const u2 = await mk();
    await approve(await makeDeposit(u2, 500));
    await freebet.claimFreeBet(u2, (await rows(u2))[0].id);
    expect(Number((await bonusRow(u2, 'free_bet')).sports_required)).toBe(90);
  });

  test('অন্য ফ্রি বেট (first_deposit নয়) আগের নিয়মে — free_bet টাইপ নয়', async () => {
    await setRaw('free_bet_turnover_multiplier', '3');
    const u = await mk();
    await freebet.grantFreeBet(u, 50, 'reward_x');
    const fb = (await rows(u, 'reward_x'))[0];
    expect((await freebet.claimFreeBet(u, fb.id)).success).toBe(true);
    expect(await bonusRow(u, 'free_bet')).toBeUndefined();
    expect(await bonusRow(u, 'deposit')).toBeDefined();
  });

  test('সিড SQL: সারি না থাকলে ৩ বসে, থাকলে ON CONFLICT DO NOTHING-এ অক্ষত', async () => {
    const sql = `INSERT INTO site_settings (key, value) VALUES ('free_bet_turnover_multiplier', '3') ON CONFLICT (key) DO NOTHING`;
    await pool.query(`DELETE FROM site_settings WHERE key='free_bet_turnover_multiplier'`);
    await pool.query(sql);
    expect(await raw('free_bet_turnover_multiplier')).toBe('3');
    await pool.query(`UPDATE site_settings SET value='7' WHERE key='free_bet_turnover_multiplier'`);
    await pool.query(sql);
    expect(await raw('free_bet_turnover_multiplier')).toBe('7');
  });
});

describe('অ্যাডমিন ফ্রি বেট — reason admin:<id>:<র‍্যান্ডম>', () => {
  test('একই ইউজারকে একাধিকবার দেওয়া যায়; প্রতিবার ইউনিক reason; বিদ্যমান "admin" সারি অক্ষত', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    const adminId = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0].id;
    users.push(adminId);
    await pool.query("UPDATE users SET role='admin' WHERE id=$1", [adminId]);

    const target = await mk();
    await pool.query(`INSERT INTO free_bets (user_id, amount, reason, status) VALUES ($1, 11, 'admin', 'active')`, [target]);
    for (const amount of [20, 25]) {
      const res = await agent.post(`/admin/users/${target}/freebet`).type('form').send({ _csrf: token, amount: String(amount) });
      expect([200, 302]).toContain(res.status);
    }
    const all = (await pool.query(`SELECT reason, amount FROM free_bets WHERE user_id=$1 ORDER BY id`, [target])).rows;
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ reason: 'admin' });
    expect(Number(all[0].amount)).toBe(11);
    const re = new RegExp(`^admin:${adminId}:[0-9a-f]{8}$`);
    expect(all[1].reason).toMatch(re);
    expect(all[2].reason).toMatch(re);
    expect(all[1].reason).not.toBe(all[2].reason);
    expect(all.slice(1).map((r) => Number(r.amount))).toEqual([20, 25]);
  });
});
