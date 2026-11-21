// ==================== ডিপোজিট রিভার্সাল হার্ডেনিং (আসল Postgres) ====================
// ক) রিভার্সের পরে "প্রথম" ১০০% বোনাস দ্বিতীয়বার নয়; খ) first_deposit ফ্রি বেট ইউনিক; গ) bonuses.deposit_id।
const { pool } = require('../db');
const { approvePaymentRequestById } = require('../routes/payment');
const { grantFreeBet } = require('../services/freebet');
const { reverseDeposit } = require('../services/depositReversal');
const { makeUser, makeDeposit, coins, cleanup } = require('./helpers/referralDeposit');

const IS_FRIDAY = new Date().getDay() === 5;
const SECOND_PCT = IS_FRIDAY ? 80 : 50;
const users = [];
let adminId;
const mk = async (p) => { const id = await makeUser(p); users.push(id); return id; };
const approve = async (uid, amount, wantBonus = true) => {
  const dep = await makeDeposit(uid, amount, { status: 'pending', wantBonus });
  expect((await approvePaymentRequestById(dep)).success).toBe(true);
  return dep;
};
const bonusTx = async (uid) => (await pool.query(
  `SELECT amount FROM coin_transactions WHERE user_id=$1 AND type='deposit_bonus' ORDER BY id`, [uid])).rows.map((r) => Number(r.amount));

describe('রিভার্সাল হার্ডেনিং', () => {
  jest.setTimeout(120000);
  beforeAll(async () => { adminId = await mk('revadm'); });
  afterAll(async () => {
    await pool.query('DELETE FROM deposit_reversals WHERE user_id = ANY($1::int[]) OR admin_id = ANY($1::int[])', [users]);
    await cleanup(users);
  });

  test('প্রথম-ডিপোজিট বোনাস পাওয়া ডিপোজিট রিভার্সের পরে পরের ডিপোজিটে ১০০% নেই', async () => {
    const uid = await mk('revfdb');
    const d1 = await approve(uid, 1000);
    expect(await bonusTx(uid)).toEqual([1000]); // প্রথম: ১০০%
    expect((await reverseDeposit({ depositId: d1, adminId, reason: 'পরীক্ষা' })).result).toBe('reversed');
    await approve(uid, 1000);
    expect(await bonusTx(uid)).toEqual([1000, 1000 * SECOND_PCT / 100]); // দ্বিতীয়বার ১০০% নয়
  });

  test('বোনাস ছাড়া রিভার্স হওয়া ডিপোজিটের পর ইউজার এখনও প্রথম বোনাসের যোগ্য (বোনাস আগে দেওয়াই হয়নি)', async () => {
    const uid = await mk('revnob');
    const d1 = await approve(uid, 500, false);
    expect((await reverseDeposit({ depositId: d1, adminId, reason: 'পরীক্ষা' })).result).toBe('reversed');
    await approve(uid, 1000);
    expect(await bonusTx(uid)).toEqual([1000]);
  });

  test('বিদ্যমান আচরণ অপরিবর্তিত: রিভার্স ছাড়া দ্বিতীয় ডিপোজিটে ৫০/৮০%', async () => {
    const uid = await mk('revnorm');
    await approve(uid, 1000);
    await approve(uid, 1000);
    expect(await bonusTx(uid)).toEqual([1000, 1000 * SECOND_PCT / 100]);
  });

  test('first_deposit ফ্রি বেট: রিভার্সে cancelled হলেও আবার দেওয়া যায় না (ইউনিক সারি), ঠিক একটিই', async () => {
    const uid = await mk('revfb');
    await grantFreeBet(uid, 100, 'first_deposit');
    const d1 = await approve(uid, 1000);
    await reverseDeposit({ depositId: d1, adminId, reason: 'পরীক্ষা' });
    await Promise.all([grantFreeBet(uid, 100, 'first_deposit'), grantFreeBet(uid, 100, 'first_deposit')]);
    const r = await pool.query(`SELECT status FROM free_bets WHERE user_id=$1 AND reason='first_deposit'`, [uid]);
    expect(r.rows.map((x) => x.status)).toEqual(['cancelled']);
  });

  test('নতুন ডিপোজিট বোনাসে deposit_id লেখা হয়', async () => {
    const uid = await mk('revdid');
    const d1 = await approve(uid, 800);
    const b = await pool.query(`SELECT deposit_id FROM bonuses WHERE user_id=$1 AND bonus_type='deposit'`, [uid]);
    expect(b.rows.map((x) => x.deposit_id)).toEqual([d1]);
  });

  test('রিভার্সাল deposit_id দিয়ে মেলায়: একই পরিমাণের দুই ডিপোজিটে সঠিকটার বোনাসই বাতিল', async () => {
    const uid = await mk('revmatch');
    const d1 = await approve(uid, 1000);          // বোনাস ১০০০ (১০০%)
    const d2 = await approve(uid, 2000);          // বোনাস ১০০০ (৫০%) বা ১৬০০ — তাই পরিমাণ একই রাখতে নিচে সরাসরি সারি বসাই
    await pool.query(`UPDATE bonuses SET bonus_amount = 1000 WHERE user_id=$1 AND deposit_id=$2`, [uid, d2]);
    await pool.query(`UPDATE coin_transactions SET amount = 1000 WHERE user_id=$1 AND type='deposit_bonus' AND description = $2`, [uid, `ডিপোজিট বোনাস (#${d2})`]);
    // সময় ইচ্ছাকৃত উল্টো — d1-এর বোনাস-সারি d2-এর tx-এর কাছাকাছি, যাতে শুধু সময়-মিল ভুল সারি ধরত
    await pool.query(`UPDATE bonuses SET created_at = NOW() + interval '1 hour' WHERE user_id=$1 AND deposit_id=$2`, [uid, d1]);
    const res = await reverseDeposit({ depositId: d2, adminId, reason: 'আইডি-মিল' });
    expect(res.result).toBe('reversed');
    const rows = (await pool.query(`SELECT deposit_id, status FROM bonuses WHERE user_id=$1 ORDER BY deposit_id`, [uid])).rows;
    expect(rows).toEqual([{ deposit_id: d1, status: 'active' }, { deposit_id: d2, status: 'forfeited' }]);
  });

  test('পুরোনো সারি (deposit_id NULL): বর্ণনা/সময় মিলিয়ে ফলব্যাক কাজ করে', async () => {
    const uid = await mk('revlegacy');
    const d1 = await approve(uid, 1000);
    await pool.query(`UPDATE bonuses SET deposit_id = NULL WHERE user_id=$1`, [uid]);
    const res = await reverseDeposit({ depositId: d1, adminId, reason: 'পুরোনো সারি' });
    expect(res.result).toBe('reversed');
    expect((await pool.query(`SELECT status FROM bonuses WHERE user_id=$1`, [uid])).rows.map((x) => x.status)).toEqual(['forfeited']);
    expect(await coins(uid)).toBe(0);
  });
});
