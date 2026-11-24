// /admin/referrals — held (pending_review) বোনাসের approve/reject। আসল Postgres, আসল অ্যাপ।
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken } = require('../helpers/app');
const { pool } = require('../../db');
const rbac = require('../../services/rbac');
const { makeUser, link, makeDeposit, coins, reward, cleanup, uniq } = require('../helpers/referralDeposit');
const { runEngine } = require('../helpers/referralDeposit');

const created = [];

async function makeAdmin(perms) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const row = (await pool.query('SELECT id FROM users WHERE username=$1', [username])).rows[0];
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [row.id]);
  if (perms) {
    const role = await rbac.createRole({ name: `R-${uniq()}`, permissions: perms });
    await rbac.assignUserRole(row.id, role.key);
  }
  created.push(row.id);
  await agent.get('/lang/en');
  return { agent, userId: row.id };
}

async function csrf(agent) {
  const page = await agent.get('/admin/referrals?status=held');
  return extractCsrfToken(page.text);
}

// ডুপ্লিকেট পেমেন্ট-অ্যাকাউন্ট → pending_review (কোনো কয়েন নয়)
async function heldReward(depositAmount = 1000) {
  const referrer = await makeUser('rf');
  const referred = await makeUser('rd');
  created.push(referrer, referred);
  await link(referrer, referred);
  const acct = `shared_${uniq()}`;
  await makeDeposit(referrer, 600, { status: 'approved', account: acct });
  const out = await runEngine(referred, depositAmount, { account: acct });
  expect(out.outcome).toBe('pending_review');
  const rw = await reward(referred);
  expect(rw.status).toBe('pending_review');
  return { referrer, referred, rewardId: rw.id };
}

// Turnover V2: রেফারেল বোনাসের ওয়েজারিং-লক deposit_turnovers-এ (source='referral', বোনাস-অনলি এন্ট্রি)
const bonusRows = async (uid) => (await pool.query(`SELECT * FROM deposit_turnovers WHERE user_id=$1 AND source='referral'`, [uid])).rows;
// টোকেন আগে আনা হয় (agent কুকি রিকোয়েস্ট তৈরির সময়ই বসায়), তারপর POST গঠন।
const post = async (admin, id, action, body = {}) => {
  const _csrf = await csrf(admin.agent);
  return admin.agent.post(`/admin/referrals/${id}/${action}`).type('form').send({ ...body, _csrf });
};

afterAll(async () => {
  await pool.query('DELETE FROM audit_logs WHERE actor_id = ANY($1::int[])', [created]).catch(() => {});
  await pool.query('DELETE FROM admin_logs WHERE admin_id = ANY($1::int[])', [created]).catch(() => {});
  await cleanup(created);
});

describe('রেফারেল হোল্ড রিভিউ', () => {
  test('approve একবারই: কয়েন + bonuses (৫x টার্নওভার) + অডিট (অ্যাডমিন আইডি, পুরোনো→নতুন)', async () => {
    const admin = await makeAdmin({ bonus_manage: true, reports_view: true });
    const { referrer, referred, rewardId } = await heldReward(1000);
    expect(await coins(referrer)).toBe(0);

    const res = await post(admin, rewardId, 'approve');
    expect(res.status).toBe(302);

    const rw = await reward(referred);
    expect(rw.status).toBe('paid');
    expect(Number(rw.amount)).toBeGreaterThan(0);
    expect(rw.reviewed_by).toBe(admin.userId);
    expect(rw.reviewed_at).toBeTruthy();
    expect(await coins(referrer)).toBe(Number(rw.amount));
    const b = await bonusRows(referrer);
    expect(b).toHaveLength(1);
    const mult = Number(await require('../../services/settings').getSetting('turnover_multiplier')); // ডিফল্ট ৫
    expect(Number(b[0].bonus_amount)).toBe(Number(rw.amount));
    expect(Number(b[0].required)).toBe(Number(rw.amount) * mult);

    const audit = await pool.query(
      `SELECT details FROM audit_logs WHERE actor_id=$1 AND action='REFERRAL_BONUS_APPROVED'`, [admin.userId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toMatchObject({ reward_id: Number(rewardId), old_status: 'pending_review', new_status: 'paid' });
  });

  test('দ্বিগুণ approve: দ্বিতীয়বার কিছুই বদলায় না', async () => {
    const admin = await makeAdmin({ bonus_manage: true, reports_view: true });
    const { referrer, referred, rewardId } = await heldReward(1000);
    await post(admin, rewardId, 'approve');
    const after1 = await coins(referrer);
    await post(admin, rewardId, 'approve');
    expect(await coins(referrer)).toBe(after1);
    expect(await bonusRows(referrer)).toHaveLength(1);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM coin_transactions WHERE user_id=$1 AND type='referral_bonus'`, [referrer])).rows[0].n).toBe(1);
    expect((await reward(referred)).status).toBe('paid');
  });

  test('approve-পরে reject কার্যকর হয় না', async () => {
    const admin = await makeAdmin({ bonus_manage: true, reports_view: true });
    const { referrer, referred, rewardId } = await heldReward(1000);
    await post(admin, rewardId, 'approve');
    const c = await coins(referrer);
    await post(admin, rewardId, 'reject', { reason: 'too late' });
    expect((await reward(referred)).status).toBe('paid');
    expect(await coins(referrer)).toBe(c);
  });

  test('reject-এ কারণ ছাড়া ৪০০; স্ট্যাটাস অপরিবর্তিত', async () => {
    const admin = await makeAdmin({ bonus_manage: true, reports_view: true });
    const { referrer, referred, rewardId } = await heldReward(1000);
    const token = await csrf(admin.agent);
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await admin.agent.post(`/admin/referrals/${rewardId}/reject`)
        .set('Accept', 'application/json').type('form').send({ ...body, _csrf: token });
      expect(res.status).toBe(400);
    }
    expect((await reward(referred)).status).toBe('pending_review');
    expect(await coins(referrer)).toBe(0);
  });

  test('reject (কারণসহ): ব্যালেন্স অপরিবর্তিত, bonuses নেই, অ্যাডমিন আইডি+সময়+কারণ রেকর্ডে ও অডিটে', async () => {
    const admin = await makeAdmin({ bonus_manage: true, reports_view: true });
    const { referrer, referred, rewardId } = await heldReward(1000);
    const before = await coins(referrer);
    const res = await post(admin, rewardId, 'reject', { reason: 'একই ডিভাইস, জালিয়াতি সন্দেহ' });
    expect(res.status).toBe(302);
    const rw = await reward(referred);
    expect(rw.status).toBe('rejected');
    expect(rw.reviewed_by).toBe(admin.userId);
    expect(rw.reviewed_at).toBeTruthy();
    expect(rw.review_note).toBe('একই ডিভাইস, জালিয়াতি সন্দেহ');
    expect(await coins(referrer)).toBe(before);
    expect(await bonusRows(referrer)).toHaveLength(0);
    const audit = await pool.query(
      `SELECT details FROM audit_logs WHERE actor_id=$1 AND action='REFERRAL_BONUS_REJECTED'`, [admin.userId]);
    expect(audit.rows[0].details).toMatchObject({ old_status: 'pending_review', new_status: 'rejected', reason: 'একই ডিভাইস, জালিয়াতি সন্দেহ' });
    // reject-পরে approve কার্যকর নয়
    await post(admin, rewardId, 'approve');
    expect((await reward(referred)).status).toBe('rejected');
    expect(await coins(referrer)).toBe(before);
  });

  test('bonus_manage ছাড়া অস্বীকৃত (reports_view থাকলেও)', async () => {
    const admin = await makeAdmin({ reports_view: true });
    const { referrer, referred, rewardId } = await heldReward(1000);
    const a = await post(admin, rewardId, 'approve');
    const r = await post(admin, rewardId, 'reject', { reason: 'x' });
    expect([302, 403]).toContain(a.status);
    expect([302, 403]).toContain(r.status);
    expect((await reward(referred)).status).toBe('pending_review');
    expect(await coins(referrer)).toBe(0);
    expect(await bonusRows(referrer)).toHaveLength(0);
  });

  test('concurrent দুই approve (দুই অ্যাডমিন): একটাই কার্যকর', async () => {
    const a1 = await makeAdmin({ bonus_manage: true, reports_view: true });
    const a2 = await makeAdmin({ bonus_manage: true, reports_view: true });
    const { referrer, referred, rewardId } = await heldReward(1000);
    const [t1, t2] = [await csrf(a1.agent), await csrf(a2.agent)];
    await Promise.all([
      a1.agent.post(`/admin/referrals/${rewardId}/approve`).type('form').send({ _csrf: t1 }),
      a2.agent.post(`/admin/referrals/${rewardId}/approve`).type('form').send({ _csrf: t2 })
    ]);
    const rw = await reward(referred);
    expect(rw.status).toBe('paid');
    expect(await coins(referrer)).toBe(Number(rw.amount));
    expect(await bonusRows(referrer)).toHaveLength(1);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM referral_commissions WHERE earner_id=$1 AND from_user_id=$2`, [referrer, referred])).rows[0].n).toBe(1);
  });
});
