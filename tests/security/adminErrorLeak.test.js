// tests/security/adminErrorLeak.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন mutation ব্যর্থ হলে আগে কাঁচা err.message রিডাইরেক্ট URL-এ বসত:
//     res.redirect(`/admin/backups?error=${encodeURIComponent(err.message)}`)
//
// pg-এর এরর মেসেজে টেবিল/কলামের নাম, কনস্ট্রেইন্টের নাম, এমনকি সার্ভারের ফাইল পাথ
// থাকতে পারে। সেটা URL-এ গেলে ডেটাবেস internals ব্রাউজার হিস্ট্রি, Referer হেডার এবং
// যেকোনো প্রক্সি/অ্যাক্সেস লগে স্থায়ীভাবে লেখা হয়ে যায় — শুধু পেজে দেখানো বন্ধ করলেই
// যথেষ্ট নয়। এখন রুটগুলো ছোট এরর-কোড পাঠায় এবং কোডটাই পড়ার মতো বার্তায় ম্যাপ হয়।
//
// এই টেস্ট প্রমাণ করে:
//   1. রিস্টোর ব্যর্থ হলে Location হেডারে কোনো DB internals থাকে না।
//   2. ফলো করা পেজেও ওই internals রেন্ডার হয় না।
//   3. ?error=<যা খুশি> query দিয়ে ইচ্ছেমতো টেক্সট অ্যাডমিন পেজে বসানো যায় না।
//   4. RBAC অপরিবর্তিত — নন-অ্যাডমিন এই রুটগুলোতে পৌঁছাতেই পারে না।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const backupManager = require('../../services/backupManager');

const LEAKY_DB_ERROR =
  'relation "secret_internal_table" does not exist at /srv/app/services/backupManager.js:391';

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
  return { agent, token };
}

async function makePlainAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  return { agent, token };
}

function expectNoDbInternals(text) {
  expect(text).not.toContain('secret_internal_table');
  expect(text).not.toContain('does not exist');
  expect(text).not.toContain('backupManager.js:391');
  expect(text).not.toContain(encodeURIComponent(LEAKY_DB_ERROR));
}

describe('অ্যাডমিন এরর-পাথে ডেটাবেস internals লিক হয় না', () => {
  let admin;
  let csrf;

  beforeAll(async () => {
    admin = await makeAdminAgent();
    const page = await admin.agent.get('/admin/backups');
    csrf = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '');
    csrf = csrf ? csrf[1] : admin.token;
  });

  test('রিস্টোর ব্যর্থ হলে redirect URL-এ কাঁচা DB এরর যায় না', async () => {
    const record = { id: 999999, type: 'database', filename: 'nonexistent.sql.gz' };
    const byId = jest.spyOn(backupManager, 'getBackupById').mockResolvedValue(record);
    const restore = jest.spyOn(backupManager, 'restoreBackup')
      .mockRejectedValue(new Error(LEAKY_DB_ERROR));
    try {
      const res = await admin.agent.post('/admin/backups/999999/restore')
        .type('form').send({ _csrf: csrf });
      expect([302, 403]).toContain(res.status);
      if (res.status === 302) {
        const location = res.headers.location || '';
        expectNoDbInternals(location);
        expect(location).toContain('/admin/backups');
      }
    } finally {
      byId.mockRestore();
      restore.mockRestore();
    }
  });

  test('?error= query দিয়ে ইচ্ছেমতো টেক্সট অ্যাডমিন পেজে বসানো যায় না', async () => {
    const injected = 'secret_internal_table does not exist';
    const res = await admin.agent.get(`/admin/backups?error=${encodeURIComponent(injected)}`);
    expect(res.status).toBe(200);
    expectNoDbInternals(res.text);
  });

  test('feature-flags পেজেও একই — অচেনা error কোড হুবহু রেন্ডার হয় না', async () => {
    const injected = 'secret_internal_table does not exist';
    const res = await admin.agent.get(`/admin/feature-flags?error=${encodeURIComponent(injected)}`);
    expect(res.status).toBe(200);
    expectNoDbInternals(res.text);
  });

  // RBAC-এর বিদ্যমান আচরণ: নন-API অ্যাডমিন রুটে পারমিশন না থাকলে 403 নয়, /admin বা
  // /admin/login-এ রিডাইরেক্ট (services/rbac.js:requirePermission)। এই টেস্ট সেই আচরণটাই
  // লক করে — গুরুত্বপূর্ণ হলো হ্যান্ডলার কখনো চলে না, অর্থাৎ restoreBackup() ডাকা হয় না।
  test('নন-অ্যাডমিন রিস্টোর রুটে পৌঁছাতে পারে না (RBAC অপরিবর্তিত)', async () => {
    const plain = await makePlainAgent();
    const restore = jest.spyOn(backupManager, 'restoreBackup');
    try {
      const res = await plain.agent.post('/admin/backups/999999/restore')
        .type('form').send({ _csrf: plain.token });
      expect([302, 401, 403]).toContain(res.status);
      if (res.status === 302) {
        const location = res.headers.location || '';
        expect(location).toMatch(/^\/admin(\/login)?$/);
      }
      expect(restore).not.toHaveBeenCalled();
    } finally {
      restore.mockRestore();
    }
  });
});
