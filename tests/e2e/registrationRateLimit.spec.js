// tests/e2e/registrationRateLimit.spec.js
// ---------------------------------------------------------------------------
// PHASE 3 — রেজিস্ট্রেশন E2E-এর 429 ব্যর্থতার মূল কারণ ও তার গার্ড।
//
// আগের ব্যর্থতা: criticalFlows.spec.js-এ `page.fill('#username')` টাইমআউট হতো।
// আসল কারণ selector নয় — POST /register HTTP 429 পেত। পুরো E2E রান (এবং CI-এর
// retry রান) একটাই loopback IP থেকে আসত, তাই app.js-এর প্রোডাকশন লিমিটার
// (generalLimiter ৩০০ req/১৫ মিনিট; loginLimiter ১০ POST/১৫ মিনিট, যা /login,
// /register ও /admin/login-এ একই IP কী শেয়ার করে) কোটা শেষ করে ফেলত এবং এক
// টেস্টের খরচ পরের টেস্টে লিক করত।
//
// যা করা হয়নি (ইচ্ছাকৃতভাবে): লিমিটার বন্ধ করা হয়নি, প্রোডাকশন লিমিট বাড়ানো
// হয়নি, অ্যাপে কোনো `NODE_ENV === 'test'` bypass ঢোকানো হয়নি।
//
// যা করা হয়েছে: অ্যাপে `trust proxy` সেট করা আছে, তাই প্রতিটা টেস্ট নিজস্ব
// X-Forwarded-For দিয়ে নিজস্ব লিমিটার বাকেট পায় (Jest হেল্পার tests/helpers/app.js
// বহু আগে থেকেই এই কৌশল ব্যবহার করে)। ফলে টেস্টগুলো একে অপরকে বিষাক্ত করে না,
// অথচ লিমিটারটা আসল কোড পাথেই থাকে — এবং নিচের Test B সেটাকে সত্যিই যাচাই করে।
//
// Test A — স্বাভাবিক রেজিস্ট্রেশন সফল হয়।
// Test B — একই IP থেকে অতিরিক্ত রিকোয়েস্ট পাঠালে 429 আসে (লিমিটার এখনো জীবিত)।
// Test C — B-এর ঠিক পরেই নতুন আইসোলেটেড কনটেক্সট (নতুন IP) বিষমুক্ত থাকে।
// ---------------------------------------------------------------------------
const { test, expect, request: apiRequest } = require('@playwright/test');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/livo_test' });

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';

function fakeIp() {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}
function uniqueUsername() {
  return 'rl' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10);
}
function uniquePhone() {
  return '017' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
}

const THIRD_PARTY_ORIGINS_TO_BLOCK = [
  'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
  'cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'i.postimg.cc', 'i.pravatar.cc', 'img.icons8.com'
];

async function solveCaptchaIfPresent(page) {
  const label = page.locator('label[for="captcha_answer"]');
  if (await label.count() === 0) return;
  if (!(await label.isVisible())) return;
  const text = await label.textContent();
  const m = text.match(/(\d+)\s*([+-])\s*(\d+)/);
  if (!m) return;
  const [, a, op, b] = m;
  await page.fill('#captcha_answer', String(op === '+' ? Number(a) + Number(b) : Number(a) - Number(b)));
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
  // প্রতিটা টেস্ট নিজের IP বাকেট পায় — এটাই আইসোলেশন কৌশল
  await context.setExtraHTTPHeaders({ 'X-Forwarded-For': fakeIp() });
  await context.addCookies([{ name: 'livo_age_verified', value: '1', domain: 'localhost', path: '/' }]);
  await context.route('**/*', (route) => {
    try {
      const url = new URL(route.request().url());
      if (THIRD_PARTY_ORIGINS_TO_BLOCK.includes(url.hostname)) return route.abort();
    } catch (e) { /* পার্স ব্যর্থ হলেও রিকোয়েস্ট ঝুলবে না */ }
    return route.continue();
  });
});

test.afterAll(async () => {
  await pool.end();
});

/** ব্রাউজার দিয়ে একটা পূর্ণ রেজিস্ট্রেশন — POST-এর আসল HTTP স্ট্যাটাসসহ ফেরত দেয়। */
async function registerViaBrowser(page, username, phone) {
  await page.goto('/register', { waitUntil: 'domcontentloaded' });
  await page.fill('#username', username);
  await page.fill('#phone', phone);
  await page.fill('#password', 'SecurePass123');
  await page.fill('#confirmPassword', 'SecurePass123');
  await solveCaptchaIfPresent(page);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/register') && r.request().method() === 'POST'),
    page.click('#registerSubmitBtn')
  ]);
  await page.waitForLoadState('domcontentloaded');
  return response;
}

test('Test A — স্বাভাবিক রেজিস্ট্রেশন সফল হয় (429 নয়) এবং DB-তে ইউজার তৈরি হয়', async ({ page }) => {
  const username = uniqueUsername();
  const response = await registerViaBrowser(page, username, uniquePhone());

  expect(response.status(), 'রেট-লিমিট লিক করলে এখানে 429 আসত').toBeLessThan(400);
  expect(page.url()).not.toContain('/register');

  const row = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  expect(row.rows.length).toBe(1);
});

test('Test B — একই IP থেকে অতিরিক্ত রেজিস্ট্রেশন রিকোয়েস্ট 429 পায় (রেট-লিমিটার এখনো কার্যকর)', async () => {
  // ব্রাউজার নয়, সরাসরি HTTP — উদ্দেশ্য লিমিটার যাচাই করা, UI নয়।
  const floodIp = fakeIp();
  const ctx = await apiRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { 'X-Forwarded-For': floodIp }
  });

  try {
    // GET গোনা হয় না (app.js: `skip: req.method === 'GET' || 'HEAD'`), তাই টোকেন
    // নেওয়ার খরচেই কোটা শেষ হয় না — শুধু আসল POST চেষ্টাগুলোই গোনা হয়।
    const pageHtml = await (await ctx.get('/register')).text();
    const csrf = /<meta name="csrf-token" content="([^"]*)"/.exec(pageHtml)?.[1] || '';

    const statuses = [];
    // loginLimiter max = 10 / ১৫ মিনিট। ২০ বার চেষ্টা করলে অবশ্যই 429 আসতে হবে।
    for (let i = 0; i < 20; i++) {
      const res = await ctx.post('/register', {
        form: {
          username: uniqueUsername(),
          phone: uniquePhone(),
          password: 'SecurePass123',
          confirmPassword: 'SecurePass123',
          _csrf: csrf
        },
        maxRedirects: 0,
        failOnStatusCode: false
      });
      statuses.push(res.status());
      if (res.status() === 429) break;
    }

    expect(statuses, `রেট-লিমিটার ট্রিগার হয়নি — পাওয়া স্ট্যাটাস: ${statuses.join(',')}`).toContain(429);
    // প্রথম কয়েকটা রিকোয়েস্ট লিমিটে পড়েনি — অর্থাৎ লিমিটটা অতিরিক্ত কড়াও নয়
    expect(statuses[0]).not.toBe(429);
  } finally {
    await ctx.dispose();
  }
});

test('Test C — নতুন আইসোলেটেড কনটেক্সট আগের টেস্টের কোটায় বিষাক্ত হয় না', async ({ page }) => {
  const username = uniqueUsername();
  const response = await registerViaBrowser(page, username, uniquePhone());

  expect(response.status(), 'আগের ফ্লাড টেস্টের কোটা এই টেস্টে লিক করেছে').toBeLessThan(400);
  const row = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  expect(row.rows.length).toBe(1);
});
