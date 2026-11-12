const request = require('supertest');
const bcrypt = require('bcryptjs');
const { pool } = require('../../db');
const {
  app, extractCsrfToken, uniqueUsername, uniquePhone, fakeIp, wrapAgentWithIp, REALISTIC_UA
} = require('../helpers/app');

// ==================== A2 — অ্যাডমিন লগইন সফট ডিলে ====================
// নিয়ম: অ্যাকাউন্ট-ব্যাপী (সব IP) ব্যর্থ চেষ্টা ৮ পেরোলে /admin/login ছোট দেরি করে — কখনো ব্লক করে না,
// আর অ্যাকাউন্ট আছে কি না তাতে আচরণ বদলায় না (enumeration নেই)।
// প্রতিটা চেষ্টা আলাদা IP থেকে, যাতে অ্যাকাউন্ট+IP হার্ড লিমিটার (৮) নয়, শুধু সফট চেইন পরীক্ষা হয়।
jest.setTimeout(120000);

const PASSWORD = 'SecurePass123';
const SOFT_THRESHOLD = 8;
const SOFT_DELAY_MS = 1000;
const whitelisted = [];
let adminId;
let adminUsername;

async function freshIp() {
  const ip = fakeIp();
  // bot-detection-এর velocity সংকেত যেন ফলাফল না বদলায়
  await require('../../services/ipRules').setIpRule(ip, 'whitelist', 'adminLoginSoftDelay test', null);
  whitelisted.push(ip);
  return ip;
}

async function adminLoginAttempt(username, password) {
  const ip = await freshIp();
  const agent = wrapAgentWithIp(request.agent(app), ip);
  const page = await agent.get('/admin/login');
  const token = extractCsrfToken(page.text);
  const started = Date.now();
  const res = await agent.post('/admin/login').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, password, _csrf: token });
  return { res, ms: Date.now() - started };
}

beforeAll(async () => {
  adminUsername = uniqueUsername('sd');
  const hash = await bcrypt.hash(PASSWORD, 10);
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, role) VALUES ($1, $2, $3, 'admin') RETURNING id`,
    [adminUsername, uniquePhone(), hash]
  );
  adminId = r.rows[0].id;
});

afterAll(async () => {
  if (whitelisted.length) await pool.query('DELETE FROM ip_rules WHERE ip = ANY($1)', [whitelisted]).catch(() => {});
  if (adminId) {
    await pool.query('DELETE FROM audit_logs WHERE actor_id = $1', [adminId]).catch(() => {});
    await pool.query('DELETE FROM admin_logs WHERE admin_id = $1', [adminId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [adminId]).catch(() => {});
  }
});

describe('A2 — admin login soft delay', () => {
  async function runScenario(username) {
    const before = [];
    for (let i = 0; i < SOFT_THRESHOLD; i += 1) before.push(await adminLoginAttempt(username, 'WrongPass!' + i));
    const after = await adminLoginAttempt(username, 'WrongPass!after');
    const after2 = await adminLoginAttempt(username, 'WrongPass!after2');
    return { before, after, after2 };
  }

  test('delay starts after the threshold, never blocks, same for existing and non-existing accounts', async () => {
    const ghost = uniqueUsername('ghost');
    const existing = await runScenario(adminUsername);
    const missing = await runScenario(ghost);

    for (const s of [existing, missing]) {
      // threshold-এর আগে কোনো কৃত্রিম দেরি নেই
      for (const a of s.before) expect(a.ms).toBeLessThan(SOFT_DELAY_MS);
      // threshold-এর পরে দেরি আছে
      expect(s.after.ms).toBeGreaterThanOrEqual(SOFT_DELAY_MS - 50);
      expect(s.after2.ms).toBeGreaterThanOrEqual(SOFT_DELAY_MS - 50);
      // কখনো ব্লক নয়: ৪২৯ নয়, আগের মতোই লগইন পেজ + একই জেনেরিক বার্তা
      for (const a of [...s.before, s.after, s.after2]) expect(a.res.status).toBe(200);
    }

    // অস্তিত্ব-নিরপেক্ষ: একই স্ট্যাটাস, একই দেরির ক্ষেত্র, একই এরর বার্তা
    const errText = (r) => (/<[^>]*(?:alert|error)[^>]*>([\s\S]*?)</i.exec(r.res.text) || [])[1] || '';
    expect(errText(existing.after).trim()).toBe(errText(missing.after).trim());
    expect(existing.after.res.status).toBe(missing.after.res.status);
    expect(Math.abs(existing.after.ms - missing.after.ms)).toBeLessThan(1500);
  });

  test('correct password still logs in after the threshold (soft delay never blocks)', async () => {
    const { res, ms } = await adminLoginAttempt(adminUsername, PASSWORD);
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toMatch(/\/admin\/login(\?|$)/);
    expect(ms).toBeGreaterThanOrEqual(SOFT_DELAY_MS - 50);
  });
});
