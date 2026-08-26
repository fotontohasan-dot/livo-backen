// tests/integration/routeIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 04 — URL, রুটিং, API এন্ডপয়েন্ট ও ন্যাভিগেশন ইন্টিগ্রিটি।
//
// এই ফেজে যে বাস্তব সমস্যাগুলো ধরা পড়েছে ও এখানে লক করা হচ্ছে:
//
//   ১. GET /lang/:code — open redirect। `res.redirect(req.get('Referer') || '/')`
//      সরাসরি ক্লায়েন্ট-নিয়ন্ত্রিত Referer ব্যবহার করত। যাচাই করে দেখা গেছে
//      https://evil.example.com, //evil.example.com এমনকি javascript: স্কিমেও
//      রিডাইরেক্ট হতো। utils/redirectBack.js-এর backUrl() আগে থেকেই নিরাপদ
//      সমাধান রাখে — নতুন কিছু না বানিয়ে সেটাই পুনর্ব্যবহার করা হয়েছে।
//
//   ২. GET /tournaments — কোয়েরিতে t.title রেফার করা হতো, কিন্তু tournaments
//      টেবিলে ওই কলামই নেই। প্রতিবার SQLSTATE 42703 এরর হয়ে catch ব্লক নীরবে
//      খালি তালিকা রেন্ডার করত — পেজে কখনো কোনো টুর্নামেন্ট দেখা যেত না, অথচ
//      HTTP 200 আসায় ধরা পড়ত না।
//
// এছাড়া রুট ইনভেন্টরি, অথরাইজেশন বাউন্ডারি ও ন্যাভিগেশন লিংকের কভারেজ।
// আসল PostgreSQL ব্যবহার করা হয়, কোনো mock নেই।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../app');
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, freshRequest } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');

async function makeLoggedInUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, username, userId: r.rows[0].id };
}

describe('ওপেন রিডাইরেক্ট — GET /lang/:code', () => {
  const hostile = [
    'https://evil.example.com/phish',
    '//evil.example.com/x',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://evil.example.com'
  ];

  test.each(hostile)('বাইরের/অনিরাপদ Referer (%s) সাইটের বাইরে পাঠায় না', async (referer) => {
    const res = await freshRequest().get('/lang/en').set('Referer', referer);
    expect(res.status).toBe(302);
    // গন্তব্য সবসময় সাইট-রিলেটিভ পাথ হতে হবে
    expect(res.headers.location).toBe('/');
    expect(res.headers.location).not.toMatch(/evil\.example\.com/);
    expect(res.headers.location).not.toMatch(/^javascript:/i);
    expect(res.headers.location).not.toMatch(/^data:/i);
    expect(res.headers.location).not.toMatch(/^\/\//);
  });

  test('বৈধ সাইট-অভ্যন্তরীণ Referer আগের মতোই কাজ করে', async () => {
    const res = await freshRequest().get('/lang/en').set('Referer', '/profile');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/profile');
  });

  test('Referer না থাকলে নিরাপদ ফলব্যাক', async () => {
    const res = await freshRequest().get('/lang/bn');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('ভাষা পরিবর্তনের মূল কাজটা অক্ষত', async () => {
    // সেশন কুকি ধরে রাখতে agent দরকার — freshRequest() প্রতি রিকোয়েস্টে নতুন ক্লায়েন্ট
    const { agent } = await getCsrfAgent('/');
    await agent.get('/lang/en').set('Referer', '/');
    const page = await agent.get('/');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/<html lang="en"/);
  });

  test('সোর্সে কাঁচা Referer রিডাইরেক্ট ফিরে আসেনি (রিগ্রেশন গার্ড)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    expect(src).not.toMatch(/res\.redirect\(\s*req\.get\(['"]Referer['"]\)/);
    expect(src).toMatch(/backUrl\(req/);
  });
});

describe('/tournaments — খালি তালিকার নীরব বাগ', () => {
  const NAME = 'RouteIntegrity Probe Cup';

  afterAll(async () => {
    await pool.query('DELETE FROM tournaments WHERE name = $1', [NAME]);
  });

  test('টুর্নামেন্ট থাকলে পেজে সত্যিই দেখা যায়', async () => {
    await pool.query(
      `INSERT INTO tournaments (name, sport, entry_fee, prize_pool, status)
       VALUES ($1, 'cricket', 100, 5000, 'upcoming')`, [NAME]
    );
    const res = await request(app).get('/tournaments');
    expect(res.status).toBe(200);
    expect(res.text).toContain(NAME);
  });

  test('তালিকার কোয়েরি অস্তিত্বহীন কলাম রেফার করে না (রিগ্রেশন গার্ড)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'tournaments.js'), 'utf8');
    // ব্যাখ্যামূলক কমেন্টে পুরনো প্যাটার্নটা উল্লেখ আছে, তাই কমেন্ট বাদ দিয়ে শুধু
    // আসল কোডটাই পরীক্ষা করা হয়।
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/t\.title/);
    expect(code).not.toMatch(/tournament\.title/);
  });

  test('tournaments টেবিলে সত্যিই title কলাম নেই — অনুমান নয়', async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM information_schema.columns
        WHERE table_name = 'tournaments' AND column_name = 'title'`
    );
    expect(r.rows[0].c).toBe(0);
  });
});

describe('অথরাইজেশন বাউন্ডারি', () => {
  const ADMIN_PATHS = ['/admin', '/admin/users', '/admin/backups', '/admin/api/system-diagnostics'];

  test.each(ADMIN_PATHS)('লগআউট অবস্থায় %s এ ঢোকা যায় না', async (p) => {
    const res = await freshRequest().get(p);
    expect(res.status).not.toBe(200);
    expect([302, 401, 403, 404]).toContain(res.status);
  });

  test.each(ADMIN_PATHS)('সাধারণ লগইন ইউজার %s এ ঢুকতে পারে না', async (p) => {
    const { agent } = await makeLoggedInUser();
    const res = await agent.get(p);
    expect(res.status).not.toBe(200);
  });

  test('ব্যানড ইউজার সুরক্ষিত পেজে ঢুকতে পারে না', async () => {
    const { agent, userId } = await makeLoggedInUser();
    expect((await agent.get('/profile')).status).toBe(200);

    await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [userId]);
    const cache = require('../../services/cache');
    const cacheKeys = require('../../services/cacheKeys');
    await cache.del(cacheKeys.userActiveStatus(userId)).catch(() => {});

    const after = await agent.get('/profile');
    expect(after.status).toBe(302);

    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  });

  test('অ্যানোনিমাইজ/নিষ্ক্রিয় ইউজার সুরক্ষিত পেজে ঢুকতে পারে না', async () => {
    const { agent, userId } = await makeLoggedInUser();
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, amount, status)
       VALUES ($1, 'deposit', 500, 'approved')`, [userId]
    );

    const { deleteOrDeactivateUser } = require('../../services/userDeletion');
    const outcome = await deleteOrDeactivateUser(userId, 'route-test');
    expect(outcome.mode).toBe('deactivated');

    const after = await agent.get('/profile');
    expect(after.status).toBe(302);

    await pool.query('DELETE FROM payment_requests WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  });

  test('সুরক্ষিত API সরাসরি কল করলেও অথরাইজেশন বাইপাস হয় না', async () => {
    for (const p of ['/profile/api/balance', '/admin/api/analytics']) {
      const res = await freshRequest().get(p);
      expect(res.status).not.toBe(200);
    }
  });
});

describe('404 / এরর আচরণ — তথ্য ফাঁস হয় না', () => {
  const cases = [
    ['get', '/no-such-page-anywhere'],
    ['get', '/api/v1/no-such-endpoint'],
    ['get', '/matches/999999999'],
    ['get', '/news/999999999'],
    ['get', '/matches/not-a-number']
  ];

  test.each(cases)('%s %s — নিরাপদ রেসপন্স', async (method, url) => {
    const res = await freshRequest()[method](url);
    expect([200, 302, 400, 404]).toContain(res.status);

    const body = res.text || '';
    // স্ট্যাক ট্রেস, ফাইল পাথ, SQL বা সিক্রেট কখনো ক্লায়েন্টে যাবে না
    expect(body).not.toMatch(/at Object\.|at Function\.|node_modules/);
    expect(body).not.toMatch(/\/home\/[a-z]+\/repo/);
    expect(body).not.toMatch(/SELECT\s+.+\s+FROM\s+/i);
    expect(body).not.toMatch(/SESSION_SECRET|DATABASE_URL|STORE_PASSWD/);
  });

  test('অস্তিত্বহীন রুট 404 দেয়, 500 নয়', async () => {
    const res = await freshRequest().get('/definitely-not-a-route-xyz');
    expect(res.status).toBe(404);
  });
});

describe('রুট ইনভেন্টরি সঙ্গতি', () => {
  test('একই method+path দুইবার সংজ্ঞায়িত হয়ে শ্যাডো করে না', () => {
    // adminHealthFix.js ও admin.js দুটোই /admin-এ মাউন্ট, তাই একই পাথ দুবার থাকলে
    // প্রথমটাই জেতে আর দ্বিতীয়টা dead code হয়ে যায় — সেটা এখানে ধরা পড়বে।
    const healthFix = fs.readFileSync(path.join(ROOT, 'routes', 'adminHealthFix.js'), 'utf8');
    const admin = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');

    const hfPaths = [...healthFix.matchAll(/router\.(get|post)\(\s*['"]([^'"]+)['"]/g)]
      .map((m) => `${m[1]}:${m[2]}`);
    const adminPaths = [...admin.matchAll(/router\.(get|post)\(\s*['"]([^'"]+)['"]/g)]
      .map((m) => `${m[1]}:${m[2]}`);

    const shadowed = hfPaths.filter((p) => adminPaths.includes(p));
    expect(shadowed).toEqual([]);
  });

  test('গেটওয়ে কলব্যাক রুটগুলো বিদ্যমান ও পাবলিক থাকে', async () => {
    // Phase 03 এগুলোকে সার্ভার-সাইড ভ্যালিডেশনে সুরক্ষিত করেছে; auth middleware
    // যোগ করলে গেটওয়ে সার্ভার-টু-সার্ভার পোস্ট ব্যর্থ হতো।
    for (const p of ['/payment/sslcommerz/success', '/payment/sslcommerz/ipn',
      '/payment/sslcommerz/fail', '/payment/sslcommerz/cancel']) {
      const res = await freshRequest().post(p).type('form').send({ tran_id: 'nonexistent-xyz' });
      expect(res.status).not.toBe(404);
    }
  });
});

describe('ন্যাভিগেশন লিংক — কোনো ডেড লিংক নেই', () => {
  test('বটম নেভ ও ফুটারের প্রতিটা স্ট্যাটিক লিংক রেসপন্ড করে', async () => {
    const files = ['views/partials/bottom-nav.ejs', 'views/partials/footer.ejs'];
    const links = new Set();
    for (const f of files) {
      const full = path.join(ROOT, f);
      if (!fs.existsSync(full)) continue;
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/href="(\/[^"#?<]*)"/g)) {
        links.add(m[1]);
      }
    }
    expect(links.size).toBeGreaterThan(0);

    const dead = [];
    for (const link of links) {
      const res = await freshRequest().get(link);
      if (![200, 302].includes(res.status)) dead.push(`${link} → ${res.status}`);
    }
    expect(dead).toEqual([]);
  });
});
