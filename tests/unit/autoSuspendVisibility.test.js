// K10 — দৃশ্যমানতা: অ্যাডমিন রুটের অনুমতি, মেট্রিক্স, স্ট্যাটাস পেজ, scheduler probe।
const fs = require('fs');
const path = require('path');
jest.mock('../../db', () => ({ pool: { query: jest.fn(), totalCount: 0, idleCount: 0 } }));
const client = require('prom-client');
const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const ops = require('../../services/opsMetrics');
const rbac = require('../../services/rbac');

describe('অ্যাডমিন হাতে সাসপেন্ড/রিজিউম', () => {
  const src = read('routes/adminHealthFix.js');
  test('দুটো রুটেই isAdmin + system_diagnostics_manage', () => {
    expect(src).toMatch(/post\('\/integrations\/:name\/suspend', isAdmin, rbac\.requirePermission\('system_diagnostics_manage'\)/);
    expect(src).toMatch(/post\('\/integrations\/:name\/resume', isAdmin, rbac\.requirePermission\('system_diagnostics_manage'\)/);
  });
  test('অনুমতি ক্যাটালগে System গ্রুপে আছে', () => {
    expect(rbac.PERMISSIONS.system_diagnostics_manage.group).toBe('System');
  });
  test('অ্যাকশন অডিট লগ হয় (autoSuspend → logAdminAction) ও ত্রুটি ক্লায়েন্টে যায় না', () => {
    expect(read('services/autoSuspend.js')).toMatch(/logAdminAction/);
    expect(src).toMatch(/NOT_SUSPENDABLE/);
    expect(src).not.toMatch(/flash\('error', err\.message/);
  });
  test('ভিউতে CSRF টোকেন ও শুধু canManage হলে বোতাম', () => {
    const v = read('views/admin/integrations.ejs');
    expect(v).toMatch(/name="_csrf"/);
    expect(v).toMatch(/canManage/);
    expect(v).toMatch(/aci_col_suspend/);
  });
});

describe('মেট্রিক্স', () => {
  test('integration_suspended / seconds / count গেজ আসে', async () => {
    const register = new client.Registry();
    const gauges = ops.createOpsGauges(client, register);
    const since = new Date(Date.now() - 90000);
    await ops.refreshOpsMetrics(gauges, {
      db: { pool: { totalCount: 1, idleCount: 1 } },
      redisTargets: [],
      queueHealth: { getQueueHealthStats: async () => ({ queues: [] }) },
      apiLogger: { getApiLogStats: () => ({}) },
      breakers: { getAllBreakerSnapshots: () => [] },
      suspend: { listStates: async () => [
        { name: 'casino:alpha', suspended: true, source: 'auto', suspended_at: since, suspend_count: 2 },
        { name: 'sports:cricapi', suspended: false, source: 'auto', suspended_at: null, suspend_count: 1 }
      ] }
    });
    const text = await register.metrics();
    expect(text).toMatch(/bet420_integration_suspended\{name="casino:alpha",source="auto"\} 1/);
    expect(text).toMatch(/bet420_integration_suspended\{name="sports:cricapi",source="auto"\} 0/);
    expect(text).toMatch(/bet420_integration_suspend_count\{name="casino:alpha"\} 2/);
    expect(text).toMatch(/bet420_integration_suspended_seconds\{name="casino:alpha"\} (9\d|8\d)/);
  });
  test('suspend সোর্স ব্যর্থ হলে বাকি গেজ থামে না', async () => {
    const register = new client.Registry();
    const gauges = ops.createOpsGauges(client, register);
    await expect(ops.refreshOpsMetrics(gauges, {
      db: { pool: { totalCount: 4, idleCount: 1 } }, redisTargets: [],
      queueHealth: { getQueueHealthStats: async () => ({ queues: [] }) },
      apiLogger: { getApiLogStats: () => ({}) }, breakers: { getAllBreakerSnapshots: () => [] },
      suspend: { listStates: async () => { throw new Error('x'); } }
    })).resolves.toBeUndefined();
    expect(await register.metrics()).toMatch(/bet420_db_pool_in_use 3/);
  });
});

describe('scheduler probe', () => {
  test('probe জব আছে, শুধু casino অ্যাডাপ্টার, payment/wallet নেই', () => {
    const src = read('services/scheduler.js');
    const i = src.indexOf('integration_suspend_probe: {');
    const block = src.slice(i, src.indexOf('system_health_check: {', i));
    expect(block).toMatch(/registerProbe\(`casino:/);
    expect(block).not.toMatch(/payment:|wallet:|sslcommerz/i);
  });
});
