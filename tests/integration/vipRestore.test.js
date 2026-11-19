// tests/integration/vipRestore.test.js
// ---------------------------------------------------------------------------
// services/vip.js পুনরুদ্ধারের টেস্ট (আসল Postgres): routes/admin.js-এর ৬টি VIP ফাংশন,
// অ্যাডমিন VIP পেজ/সেভ/টগল/হিস্ট্রি, আপগ্রেড একবারই হওয়া, এবং
// vip_upgrade_history / vip_reward_history-এ সারি পড়া।
// ---------------------------------------------------------------------------

const express = require('express');
const request = require('supertest');
const { pool } = require('../../db');
const vip = require('../../services/vip');

const PFX = 'vr' + Date.now().toString(36).slice(-5);
const LVL_A = 9101;   // টেস্ট-লেভেল (বাস্তব লেভেলের সাথে সংঘর্ষ এড়াতে বড় সংখ্যা)
const LVL_B = 9102;
let adminId, userId, app, flashes = [], renders = [];

function buildApp() {
  const a = express();
  a.use(express.urlencoded({ extended: false }));
  a.use((req, res, next) => {
    req.session = { user: { id: adminId, username: PFX + '_adm' } };
    req.t = (k) => k;
    req.flash = (kind, msg) => { flashes.push({ kind, msg }); };
    res.render = (view, data) => { renders.push({ view, data }); res.json({ view, ok: true }); };
    next();
  });
  a.use('/admin', require('../../routes/admin'));
  return a;
}

beforeAll(async () => {
  const mk = async (suffix, role, roleKey) => (await pool.query(
    `INSERT INTO users (username, password, role, role_key, coins) VALUES ($1,'x',$2,$3,0) RETURNING id`,
    [`${PFX}_${suffix}`, role, roleKey])).rows[0].id;
  adminId = await mk('adm', 'admin', null);
  userId = await mk('usr', 'user', null);
  app = buildApp();
});

afterAll(async () => {
  await pool.query(`DELETE FROM vip_upgrade_history WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM vip_reward_history WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM coin_transactions WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM admin_logs WHERE admin_id = ANY($1)`, [[adminId, userId]]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[adminId, userId]]);
  await pool.query(`DELETE FROM vip_levels WHERE level = ANY($1)`, [[LVL_A, LVL_B]]);
  await pool.end();
});

describe('services/vip.js — পুনরুদ্ধার করা ৬টি ফাংশন এক্সপোর্ট', () => {
  test.each(['listVipLevelsAdmin', 'upsertVipLevel', 'toggleVipLevelActive',
    'getVipAnalytics', 'listAllRewardHistory', 'listAllUpgradeHistory'])('%s', (n) => {
    expect(typeof vip[n]).toBe('function');
  });
  test('routes/admin.js-এর ইমপোর্ট এখন সবই function', () => {
    // রাউটার লোড হলেই destructure ঠিক আছে কিনা বোঝা যায়
    expect(() => require('../../routes/admin')).not.toThrow();
  });
});

describe('অ্যাডমিন VIP পেজ ও সেভ', () => {
  beforeEach(() => { flashes = []; renders = []; });

  test('GET /admin/vip — লেভেল ও অ্যানালিটিক্স সহ রেন্ডার, loadError নয়', async () => {
    const res = await request(app).get('/admin/vip');
    expect(res.status).toBe(200);
    expect(renders[0].view).toBe('admin/vip');
    expect(renders[0].data.loadError).toBeUndefined();
    expect(Array.isArray(renders[0].data.levels)).toBe(true);
    expect(renders[0].data.analytics).toHaveProperty('perLevel');
    expect(renders[0].data.analytics).toHaveProperty('grandTotalBonus');
  });

  test('POST /admin/vip/save — নতুন লেভেল তৈরি, তারপর আপডেট', async () => {
    let res = await request(app).post('/admin/vip/save').type('form').send({
      level: LVL_A, name: PFX + 'A', min_turnover: '1000', upgrade_bonus: '50',
      weekly_bonus: '5', is_active: 'on'
    });
    expect(res.status).toBe(302);
    expect(flashes[0].kind).toBe('success');
    let row = (await pool.query(`SELECT * FROM vip_levels WHERE level=$1`, [LVL_A])).rows[0];
    expect(row.name).toBe(PFX + 'A');
    expect(Number(row.min_turnover)).toBe(1000);
    expect(Number(row.upgrade_bonus)).toBe(50);

    res = await request(app).post('/admin/vip/save').type('form').send({
      level: LVL_A, name: PFX + 'A2', min_turnover: '1200', upgrade_bonus: '60', is_active: 'on'
    });
    expect(res.status).toBe(302);
    const all = (await pool.query(`SELECT * FROM vip_levels WHERE level=$1`, [LVL_A])).rows;
    expect(all).toHaveLength(1);                         // ডুপ্লিকেট নয় — আপডেট হয়েছে
    expect(all[0].name).toBe(PFX + 'A2');
    expect(Number(all[0].upgrade_bonus)).toBe(60);
  });

  test('POST /admin/vip/save — অবৈধ লেভেল নম্বরে error flash', async () => {
    const res = await request(app).post('/admin/vip/save').type('form').send({ level: 'abc', name: 'x' });
    expect(res.status).toBe(302);
    expect(flashes[0].kind).toBe('error');
  });

  test('POST /admin/vip/:level/toggle', async () => {
    await request(app).post(`/admin/vip/${LVL_A}/toggle`).type('form').send({ is_active: 'false' });
    let row = (await pool.query(`SELECT is_active FROM vip_levels WHERE level=$1`, [LVL_A])).rows[0];
    expect(row.is_active).toBe(false);
    await request(app).post(`/admin/vip/${LVL_A}/toggle`).type('form').send({ is_active: 'true' });
    row = (await pool.query(`SELECT is_active FROM vip_levels WHERE level=$1`, [LVL_A])).rows[0];
    expect(row.is_active).toBe(true);
  });
});

describe('আপগ্রেড একবারই + ইতিহাসে সারি', () => {
  beforeAll(async () => {
    // লেভেল A: min 1200, bonus 60 (উপরের টেস্টে সেট); লেভেল B: min 5000, bonus 0
    await vip.upsertVipLevel({ level: LVL_A, name: PFX + 'A2', min_turnover: 1200, upgrade_bonus: 60, is_active: true });
    await vip.upsertVipLevel({ level: LVL_B, name: PFX + 'B', min_turnover: 99999999, upgrade_bonus: 0, is_active: true });
    // এই ইউজারকে টেস্ট-লেভেলের ঠিক নিচে রাখা: বাস্তব লেভেলগুলো ইতিমধ্যে পেরিয়ে গেছে ধরে নেওয়া হয়েছে
    await pool.query(`UPDATE users SET vip_level = $1, total_turnover = 0 WHERE id = $2`, [LVL_A - 1, userId]);
  });

  test('একসাথে ৫টা বাজিতে আপগ্রেড বোনাস ঠিক একবার', async () => {
    await Promise.all([1, 2, 3, 4, 5].map(() => vip.addVipTurnover(userId, 1300)));
    const u = (await pool.query(`SELECT vip_level, coins, total_turnover FROM users WHERE id=$1`, [userId])).rows[0];
    expect(u.vip_level).toBe(LVL_A);
    expect(Number(u.coins)).toBe(60);                       // দুইবার নয়
    expect(Number(u.total_turnover)).toBe(6500);

    const ct = await pool.query(`SELECT * FROM coin_transactions WHERE user_id=$1 AND type='vip_upgrade'`, [userId]);
    expect(ct.rowCount).toBe(1);

    const up = await pool.query(`SELECT * FROM vip_upgrade_history WHERE user_id=$1`, [userId]);
    expect(up.rowCount).toBe(1);
    expect(up.rows[0].from_level).toBe(LVL_A - 1);
    expect(up.rows[0].to_level).toBe(LVL_A);
    expect(Number(up.rows[0].bonus)).toBe(60);

    const rw = await pool.query(`SELECT * FROM vip_reward_history WHERE user_id=$1`, [userId]);
    expect(rw.rowCount).toBe(1);
    expect(rw.rows[0].reward_type).toBe('upgrade_bonus');
    expect(rw.rows[0].vip_level).toBe(LVL_A);
    expect(Number(rw.rows[0].amount)).toBe(60);
  });

  test('আরেকটা বাজিতে (লেভেল একই) নতুন সারি/বোনাস নেই', async () => {
    await vip.addVipTurnover(userId, 100);
    expect((await pool.query(`SELECT 1 FROM vip_upgrade_history WHERE user_id=$1`, [userId])).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM vip_reward_history WHERE user_id=$1`, [userId])).rowCount).toBe(1);
    expect(Number((await pool.query(`SELECT coins FROM users WHERE id=$1`, [userId])).rows[0].coins)).toBe(60);
  });

  test('ইতিহাস ফাংশন ও অ্যাডমিন হিস্ট্রি পেজ সারি দেখায়', async () => {
    const rw = await vip.listAllRewardHistory({ page: 1, limit: 50, rewardType: 'upgrade_bonus' });
    expect(rw.rows.some(r => r.user_id === userId)).toBe(true);
    const up = await vip.listAllUpgradeHistory({ page: 1, limit: 50 });
    expect(up.rows.some(r => r.user_id === userId)).toBe(true);

    renders = [];
    const res = await request(app).get('/admin/vip/history');
    expect(res.status).toBe(200);
    expect(renders[0].view).toBe('admin/vip-history');
    expect(renders[0].data.loadError).toBeUndefined();
  });

  test('getVipAnalytics আপগ্রেড বোনাস গণনা করে', async () => {
    const a = await vip.getVipAnalytics();
    const lvl = a.perLevel.find(l => l.level === LVL_A);
    expect(lvl.userCount).toBeGreaterThanOrEqual(1);
    expect(lvl.totalUpgradeBonus).toBeGreaterThanOrEqual(60);
    expect(a.upgradeStats.find(s => s.toLevel === LVL_A).upgradeCount).toBeGreaterThanOrEqual(1);
  });
});
