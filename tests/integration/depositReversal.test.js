// ==================== ডিপোজিট রিভার্সাল (আসল Postgres) ====================
// POST /admin/api/deposits/:id/reverse — permission deposit_reverse, কারণ বাধ্যতামূলক, একই transaction + সারি-লক।
// বেটিং/সেটেলমেন্ট/গেটওয়ে/ডিপোজিট-অনুমোদন হিসাব এখানে বদলানো হয়নি — শুধু বিদ্যমান approve চালিয়ে ফল যাচাই।
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const rbac = require('../../services/rbac');
const { approvePaymentRequestById } = require('../../routes/payment');
const { grantFreeBet } = require('../../services/freebet');
const { reverseDeposit } = require('../../services/depositReversal');
const { makeUser: rawDbUser, makeDeposit, coins, cleanup } = require('../helpers/referralDeposit');

// তৈরি সব ইউজার ট্র্যাক — শেষে সাফ (deposit_reversals আগে, কারণ payment_requests/users-এর FK)
const created = [];
const dbUser = async (...a) => { const id = await rawDbUser(...a); created.push(id); return id; };

async function makeAgentUser({ admin = false } = {}) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  if (admin) await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  created.push(row.id);
  return { agent, token, username, userId: row.id };
}

const reverse = (admin, id, body) =>
  admin.agent.post(`/admin/api/deposits/${id}/reverse`).set('X-CSRF-Token', admin.token).send(body);
const statusOf = async (id) => (await pool.query('SELECT status FROM payment_requests WHERE id=$1', [id])).rows[0].status;
const revRows = async (id) => (await pool.query('SELECT * FROM deposit_reversals WHERE deposit_id=$1', [id])).rows;
const setCoins = (uid, v) => pool.query('UPDATE users SET coins=$1 WHERE id=$2', [v, uid]);

// নতুন ইউজার + approved ডিপোজিট (want_bonus সহ: প্রথম ডিপোজিটে ১০০% বোনাস)
async function approvedDeposit(amount, { wantBonus = true } = {}) {
  const uid = await dbUser('rev');
  const dep = await makeDeposit(uid, amount, { status: 'pending', wantBonus });
  const r = await approvePaymentRequestById(dep);
  expect(r.success).toBe(true);
  return { uid, dep };
}

describe('ডিপোজিট রিভার্সাল', () => {
  jest.setTimeout(120000);
  let admin;
  beforeAll(async () => { admin = await makeAgentUser({ admin: true }); });
  afterAll(async () => {
    await pool.query('DELETE FROM deposit_reversals WHERE user_id = ANY($1::int[]) OR admin_id = ANY($1::int[])', [created]);
    await cleanup(created);
  });

  test('একবার রিভার্স: স্ট্যাটাস reversed, ডিপোজিট+বোনাস কাটা, রেকর্ড ও অডিট লগ (অ্যাডমিন, কারণ, আগের/পরের অবস্থা)', async () => {
    const { uid, dep } = await approvedDeposit(1000);
    expect(await coins(uid)).toBe(2000); // ১০০০ + ১০০% প্রথম-ডিপোজিট বোনাস
    const res = await reverse(admin, dep, { reason: 'ভুয়া TrxID যাচাইয়ে ধরা পড়েছে' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await statusOf(dep)).toBe('reversed');
    expect(await coins(uid)).toBe(0);
    const [row] = await revRows(dep);
    expect(row.admin_id).toBe(admin.userId);
    expect(row.reason).toBe('ভুয়া TrxID যাচাইয়ে ধরা পড়েছে');
    expect([row.old_status, row.new_status]).toEqual(['approved', 'reversed']);
    expect(Number(row.balance_before)).toBe(2000);
    expect(Number(row.balance_after)).toBe(0);
    expect(row.due_status).toBe('none');
    const tx = await pool.query(`SELECT type, amount FROM coin_transactions WHERE user_id=$1 AND type IN ('deposit_reversal','bonus_forfeit') ORDER BY type`, [uid]);
    expect(tx.rows.map((r) => [r.type, Number(r.amount)])).toEqual([['bonus_forfeit', -1000], ['deposit_reversal', -1000]]);
    const al = await pool.query(`SELECT details FROM admin_logs WHERE admin_id=$1 AND action_type='deposit_reverse' AND details LIKE $2`, [admin.userId, `%#${dep}%`]);
    expect(al.rows.length).toBe(1);
    const au = await pool.query(`SELECT details, actor_id FROM audit_logs WHERE action='DEPOSIT_REVERSED' AND details->>'deposit_id' = $1`, [String(dep)]);
    expect(au.rows.length).toBe(1);
    expect(au.rows[0].details.old_status).toBe('approved');
    expect(au.rows[0].details.new_status).toBe('reversed');
    expect(au.rows[0].details.reason).toBe('ভুয়া TrxID যাচাইয়ে ধরা পড়েছে');
  });

  test('দ্বিগুণ রিভার্স: দ্বিতীয়বার 409, ব্যালেন্স/রেকর্ড অপরিবর্তিত', async () => {
    const { uid, dep } = await approvedDeposit(500, { wantBonus: false });
    await setCoins(uid, 900);
    expect((await reverse(admin, dep, { reason: 'প্রথম' })).status).toBe(200);
    const after = await coins(uid);
    expect(after).toBe(400);
    const second = await reverse(admin, dep, { reason: 'দ্বিতীয়' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_reversed');
    expect(await coins(uid)).toBe(after);
    expect((await revRows(dep)).length).toBe(1);
  });

  test('ব্যালেন্স ঋণাত্মক হয় না: যা আছে কাটে, বাকি বকেয়া (open); require_full হলে অস্বীকৃত ও কিছুই বদলায় না', async () => {
    const { uid, dep } = await approvedDeposit(1000, { wantBonus: false });
    await setCoins(uid, 300); // ইউজার বাকিটা খেলে ফেলেছে
    const denied = await reverse(admin, dep, { reason: 'পরীক্ষা', require_full: true });
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe('insufficient_balance');
    expect(await statusOf(dep)).toBe('approved');
    expect(await coins(uid)).toBe(300);
    expect((await revRows(dep)).length).toBe(0);

    const ok = await reverse(admin, dep, { reason: 'পরীক্ষা' });
    expect(ok.status).toBe(200);
    expect(await coins(uid)).toBe(0);
    expect(ok.body.dueAmount).toBe(700);
    const [row] = await revRows(dep);
    expect(Number(row.due_amount)).toBe(700);
    expect(row.due_status).toBe('open');
    expect(await statusOf(dep)).toBe('reversed');
  });

  test('ব্যালেন্স ০ হলেও ঋণাত্মক নয়; পুরোটাই বকেয়া', async () => {
    const { uid, dep } = await approvedDeposit(400, { wantBonus: false });
    await setCoins(uid, 0);
    const ok = await reverse(admin, dep, { reason: 'শূন্য ব্যালেন্স' });
    expect(ok.status).toBe(200);
    expect(await coins(uid)).toBe(0);
    expect(ok.body.dueAmount).toBe(400);
  });

  test('active ডিপোজিট বোনাস forfeited (ডিপোজিট-বোনাস ডিপোজিটে a5-তে ফ্রি বেট দেওয়া হয় না)', async () => {
    const uid = await dbUser('revbon');
    const dep = await makeDeposit(uid, 1000, { status: 'pending', wantBonus: true });
    expect((await approvePaymentRequestById(dep)).success).toBe(true);
    expect((await pool.query(`SELECT 1 FROM free_bets WHERE user_id=$1`, [uid])).rowCount).toBe(0);
    const bonusBefore = (await pool.query(`SELECT status, deposit_id FROM deposit_turnovers WHERE user_id=$1 AND source='deposit'`, [uid])).rows;
    expect(bonusBefore).toEqual([{ status: 'active', deposit_id: dep }]);
    const res = await reverse(admin, dep, { reason: 'বোনাস-অপব্যবহার' });
    expect(res.status).toBe(200);
    const bonusAfter = (await pool.query(`SELECT status FROM deposit_turnovers WHERE user_id=$1 AND source='deposit'`, [uid])).rows;
    expect(bonusAfter.map((b) => b.status)).toEqual(['forfeited']);
    expect(res.body.cancelledBonusIds.length).toBe(1);
    expect(res.body.cancelledFreeBetIds.length).toBe(0);
    expect(await coins(uid)).toBe(0);
  });

  test('অ্যাক্টিভ first_deposit ফ্রি বেট বাতিল (cancelled); ফ্রি বেট দেওয়া ডিপোজিট না হলে অপরিবর্তিত', async () => {
    const uid = await dbUser('revfb');
    const small = await makeDeposit(uid, 200, { status: 'pending', wantBonus: false }); // <৫০০ → ফ্রি বেট নেই
    expect((await approvePaymentRequestById(small)).success).toBe(true);
    const dep = await makeDeposit(uid, 1000, { status: 'pending', wantBonus: false });
    expect((await approvePaymentRequestById(dep)).success).toBe(true);
    expect((await pool.query(`SELECT status FROM free_bets WHERE user_id=$1 AND reason='first_deposit'`, [uid])).rows.map((f) => f.status)).toEqual(['active']);
    // ছোট (ফ্রি-বেট-না-দেওয়া) ডিপোজিট রিভার্সে ফ্রি বেট অক্ষত
    expect((await reverse(admin, small, { reason: 'ছোটটা' })).status).toBe(200);
    expect((await pool.query(`SELECT status FROM free_bets WHERE user_id=$1 AND reason='first_deposit'`, [uid])).rows.map((f) => f.status)).toEqual(['active']);
    const res = await reverse(admin, dep, { reason: 'ফ্রি বেট বাতিল' });
    expect(res.status).toBe(200);
    expect((await pool.query(`SELECT status FROM free_bets WHERE user_id=$1 AND reason='first_deposit'`, [uid])).rows.map((f) => f.status)).toEqual(['cancelled']);
    expect(res.body.cancelledFreeBetIds.length).toBe(1);
  });

  test('ক্লেইম হয়ে যাওয়া ফ্রি বেট: bonus_forfeit-ধাঁচে কাটা, ঋণাত্মক নয়', async () => {
    const uid = await dbUser('revfbused');
    const dep = await makeDeposit(uid, 1000, { status: 'pending', wantBonus: false });
    expect((await approvePaymentRequestById(dep)).success).toBe(true);
    const fbRow = (await pool.query(`SELECT id, amount FROM free_bets WHERE user_id=$1 AND reason='first_deposit'`, [uid])).rows[0];
    const fbAmt = Number(fbRow.amount);
    const { claimFreeBet } = require('../../services/freebet');
    expect((await claimFreeBet(uid, fbRow.id)).success).toBe(true);
    expect(await coins(uid)).toBe(1000 + fbAmt);
    await setCoins(uid, 1000 + fbAmt - 50); // ৫০ বকেয়া হবে
    const res = await reverse(admin, dep, { reason: 'ক্লেইমের পরে রিভার্স' });
    expect(res.status).toBe(200);
    expect(await coins(uid)).toBe(0);
    expect(res.body.dueAmount).toBe(50);
    expect((await pool.query(`SELECT status FROM free_bets WHERE id=$1`, [fbRow.id])).rows[0].status).toBe('reversed');
    expect((await pool.query(`SELECT status FROM deposit_turnovers WHERE user_id=$1 AND source='free_bet'`, [uid])).rows.map((b) => b.status)).toEqual(['forfeited']);
  });

  test('কারণ ছাড়া বা শুধু ফাঁকা কারণে 400, কিছুই বদলায় না', async () => {
    const { uid, dep } = await approvedDeposit(300, { wantBonus: false });
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const r = await reverse(admin, dep, body);
      expect(r.status).toBe(400);
    }
    expect(await statusOf(dep)).toBe('approved');
    expect(await coins(uid)).toBe(300);
    expect((await revRows(dep)).length).toBe(0);
  });

  test('পারমিশন ছাড়া অস্বীকৃত (403); শুধু bonus_manage-ও যথেষ্ট নয়; deposit_reverse থাকলে গৃহীত', async () => {
    const { uid, dep } = await approvedDeposit(200, { wantBonus: false });
    const limited = await makeAgentUser({ admin: true });
    const none = await rbac.createRole({ name: `NoRev-${uniqueUsername()}`, permissions: {} });
    await rbac.assignUserRole(limited.userId, none.key);
    const r1 = await reverse(limited, dep, { reason: 'x' });
    expect(r1.status).toBe(403);
    const bm = await rbac.createRole({ name: `BM-${uniqueUsername()}`, permissions: { bonus_manage: true } });
    await rbac.assignUserRole(limited.userId, bm.key);
    expect((await reverse(limited, dep, { reason: 'x' })).status).toBe(403);
    expect(await statusOf(dep)).toBe('approved');
    expect(await coins(uid)).toBe(200);
    const ok = await rbac.createRole({ name: `Rev-${uniqueUsername()}`, permissions: { deposit_reverse: true } });
    await rbac.assignUserRole(limited.userId, ok.key);
    expect((await reverse(limited, dep, { reason: 'অনুমোদিত অ্যাডমিন' })).status).toBe(200);
    expect(await statusOf(dep)).toBe('reversed');
  });

  test('concurrent দুই রিভার্সে একটাই কার্যকর (৮ ট্রায়াল)', async () => {
    for (let i = 0; i < 8; i++) {
      const { uid, dep } = await approvedDeposit(600, { wantBonus: false });
      await setCoins(uid, 1000);
      const [a, b] = await Promise.all([
        reverseDeposit({ depositId: dep, adminId: admin.userId, reason: 'এ' }),
        reverseDeposit({ depositId: dep, adminId: admin.userId, reason: 'বি' })
      ]);
      expect([a.result, b.result].sort()).toEqual(['already_reversed', 'reversed']);
      expect(await coins(uid)).toBe(400); // ৬০০ একবারই কাটা
      expect((await revRows(dep)).length).toBe(1);
    }
  });

  test('HTTP-তে concurrent দুই রিভার্স: একটা 200, অন্যটা 409', async () => {
    const { uid, dep } = await approvedDeposit(250, { wantBonus: false });
    await setCoins(uid, 1000);
    const rs = await Promise.all([reverse(admin, dep, { reason: 'এ' }), reverse(admin, dep, { reason: 'বি' })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await coins(uid)).toBe(750);
  });

  test('pending / rejected / অনুপস্থিত ডিপোজিটে রিভার্স অস্বীকৃত', async () => {
    const uid = await dbUser('revpend');
    const pend = await makeDeposit(uid, 100, { status: 'pending' });
    const rej = await makeDeposit(uid, 100, { status: 'rejected' });
    const rp = await reverse(admin, pend, { reason: 'x' });
    expect(rp.status).toBe(409);
    expect(rp.body.error).toBe('not_approved');
    expect((await reverse(admin, rej, { reason: 'x' })).status).toBe(409);
    expect(await statusOf(pend)).toBe('pending');
    expect(await statusOf(rej)).toBe('rejected');
    expect((await reverse(admin, 999999999, { reason: 'x' })).status).toBe(404);
    expect((await pool.query('SELECT 1 FROM deposit_reversals WHERE deposit_id = ANY($1::int[])', [[pend, rej]])).rows.length).toBe(0);
  });

  test('রেফারেল বোনাস পেআউট শুধু তালিকায় আসে — স্বয়ংক্রিয় কাটা নয়', async () => {
    const { uid, dep } = await approvedDeposit(1000, { wantBonus: false });
    const referrer = await dbUser('revref', { coins: 500 });
    await pool.query(
      `INSERT INTO referral_rewards (referred_user_id, referrer_id, status, tier, amount, qualifying_deposit_id, paid_at)
       VALUES ($1,$2,'paid',1,100,$3,NOW())`, [uid, referrer, dep]);
    const res = await reverse(admin, dep, { reason: 'রেফারেল-সহ' });
    expect(res.status).toBe(200);
    expect(res.body.referralPayouts.length).toBe(1);
    expect(res.body.referralPayouts[0]).toMatchObject({ referrer_id: referrer, referred_user_id: uid, status: 'paid', amount: 100 });
    expect(await coins(referrer)).toBe(500); // অপরিবর্তিত
    expect((await pool.query('SELECT status FROM referral_rewards WHERE referred_user_id=$1', [uid])).rows[0].status).toBe('paid');
    expect((await revRows(dep))[0].referral_payouts.length).toBe(1);
  });
});
