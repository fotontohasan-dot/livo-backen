// tests/regression/auditFixes.test.js
// ---------------------------------------------------------------------------
// অডিটে (২০২৬-১১-০১) ধরা পড়া বাগগুলো যেন আর ফিরে না আসে।
//   ১) উইথড্র রুটে ইমেইল-ভেরিফিকেশন + KYC + rate-limit গার্ড (bd8b1b2 কমিটে হারিয়েছিল)
//   ২) routes/admin.js-এ scheduler require না থাকায় /admin/cron-jobs ভাঙা ছিল
//   ৩) partials-floating-promo.js-এ পুরনো ডুপ্লিকেট ফাংশন নতুনটাকে ওভাররাইড করত
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken } = require('../helpers/app');
const { cleanupUsers } = require('../helpers/cleanup');
const { pool } = require('../../db');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const createdUserIds = [];

async function makeUser(prefix) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername(prefix);
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  const id = r.rows[0] && r.rows[0].id;
  if (id) createdUserIds.push(id);
  return { agent, id };
}

async function tryWithdraw(user) {
  const page = await user.agent.get('/payment/withdraw');
  return user.agent.post('/payment/withdraw').type('form').send({
    method: 'bkash', account_number: '01712345678', amount: 500,
    _csrf: extractCsrfToken(page.text)
  });
}

const countRequests = async (id) =>
  (await pool.query('SELECT COUNT(*)::int AS c FROM payment_requests WHERE user_id = $1', [id])).rows[0].c;

afterAll(async () => {
  await cleanupUsers(createdUserIds);
});

describe('উইথড্র KYC গার্ড', () => {
  test('রুট ডিফিনিশনে ইমেইল-ভেরিফাই, KYC ও rate-limit তিনটাই আছে', () => {
    const line = read('routes/payment.js').split('\n').find((l) => l.includes("router.post('/withdraw'"));
    expect(line).toBeDefined();
    expect(line).toMatch(/requireVerifiedEmail/);
    expect(line).toMatch(/requireApprovedKyc/);
    expect(line).toMatch(/paymentLimiter/);
  });

  test('KYC ছাড়া উইথড্র গৃহীত হয় না এবং কোনো রিকোয়েস্ট তৈরি হয় না', async () => {
    const user = await makeUser('kycno');
    await pool.query('UPDATE users SET coins = 5000 WHERE id = $1', [user.id]);
    const before = await countRequests(user.id);
    const res = await tryWithdraw(user);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/extra/kyc');
    expect(await countRequests(user.id)).toBe(before);
  });

  test('KYC pending থাকলেও উইথড্র আটকায়', async () => {
    const user = await makeUser('kycpend');
    await pool.query('UPDATE users SET coins = 5000 WHERE id = $1', [user.id]);
    await pool.query("INSERT INTO kyc_requests (user_id, full_name, status) VALUES ($1, 'Test', 'pending')", [user.id]);
    const before = await countRequests(user.id);
    const res = await tryWithdraw(user);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/extra/kyc');
    expect(await countRequests(user.id)).toBe(before);
  });

  test('KYC rejected থাকলেও উইথড্র আটকায়', async () => {
    const user = await makeUser('kycrej');
    await pool.query('UPDATE users SET coins = 5000 WHERE id = $1', [user.id]);
    await pool.query("INSERT INTO kyc_requests (user_id, full_name, status) VALUES ($1, 'Test', 'rejected')", [user.id]);
    const res = await tryWithdraw(user);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/extra/kyc');
  });

  test('KYC approved হলে গার্ড পেরিয়ে যায় (KYC পেজে রিডাইরেক্ট হয় না)', async () => {
    const user = await makeUser('kycok');
    await pool.query('UPDATE users SET coins = 5000 WHERE id = $1', [user.id]);
    await pool.query("INSERT INTO kyc_requests (user_id, full_name, status) VALUES ($1, 'Test', 'approved')", [user.id]);
    const res = await tryWithdraw(user);
    expect(res.headers.location).not.toBe('/extra/kyc');
  });
});

describe('/admin/cron-jobs — scheduler ইম্পোর্ট', () => {
  test('admin.js যেসব scheduler.* ব্যবহার করে তার require আছে', () => {
    const src = read('routes/admin.js');
    expect(/\bscheduler\./.test(src)).toBe(true);
    expect(src).toMatch(/const scheduler = require\('\.\.\/services\/scheduler'\)/);
  });

  test('admin.js যেসব scheduler মেথড ডাকে সেগুলো scheduler.js export করে', () => {
    const scheduler = require('../../services/scheduler');
    const used = [...read('routes/admin.js').matchAll(/\bscheduler\.([A-Za-z_]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of new Set(used)) expect(scheduler[name]).toBeDefined();
  });
});

describe('ফ্লোটিং প্রোমো JS', () => {
  const src = read('public/js/views/partials-floating-promo.js');

  test('একই নামে ডুপ্লিকেট ফাংশন ডিক্লেয়ারেশন নেই', () => {
    const names = [...src.matchAll(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]);
    const dups = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dups).toEqual([]);
  });

  test('অস্তিত্বহীন LP_IMG ভ্যারিয়েবলের রেফারেন্স নেই', () => {
    expect(src).not.toMatch(/\bLP_IMG\b/);
  });
});
