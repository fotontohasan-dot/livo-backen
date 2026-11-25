// ==================== expireDue আংশিক কাটা × ডিপোজিট রিভার্সাল (আসল Postgres) ====================
// expireDue প্রতি সারির নিজের ভাগ deposit_turnovers.expired_deducted-এ লেখে; রিভার্সালে expired সারির
// বাকি (bonus_amount − expired_deducted) স্বাভাবিক নিয়মে কাটে/বকেয়ায় যায়। NULL (পুরোনো সারি) = পুরো কাটা ধরা।
const { pool } = require('../../db');
const { approvePaymentRequestById } = require('../../routes/payment');
const { reverseDeposit } = require('../../services/depositReversal');
const { expireDue } = require('../../services/turnover');
const { makeUser, makeDeposit, coins, cleanup } = require('../helpers/referralDeposit');

const users = [];
let adminId;
const mk = async (p) => { const id = await makeUser(p); users.push(id); return id; };
const setCoins = (uid, v) => pool.query('UPDATE users SET coins=$1 WHERE id=$2', [v, uid]);
const forfeitTx = async (uid) => (await pool.query(
  `SELECT amount, description FROM coin_transactions WHERE user_id=$1 AND type='bonus_forfeit' ORDER BY id`, [uid]
)).rows.map((r) => ({ amount: Number(r.amount), description: r.description }));
const rowOf = async (uid, dep) => (await pool.query(
  `SELECT id, status, bonus_amount, expired_deducted FROM deposit_turnovers WHERE user_id=$1 AND deposit_id=$2`, [uid, dep])).rows[0];

async function approvedWithBonus(uid, amount = 1000) {
  const dep = await makeDeposit(uid, amount, { status: 'pending', wantBonus: true });
  expect((await approvePaymentRequestById(dep)).success).toBe(true);
  return dep;
}
async function runExpire(uid, depIds) {
  await pool.query(`UPDATE deposit_turnovers SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id=$1 AND deposit_id = ANY($2::int[])`, [uid, depIds]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const n = await expireDue(client, uid);
    await client.query('COMMIT');
    return n;
  } finally { client.release(); }
}

describe('রিভার্সাল: expired সারি — রেকর্ডকৃত কাটা পরিমাণ', () => {
  jest.setTimeout(120000);
  beforeAll(async () => { adminId = await mk('revpartadm'); });
  afterAll(async () => {
    await pool.query('DELETE FROM deposit_reversals WHERE user_id = ANY($1::int[]) OR admin_id = ANY($1::int[])', [users]);
    await cleanup(users);
  });

  test('(ক) expired, ব্যালেন্স যথেষ্ট → expired_deducted = পুরো বোনাস; রিভার্সালে বোনাস আর কাটে না', async () => {
    const uid = await mk('revpa');
    const dep = await approvedWithBonus(uid);
    expect(await runExpire(uid, [dep])).toBe(1);
    const row = await rowOf(uid, dep);
    expect([row.status, Number(row.expired_deducted)]).toEqual(['expired', 1000]);
    expect(await coins(uid)).toBe(1000);
    await setCoins(uid, 1500);
    const r = await reverseDeposit({ depositId: dep, adminId, reason: 'পরীক্ষা (ক)' });
    expect([r.deductedBonus, r.deductedDeposit, r.dueAmount, r.balanceAfter]).toEqual([0, 1000, 0, 500]);
    expect(await coins(uid)).toBe(500);
    expect(await forfeitTx(uid)).toEqual([{ amount: -1000, description: 'টার্নওভারের মেয়াদ শেষ — বোনাস বাতিল' }]);
  });

  test('(খ) expired, ব্যালেন্স কম (আংশিক কাটা) → রিভার্সালে বাকিটা কাটে; ওয়ালেট ঠিক, ঋণাত্মক নয়', async () => {
    const uid = await mk('revpb');
    const dep = await approvedWithBonus(uid);
    await setCoins(uid, 400); // ব্যালেন্স কম: মেয়াদে মাত্র ৪০০ কাটা যাবে (বোনাস ১০০০)
    expect(await runExpire(uid, [dep])).toBe(1);
    expect(Number((await rowOf(uid, dep)).expired_deducted)).toBe(400);
    expect(await coins(uid)).toBe(0);
    await setCoins(uid, 1500); // পরে জমা/জেতা ১৫০০
    const r = await reverseDeposit({ depositId: dep, adminId, reason: 'পরীক্ষা (খ)' });
    expect(r.result).toBe('reversed');
    expect(r.deductedBonus).toBe(600);    // বাকি বোনাস ১০০০−৪০০
    expect(r.deductedDeposit).toBe(900);  // ব্যালেন্সে বাকি ৯০০, ডিপোজিট ১০০০-এর মধ্যে ৯০০ কাটা
    expect(r.dueAmount).toBe(100);        // ডিপোজিটের ১০০ বকেয়া
    expect(await coins(uid)).toBe(0);
    const [rev] = (await pool.query('SELECT deducted_bonus, deducted_deposit, due_amount, due_status FROM deposit_reversals WHERE deposit_id=$1', [dep])).rows;
    expect([Number(rev.deducted_bonus), Number(rev.deducted_deposit), Number(rev.due_amount), rev.due_status]).toEqual([600, 900, 100, 'open']);
    expect((await forfeitTx(uid)).map((x) => x.amount)).toEqual([-400, -600]);
  });

  test('(গ) একাধিক সারি একসাথে মেয়াদ-শেষ, ব্যালেন্স কম → ভাগের যোগফল = কাটা মোট (রাউন্ডিংসহ)', async () => {
    const uid = await mk('revpc');
    const d1 = await approvedWithBonus(uid, 1000);
    const d2 = await approvedWithBonus(uid, 1000);
    const d3 = await approvedWithBonus(uid, 1000);
    const bonuses = (await pool.query(`SELECT bonus_amount FROM deposit_turnovers WHERE user_id=$1 AND status='active' ORDER BY id`, [uid])).rows.map((r) => Number(r.bonus_amount));
    const totalBonus = bonuses.reduce((s, b) => s + b, 0);
    expect(totalBonus).toBeGreaterThan(1000);
    await setCoins(uid, 1000); // মোট বোনাসের চেয়ে কম
    const before = (await pool.query(`SELECT COALESCE(SUM(-amount),0) AS s FROM coin_transactions WHERE user_id=$1 AND type='bonus_forfeit'`, [uid])).rows[0].s;
    expect(await runExpire(uid, [d1, d2, d3])).toBe(3);
    const rows = (await pool.query(`SELECT bonus_amount, expired_deducted FROM deposit_turnovers WHERE user_id=$1 ORDER BY id`, [uid])).rows;
    const shares = rows.map((r) => Number(r.expired_deducted));
    const sum = Math.round(shares.reduce((s, x) => s + x, 0) * 100) / 100;
    const tx = await forfeitTx(uid);
    expect(tx.length).toBe(1);                       // একটাই bonus_forfeit ট্রানজ্যাকশন
    expect(-tx[0].amount).toBe(sum);                 // যোগফল = কাটা মোট
    expect(sum).toBe(1000);                          // = min(মোট বোনাস, ব্যালেন্স)
    expect(await coins(uid)).toBe(0);
    shares.forEach((x, i) => { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(Number(rows[i].bonus_amount)); });
    // আনুপাতিক: প্রথম দুই সারি floor(১০০০ × বোনাস ÷ মোট) (সেন্টে), শেষ সারি বাকিটা (স্বাধীন হিসাবে মেলানো)
    const bc = bonuses.map((b) => Math.round(b * 100));
    const totC = bc.reduce((s, c) => s + c, 0);
    const exp = bc.map((c) => Math.floor((100000 * c) / totC));
    exp[exp.length - 1] = 100000 - exp.slice(0, -1).reduce((s, c) => s + c, 0);
    expect(shares.map((x) => Math.round(x * 100))).toEqual(exp);
    expect(new Set(bonuses).size).toBeGreaterThan(1); // বোনাস সমান নয়, তাই ভাগও অসমান — আনুপাতিকতা সত্যিই পরীক্ষিত
    expect(Number(before)).toBe(0);
  });

  test('(ঘ) expired_deducted NULL পুরোনো সারি → আগের আচরণ (পুরো কাটা ধরা, আর কাটে না)', async () => {
    const uid = await mk('revpd');
    const dep = await approvedWithBonus(uid);
    expect(await runExpire(uid, [dep])).toBe(1);
    await pool.query(`UPDATE deposit_turnovers SET expired_deducted = NULL WHERE user_id=$1 AND deposit_id=$2`, [uid, dep]); // পুরোনো সারির মতো
    await setCoins(uid, 1500);
    const r = await reverseDeposit({ depositId: dep, adminId, reason: 'পরীক্ষা (ঘ)' });
    expect([r.deductedBonus, r.deductedDeposit, r.dueAmount]).toEqual([0, 1000, 0]);
    expect(await coins(uid)).toBe(500);
  });
});
