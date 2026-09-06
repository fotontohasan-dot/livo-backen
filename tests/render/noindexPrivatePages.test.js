const request = require('supertest');
const { app, getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');

// ==================== Phase 16: ইনডেক্সিং নিয়ন্ত্রণ ====================
//
// roadmap Phase 16 — robots ও SEO।
//
// robots.txt আগে থেকেই ছিল এবং /admin, /profile, /payment disallow করে।
// কিন্তু robots.txt দুটো কারণে যথেষ্ট নয়:
//
//   ১. এটা কেবল ভদ্র ক্রলারই মানে। যে ক্রলার মানে না, তার জন্য কোনো
//      বাধা নেই — আর ওই ফাইলটাই সবচেয়ে সংবেদনশীল পথগুলোর একটা তালিকা
//      হয়ে যায়, যা যে কেউ পড়তে পারে।
//   ২. কোনো ব্যক্তিগত পেজের লিংক বাইরে ফাঁস হলে (রেফারার, শেয়ার করা
//      স্ক্রিনশট, ভুল কনফিগ) সেটা ইনডেক্স হয়ে যেতে পারত।
//
// তাই ব্যক্তিগত ও আর্থিক পেজে সরাসরি `<meta name="robots" content=
// "noindex, nofollow">` বসানো হয় — পেজ-প্রতি, তাই কোনো তালিকা ফাঁস হয় না।

const PUBLIC_PATHS = ['/', '/login', '/register', '/promotions'];
const PRIVATE_PATHS = ['/profile', '/profile/security', '/payment/wallet'];

const NOINDEX = /<meta name="robots" content="noindex, nofollow">/;

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('seo');
  await agent.post('/register').type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, id: r.rows[0] && r.rows[0].id };
}

async function cleanup(id) {
  if (!id) return;
  const r = await pool.query(`
    SELECT DISTINCT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'users' AND ccu.column_name = 'id'
  `);
  for (const { table_name, column_name } of r.rows) {
    await pool.query(`DELETE FROM ${table_name} WHERE ${column_name} = $1`, [id]).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
}

describe('Phase 16 — ব্যক্তিগত পেজ ইনডেক্স হয় না', () => {
  jest.setTimeout(60000);

  let user;

  beforeAll(async () => { user = await makeUser(); });
  afterAll(async () => { await cleanup(user && user.id); });

  test.each(PRIVATE_PATHS)('%s-এ noindex মেটা আছে', async (path) => {
    const res = await user.agent.get(path);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(NOINDEX);
  });

  test.each(PUBLIC_PATHS)('%s ইনডেক্সযোগ্য থাকে', async (path) => {
    // পাবলিক পেজে ভুল করে noindex বসে গেলে সাইটটা সার্চ থেকে হারিয়ে যেত —
    // এটা নীরব ব্যবসায়িক ক্ষতি, তাই উল্টো দিকটাও আটকে রাখা হয়।
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(NOINDEX);
  });

  test('locals.noindex স্পষ্টভাবে দিলে সেটাই মানা হয়', () => {
    const fs = require('fs');
    const path = require('path');
    const head = fs.readFileSync(
      path.join(__dirname, '..', '..', 'views', 'partials', 'head.ejs'), 'utf8'
    );
    // পাথ-ভিত্তিক অনুমান override করা যায় — নাহলে ব্যতিক্রম সামলানো যেত না
    expect(head).toMatch(/typeof locals\.noindex !== 'undefined'/);
    expect(head).toMatch(/name="robots" content="noindex, nofollow"/);
  });

  test('currentPath সব রেসপন্সে সেট হয়', () => {
    // এটা না থাকলে শর্তটা কখনো true হত না এবং noindex নীরবে কাজ করত না —
    // প্রথম খসড়ায় ঠিক এই ভুলটাই ছিল।
    const fs = require('fs');
    const path = require('path');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
    expect(appSrc).toMatch(/res\.locals\.currentPath = req\.path/);
  });

  test('robots.txt এখনো সংবেদনশীল পথ disallow করে', () => {
    const fs = require('fs');
    const path = require('path');
    const robots = fs.readFileSync(
      path.join(__dirname, '..', '..', 'public', 'robots.txt'), 'utf8'
    );
    ['/admin', '/profile'].forEach((p) => {
      expect(robots).toMatch(new RegExp('Disallow: ' + p));
    });
  });
});
