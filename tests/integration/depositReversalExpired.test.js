// ==================== রিভার্সাল × মেয়াদ-শেষ বোনাস: দ্বৈত-কাটা বন্ধ (আসল Postgres) ====================
// expireDue (services/turnover.js) মেয়াদ-শেষে বোনাস আগেই কাটে ও সারি 'expired' করে।
// reverseDeposit-এ ওই সারি expired হলে বোনাস দ্বিতীয়বার কাটা যাবে না (forfeited-এর মতোই)।
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

async function approvedWithBonus(prefix) {
  const uid = await mk(prefix);
  const dep = await makeDeposit(uid, 1000, { status: 'pending', wantBonus: true });
  expect((await approvePaymentRequestById(dep)).success).toBe(true);
  expect(await coins(uid)).toBe(2000); // ১০০০ + ১০০% প্রথম-ডিপোজিট বোনাস
  return { uid, dep };
}

describe('রিভার্সাল: মেয়াদ-শেষ বোনাসের দ্বৈত-কাটা', () => {
  jest.setTimeout(120000);
  beforeAll(async () => { adminId = await mk('revexpadm'); });
  afterAll(async () => {
    await pool.query('DELETE FROM deposit_reversals WHERE user_id = ANY($1::int[]) OR admin_id = ANY($1::int[])', [users]);
    await cleanup(users);
  });

  test('(ক) active সারি → রিভার্সালে বোনাস একবার কাটে', async () => {
    const { uid, dep } = await approvedWithBonus('revexpa');
    await setCoins(uid, 2500); // ২০০০ + ৫০০ অন্য ব্যালেন্স
    const r = await reverseDeposit({ depositId: dep, adminId, reason: 'পরীক্ষা (ক)' });
    expect(r.result).toBe('reversed');
    expect(r.deductedBonus).toBe(1000);
    expect(r.deductedDeposit).toBe(1000);
    expect(r.dueAmount).toBe(0);
    expect(await coins(uid)).toBe(500);
    const t = (await pool.query(`SELECT status FROM deposit_turnovers WHERE user_id=$1 AND deposit_id=$2`, [uid, dep])).rows;
    expect(t.map((x) => x.status)).toEqual(['forfeited']);
    expect(await forfeitTx(uid)).toEqual([{ amount: -1000, description: `ডিপোজিট রিভার্সালে বোনাস বাতিল (#${dep})` }]);
  });

  test('(খ) expired সারি (মেয়াদে আগেই কাটা) → রিভার্সালে বোনাস আর কাটে না; ওয়ালেট ঠিক', async () => {
    const { uid, dep } = await approvedWithBonus('revexpb');
    await pool.query(`UPDATE deposit_turnovers SET expires_at = NOW() - INTERVAL '1 hour' WHERE user_id=$1 AND deposit_id=$2`, [uid, dep]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await expireDue(client, uid)).toBe(1);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(await coins(uid)).toBe(1000); // মেয়াদে বোনাস ১০০০ আগেই কাটা
    expect((await pool.query(`SELECT status FROM deposit_turnovers WHERE user_id=$1 AND deposit_id=$2`, [uid, dep])).rows[0].status).toBe('expired');
    await setCoins(uid, 1500); // ১০০০ + ৫০০ অন্য ব্যালেন্স

    const r = await reverseDeposit({ depositId: dep, adminId, reason: 'পরীক্ষা (খ)' });
    expect(r.result).toBe('reversed');
    expect(r.deductedBonus).toBe(0);      // দ্বিতীয়বার নয়
    expect(r.deductedDeposit).toBe(1000); // শুধু ডিপোজিট
    expect(r.dueAmount).toBe(0);
    expect(r.balanceBefore).toBe(1500);
    expect(r.balanceAfter).toBe(500);
    expect(await coins(uid)).toBe(500);
    expect((await pool.query(`SELECT status FROM deposit_turnovers WHERE user_id=$1 AND deposit_id=$2`, [uid, dep])).rows[0].status).toBe('expired'); // অপরিবর্তিত
    expect(r.cancelledBonusIds).toEqual([]);
    // বোনাস-কাটা মাত্র একটাই: মেয়াদ-শেষের; রিভার্সালের নয়
    expect(await forfeitTx(uid)).toEqual([{ amount: -1000, description: 'টার্নওভারের মেয়াদ শেষ — বোনাস বাতিল' }]);
    const [rev] = (await pool.query('SELECT deducted_bonus, due_amount, due_status FROM deposit_reversals WHERE deposit_id=$1', [dep])).rows;
    expect([Number(rev.deducted_bonus), Number(rev.due_amount), rev.due_status]).toEqual([0, 0, 'none']);
  });
});
