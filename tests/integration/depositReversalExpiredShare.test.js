// ==================== expireDue-র সারি-ভিত্তিক কাটা-ভাগ (expired_deducted) × ডিপোজিট রিভার্সাল (আসল Postgres) ====================
// expireDue মেয়াদ-শেষে min(মোট বোনাস, ব্যালেন্স) একটাই bonus_forfeit-এ কাটে (মোট অপরিবর্তিত) এবং প্রতিটি সারির
// expired_deducted-এ তার ভাগ লেখে। reverseDeposit expired সারিতে bonus_amount − COALESCE(expired_deducted, bonus_amount) কাটে।
const { pool } = require('../../db');
const { approvePaymentRequestById } = require('../../routes/payment');
const { reverseDeposit } = require('../../services/depositReversal');
const { expireDue } = require('../../services/turnover');
const { makeUser, makeDeposit, coins, cleanup } = require('../helpers/referralDeposit');

const users = [];
let adminId;
const mk = async (p, o) => { const id = await makeUser(p, o); users.push(id); return id; };
const setCoins = (uid, v) => pool.query('UPDATE users SET coins=$1 WHERE id=$2', [v, uid]);
const cents = (v) => Math.round(Number(v) * 100);
const forfeitTx = async (uid) => (await pool.query(
  `SELECT amount, description FROM coin_transactions WHERE user_id=$1 AND type='bonus_forfeit' ORDER BY id`, [uid]
)).rows.map((r) => ({ amount: Number(r.amount), description: r.description }));
const turnoverRow = async (uid, dep) => (await pool.query(
  `SELECT status, bonus_amount, expired_deducted FROM deposit_turnovers WHERE user_id=$1 AND deposit_id=$2`, [uid, dep]
)).rows[0];
const runExpire = async (uid) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const n = await expireDue(client, uid);
    await client.query('COMMIT');
    return n;
  } finally { client.release(); }
};
const rev = async (dep) => (await pool.query(
  'SELECT deducted_bonus, deducted_deposit, due_amount, due_status FROM deposit_reversals WHERE deposit_id=$1', [dep])).rows[0];

// ১০০০ ডিপোজিট + ১০০% প্রথম-বোনাস (বোনাস ১০০০) অনুমোদন → মেয়াদ পার করে expireDue চালায়; ব্যালেন্স expireDue-র আগে balBeforeExpire-এ নামায়।
async function approvedThenExpired(prefix, balBeforeExpire) {
  const uid = await mk(prefix);
  const dep = await makeDeposit(uid, 1000, { status: 'pending', wantBonus: true });
  expect((await approvePaymentRequestById(dep)).success).toBe(true);
  expect(await coins(uid)).toBe(2000);
  await pool.query(`UPDATE deposit_turnovers SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id=$1 AND deposit_id=$2`, [uid, dep]);
  await setCoins(uid, balBeforeExpire);
  expect(await runExpire(uid)).toBe(1);
  return { uid, dep };
}

describe('expireDue expired_deducted × রিভার্সাল', () => {
  jest.setTimeout(120000);
  beforeAll(async () => { adminId = await mk('revshadm'); });
  afterAll(async () => {
    await pool.query('DELETE FROM deposit_reversals WHERE user_id = ANY($1::int[]) OR admin_id = ANY($1::int[])', [users]);
    await cleanup(users);
  });

  test('(ক) expired, ব্যালেন্স যথেষ্ট → expired_deducted = পুরো বোনাস; রিভার্সালে বোনাস আর কাটে না', async () => {
    const { uid, dep } = await approvedThenExpired('revsha', 2000);
    const row = await turnoverRow(uid, dep);
    expect([row.status, Number(row.bonus_amount), Number(row.expired_deducted)]).toEqual(['expired', 1000, 1000]);
    expect(await coins(uid)).toBe(1000);
    await setCoins(uid, 1500);

    const r = await reverseDeposit({ depositId: dep, adminId, reason: 'পরীক্ষা (ক)' });
    expect(r.result).toBe('reversed');
    expect(r.deductedBonus).toBe(0);
    expect(r.deductedDeposit).toBe(1000);
    expect(r.dueAmount).toBe(0);
    expect(await coins(uid)).toBe(500);
    expect(await forfeitTx(uid)).toEqual([{ amount: -1000, description: 'টার্নওভারের মেয়াদ শেষ — বোনাস বাতিল' }]);
  });

  test('(খ১) expired, ব্যালেন্স কম (আংশিক ৪০০/১০০০) → রিভার্সালে বাকি ৬০০ কাটে; ওয়ালেট ঠিক', async () => {
    const { uid, dep } = await approvedThenExpired('revshb1', 400);
    const row = await turnoverRow(uid, dep);
    expect(Number(row.expired_deducted)).toBe(400);
    expect(await coins(uid)).toBe(0);
    expect(await forfeitTx(uid)).toEqual([{ amount: -400, description: 'টার্নওভারের মেয়াদ শেষ — বোনাস বাতিল' }]);
    await setCoins(uid, 2000); // পরে অন্য উৎস থেকে ব্যালেন্স

    const r = await reverseDeposit({ depositId: dep, adminId, reason: 'পরীক্ষা (খ১)' });
    expect(r.result).toBe('reversed');
    expect(r.deductedBonus).toBe(600);     // বাকি বোনাস
    expect(r.deductedDeposit).toBe(1000);
    expect(r.dueAmount).toBe(0);
    expect(r.balanceAfter).toBe(400);
    expect(await coins(uid)).toBe(400);
    const tx = await forfeitTx(uid);
    expect(tx.map((x) => x.amount)).toEqual([-400, -600]);
    expect(tx.reduce((s, x) => s - x.amount, 0)).toBe(1000); // মেয়াদে + রিভার্সালে মিলে ঠিক একবার পুরো বোনাস
  });

  test('(খ২) expired আংশিক, রিভার্সালেও ব্যালেন্স কম → যা আছে কাটে, বাকিটা due_amount-এ; ওয়ালেট কখনো ঋণাত্মক নয়', async () => {
    const { uid, dep } = await approvedThenExpired('revshb2', 400);
    await setCoins(uid, 1000);
    const r = await reverseDeposit({ depositId: dep, adminId, reason: 'পরীক্ষা (খ২)' });
    expect(r.result).toBe('reversed');
    expect(r.deductedBonus).toBe(600);
    expect(r.deductedDeposit).toBe(400);
    expect(r.dueAmount).toBe(600);
    expect(await coins(uid)).toBe(0);
    const d = await rev(dep);
    expect([Number(d.deducted_bonus), Number(d.deducted_deposit), Number(d.due_amount), d.due_status]).toEqual([600, 400, 600, 'open']);
  });

  test('(গ) একাধিক সারি একসাথে মেয়াদ-শেষ, ব্যালেন্স কম → ভাগের যোগফল = কাটা মোট (পয়সার রাউন্ডিং মিলিয়ে)', async () => {
    const uid = await mk('revshc', { coins: 500 });
    const amounts = ['333.33', '333.33', '333.34']; // মোট ১০০০; কাটা ৫০০ ⇒ অসমান ভাগ
    for (const a of amounts) {
      await pool.query(
        `INSERT INTO deposit_turnovers (user_id, source, deposit_amount, bonus_amount, multiplier, required, status, expires_at)
         VALUES ($1, 'bonus', 0, $2, 1, $2, 'active', NOW() - INTERVAL '1 hour')`, [uid, a]);
    }
    expect(await runExpire(uid)).toBe(3);
    const rows = (await pool.query(
      `SELECT id, bonus_amount, expired_deducted, status FROM deposit_turnovers WHERE user_id=$1 ORDER BY id`, [uid])).rows;
    expect(rows.every((x) => x.status === 'expired')).toBe(true);
    const sumC = rows.reduce((s, x) => s + cents(x.expired_deducted), 0);
    expect(sumC).toBe(50000);                       // যোগফল = কাটা মোট
    expect(await coins(uid)).toBe(0);
    expect(await forfeitTx(uid)).toEqual([{ amount: -500, description: 'টার্নওভারের মেয়াদ শেষ — বোনাস বাতিল' }]);
    expect(rows.map((x) => cents(x.expired_deducted))).toEqual([16666, 16666, 16668]); // শেষ সারি বাকিটা নেয়
    rows.forEach((x) => expect(cents(x.expired_deducted)).toBeLessThanOrEqual(cents(x.bonus_amount)));
  });

  test('(গ২) একাধিক সারি, ব্যালেন্স যথেষ্ট → প্রতিটি সারি তার পুরো bonus_amount', async () => {
    const uid = await mk('revshc2', { coins: 5000 });
    for (const a of ['300', '700.50']) {
      await pool.query(
        `INSERT INTO deposit_turnovers (user_id, source, deposit_amount, bonus_amount, multiplier, required, status, expires_at)
         VALUES ($1, 'bonus', 0, $2, 1, $2, 'active', NOW() - INTERVAL '1 hour')`, [uid, a]);
    }
    expect(await runExpire(uid)).toBe(2);
    const rows = (await pool.query(`SELECT bonus_amount, expired_deducted FROM deposit_turnovers WHERE user_id=$1 ORDER BY id`, [uid])).rows;
    expect(rows.map((x) => [Number(x.bonus_amount), Number(x.expired_deducted)])).toEqual([[300, 300], [700.5, 700.5]]);
    expect(await coins(uid)).toBe(5000 - 1000.5);
  });

  test('(ঘ) expired_deducted NULL পুরোনো সারি → আগের আচরণ (রিভার্সালে বোনাস কাটে না)', async () => {
    const { uid, dep } = await approvedThenExpired('revshd', 400);
    await pool.query(`UPDATE deposit_turnovers SET expired_deducted = NULL WHERE user_id=$1 AND deposit_id=$2`, [uid, dep]);
    expect((await turnoverRow(uid, dep)).expired_deducted).toBeNull();
    await setCoins(uid, 1500);

    const r = await reverseDeposit({ depositId: dep, adminId, reason: 'পরীক্ষা (ঘ)' });
    expect(r.result).toBe('reversed');
    expect(r.deductedBonus).toBe(0);
    expect(r.deductedDeposit).toBe(1000);
    expect(r.dueAmount).toBe(0);
    expect(await coins(uid)).toBe(500);
    expect((await turnoverRow(uid, dep)).status).toBe('expired'); // অপরিবর্তিত
  });
});
