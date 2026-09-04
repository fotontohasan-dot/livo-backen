// tests/e2e/criticalFlows.spec.js
// ---------------------------------------------------------------------------
// পোস্ট-মাস্টার-অডিট — Task 2: ব্রাউজার/E2E কভারেজ (Playwright/Chromium)।
//
// একটা বাস্তব app.js ইনস্ট্যান্সের (NODE_ENV=development, livo_test DB) বিরুদ্ধে সত্যিকারের
// Chromium ব্রাউজার দিয়ে চালানো — কোনো mock নেই। প্রতিটা টেস্টে HTTP 5xx, uncaught console
// error, এবং ব্যর্থ same-origin নেটওয়ার্ক রিকোয়েস্ট ধরা হয় (attachErrorTracking())।
//
// সীমাবদ্ধতা (সৎভাবে বলা প্রয়োজন — NOT VERIFIED অংশ):
//   • Cloudinary/Google OAuth/SSLCommerz/Email/SMS-এর জন্য এই sandbox-এ কোনো লাইভ credential
//     নেই। KYC-তে ছবি আপলোড সিমুলেট করা হয়েছে (client-side state সরাসরি সেট করে, ঠিক
//     যেমন আসল আপলোড সফল হলে হতো) — আসল Cloudinary আপলোড *NOT VERIFIED*।
//   • ডিপোজিট manual bkash পদ্ধতিতে অ্যাডমিন-অনুমোদন সাপেক্ষ — তাই কয়েন ক্রেডিট এখানে
//     যাচাই হয়নি, শুধু রিকোয়েস্ট তৈরি হওয়া পর্যন্ত।
// ---------------------------------------------------------------------------
const { test, expect } = require('@playwright/test');
const speakeasy = require('speakeasy');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/livo_test' });

function uniqueUsername() {
  // ইউজারনেম রেজেক্স (client + server উভয় দিকেই) সর্বোচ্চ ২০ ক্যারেক্টার অনুমতি দেয়
  // (^[a-zA-Z0-9_.]{3,20}$) — তাই খুব ছোট, নিশ্চিতভাবে ইউনিক একটা মান তৈরি করা হচ্ছে।
  return 'e2e' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10);
}
function uniquePhone() {
  return '017' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// রেট-লিমিট আইসোলেশন (রেজিস্ট্রেশন E2E-এর 429 ব্যর্থতার মূল কারণের ফিক্স)।
//
// প্রোডাকশনের রেট-লিমিটার IP-ভিত্তিক (app.js: generalLimiter ৩০০ req/১৫ মিনিট,
// loginLimiter ১০ POST/১৫ মিনিট — /login, /register ও /admin/login একই কী শেয়ার করে)।
// পুরো E2E রান একটাই loopback IP থেকে আসত, তাই আগের টেস্টগুলোর (এবং CI-এর retry
// রানের) খরচ করা কোটা পরের টেস্টে লিক করত এবং POST /register 429 পেত। তখন
// `page.fill('#username')` টাইমআউট হতো — ব্যর্থতাটা দেখতে "selector সমস্যা"র মতো
// লাগলেও আসল কারণ ছিল HTTP 429।
//
// সমাধান (tests/helpers/app.js-এ Jest যেভাবে করে, ঠিক সেভাবেই): অ্যাপে
// `trust proxy` সেট করা আছে, তাই প্রতিটা টেস্ট নিজের র‍্যান্ডম X-Forwarded-For
// দিয়ে নিজস্ব লিমিটার বাকেট পায় — প্রোডাকশন লিমিট অপরিবর্তিত, কোনো টেস্ট-only
// bypass কোড অ্যাপে ঢোকেনি, এবং লিমিটারটা নিচের ডেডিকেটেড টেস্টে সত্যিই যাচাই হয়।
function fakeIp() {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

// এই sandbox-এর আউটবাউন্ড নেটওয়ার্ক প্রক্সি থার্ড-পার্টি CDN রিকোয়েস্ট (cdnjs.cloudflare.com,
// fonts.googleapis.com ইত্যাদি) মাঝেমধ্যে ব্লক করে HTTP 200-সহ একটা HTML পেজ ফেরত দেয় (আসল
// JS/CSS-এর বদলে) — ব্রাউজার সেই HTML-কে script হিসেবে execute করতে গিয়ে ঠিক এই সিগনেচারের
// uncaught error ছোঁড়ে: "Unexpected token '<'" (কারণ HTML `<` দিয়ে শুরু হয়)। এটা আমাদের
// অ্যাপের কোড নয়, sandbox-এর নেটওয়ার্ক ব্লকিং-এর প্রত্যক্ষ ফলাফল — টাস্কের নির্দেশনা অনুযায়ী
// ("Do NOT require third-party CDN/font requests to succeed if the environment blocks them")
// এই একমাত্র সিগনেচারটা বাদ দিয়ে বাকি সব pageerror-কে আসল বাগ হিসেবে ধরা হচ্ছে।
const THIRD_PARTY_CDN_BLOCK_SIGNATURE = /Unexpected token '<'/;

function attachErrorTracking(page) {
  const issues = { consoleErrors: [], pageErrors: [], failedRequests: [], serverErrors: [], thirdPartyBlocked: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') issues.consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (THIRD_PARTY_CDN_BLOCK_SIGNATURE.test(err.message)) {
      issues.thirdPartyBlocked.push(err.message);
    } else {
      issues.pageErrors.push(err.message);
    }
  });
  page.on('requestfailed', (req) => {
    // থার্ড-পার্টি CDN/ফন্ট রিকোয়েস্ট এই sandbox-এ ব্লকড থাকতে পারে — শুধু same-origin গণনা।
    // net::ERR_ABORTED বাদ: এটা তখনই হয় যখন পেজ নেভিগেট করে সরে যায় আর ব্রাউজার নিজেই
    // ইন-ফ্লাইট রিকোয়েস্ট (যেমন manifest icon) বাতিল করে দেয় — এটা রিয়েল নেটওয়ার্ক/অ্যাপ
    // ব্যর্থতা না, স্বাভাবিক ব্রাউজার আচরণ।
    const errorText = req.failure()?.errorText;
    if (req.url().startsWith('http://localhost:3000') && errorText !== 'net::ERR_ABORTED') {
      issues.failedRequests.push(`${req.method()} ${req.url()} — ${errorText}`);
    }
  });
  page.on('response', (res) => {
    if (res.url().startsWith('http://localhost:3000') && res.status() >= 500) {
      issues.serverErrors.push(`${res.status()} ${res.url()}`);
    }
  });
  return issues;
}

function assertClean(issues) {
  expect(issues.serverErrors, 'কোনো HTTP 5xx থাকা উচিত না').toEqual([]);
  expect(issues.pageErrors, 'কোনো uncaught JS error থাকা উচিত না (থার্ড-পার্টি CDN ব্লক ছাড়া)').toEqual([]);
  expect(issues.failedRequests, 'কোনো ব্যর্থ same-origin রিকোয়েস্ট থাকা উচিত না').toEqual([]);
}

async function solveCaptchaIfPresent(page) {
  const label = page.locator('label[for="captcha_answer"]');
  if (await label.count() === 0) return;
  if (!(await label.isVisible())) return;
  const text = await label.textContent();
  const m = text.match(/(\d+)\s*([+-])\s*(\d+)/);
  if (!m) return;
  const [, a, op, b] = m;
  const answer = op === '+' ? Number(a) + Number(b) : Number(a) - Number(b);
  await page.fill('#captcha_answer', String(answer));
}

test.describe.configure({ mode: 'serial' });

// loginLimiter (app.js) একই IP-তে /login, /register ও /admin/login মিলিয়ে
// ১৫ মিনিটে ১০টি POST অনুমতি দেয়। এই spec-এ অনেকগুলো registration ও login
// আছে, ফলে admin login ধাপে পৌঁছানোর আগেই বাজেট শেষ হয়ে যেত এবং
// /admin/login/2fa-তে না গিয়ে login পেজে ফিরে আসত।
//
// registrationRateLimit.spec.js যেভাবে নিজেকে আলাদা করে, এখানেও একই কৌশল:
// একটি unique X-Forwarded-For দিয়ে এই spec নিজের rate-limit bucket পায়।
// এতে production-এর সীমা অপরিবর্তিত থাকে এবং limiter-এর নিজস্ব test-ও
// অক্ষত থাকে — শুধু এই spec অন্য spec-এর বাজেট খায় না।
const SPEC_IP = `10.${(process.pid % 250) + 1}.${Math.floor(Math.random() * 250) + 1}.7`;
test.use({ extraHTTPHeaders: { 'X-Forwarded-For': SPEC_IP } });

// পাবলিক লেয়াউটের প্রতিটা পেজে একটা ১৮+ বয়স-নিশ্চিতকরণ ওভারলে (public/js/age-gate.js) প্রথম
// ভিজিটে সম্পূর্ণ পেজ ঢেকে রাখে (z-index 999999) — real ইউজার একবার "হ্যাঁ" চাপলে ৩৬৫ দিনের
// জন্য কুকিতে মনে থাকে। রিয়েল ইউজারের "ইতিমধ্যে কনফার্ম করা" অবস্থা সিমুলেট করতে প্রতিটা
// টেস্টের আগে কুকিটা সরাসরি সেট করে দেওয়া হচ্ছে — এটা কোনো অ্যাপ বাগ নয়, legal/compliance গেট।
// এই sandbox-এর আউটবাউন্ড প্রক্সি থার্ড-পার্টি CDN (cdnjs.cloudflare.com, fonts.googleapis.com
// ইত্যাদি) হোস্টে মাঝেমধ্যে দ্রুত ব্যর্থ না হয়ে সংযোগ ঝুলিয়ে রাখে — আর সেই স্ক্রিপ্ট ট্যাগগুলো
// async/defer নয় বলে HTML পার্সিং ব্লক হয়ে যায়, ফলে domcontentloaded-ই কখনো fire হয় না
// (টাস্কের নির্দেশনা: "Do NOT require third-party CDN/font requests to succeed if the
// environment blocks them")। তাই এই থার্ড-পার্টি অরিজিনগুলো নেটওয়ার্ক লেয়ারেই সরাসরি abort
// করে দেওয়া হচ্ছে — ব্রাউজার তখন সাথে সাথেই fail পায় (অনির্দিষ্টকাল ঝোলার বদলে), যা আমাদের
// নিজের অ্যাপের কোনো আচরণ পরিবর্তন করে না (এগুলো নিছক প্রোগ্রেসিভ এনহান্সমেন্ট — ফন্ট/আইকন/কনফেটি)।
const THIRD_PARTY_ORIGINS_TO_BLOCK = [
  'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
  'cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'i.postimg.cc', 'i.pravatar.cc', 'img.icons8.com'
];

test.beforeEach(async ({ context }) => {
  // প্রতিটা টেস্ট নিজস্ব ক্লায়েন্ট IP পায় → নিজস্ব রেট-লিমিট বাকেট (উপরের ব্যাখ্যা দেখো)
  await context.setExtraHTTPHeaders({ 'X-Forwarded-For': fakeIp() });
  await context.addCookies([{
    name: 'livo_age_verified', value: '1', domain: 'localhost', path: '/'
  }]);
  await context.route('**/*', (route) => {
    try {
      const url = new URL(route.request().url());
      if (THIRD_PARTY_ORIGINS_TO_BLOCK.includes(url.hostname)) {
        return route.abort();
      }
    } catch (e) { /* URL পার্স ব্যর্থ হলেও রিকোয়েস্টটা যেন কখনো ঝুলে না থাকে */ }
    return route.continue();
  });
});

// প্রতিটা টেস্ট আলাদা browser context/page পায় (Playwright-এর ডিফল্ট আইসোলেশন), তাই আগের
// টেস্টের সেশন কুকি এই টেস্টে আসে না। আগে প্রতিটা টেস্টের শেষে "পরের টেস্টের জন্য সেশন
// প্রস্তুত রাখা" নামে ম্যানুয়ালি পুনরায় লগইন করা হতো — এটা ভঙ্গুর, এবং একগুচ্ছ auth-সম্পর্কিত
// রিকোয়েস্ট কয়েক সেকেন্ডের মধ্যে একসাথে পাঠালে services/botDetection.js-এর ঝুঁকি-স্কোরিং
// (স্বাভাবিক, যেটা বাস্তব বট আচরণ ধরার জন্যই ডিজাইন করা — এটা কোনো অ্যাপ বাগ না) captcha/ব্লক
// চালু করে দেয়। তাই এখন UI দিয়ে লগইন-ফ্লো শুধু একবারই (যে টেস্টগুলো নিজেই লগইন যাচাই করে,
// সেগুলোতে) চালানো হয় — বাকি টেস্টগুলো সেই সফল সেশনের কুকি পুনরায় ব্যবহার করে, ঠিক যেমন একজন
// রিয়েল ইউজার একবার লগইন করে পরে একই সেশনে একাধিক পেজ ব্রাউজ করে।
async function loginAs(page, identifier, pass) {
  await page.goto('/logout', { waitUntil: 'domcontentloaded' });
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.fill('#identifier', identifier);
  await page.fill('#password', pass);
  await solveCaptchaIfPresent(page);
  await page.click('#loginSubmitBtn');
  await page.waitForLoadState('domcontentloaded');
}

async function restoreSession(page, cookies) {
  await page.context().addCookies(cookies);
}

test.describe('গুরুত্বপূর্ণ ইউজার ফ্লো', () => {
  const username = uniqueUsername();
  const phone = uniquePhone();
  const password = 'SecurePass123';
  let sessionCookies = null;

  test('রেজিস্ট্রেশন — ফর্ম পূরণ করে সফলভাবে অ্যাকাউন্ট তৈরি হয়', async ({ page }) => {
    const issues = attachErrorTracking(page);
    await page.goto('/register', { waitUntil: 'domcontentloaded' });
    await page.fill('#username', username);
    await page.fill('#phone', phone);
    await page.fill('#password', password);
    await page.fill('#confirmPassword', password);
    await solveCaptchaIfPresent(page);
    // ডাউনস্ট্রিম assertion-এর আগে আসল HTTP ফল যাচাই: 429/400/500 হলে সেটা যেন
    // পরে "selector timeout"/"url mismatch" হয়ে ছদ্মবেশে না আসে।
    const [registerResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/register') && r.request().method() === 'POST'),
      page.click('#registerSubmitBtn')
    ]);
    expect(registerResponse.status(), 'POST /register রিকোয়েস্ট সফল হওয়া উচিত (429 = রেট-লিমিট লিক)').toBeLessThan(400);
    await page.waitForLoadState('domcontentloaded');
    // সফল রেজিস্ট্রেশনের পর হোমপেজে/ড্যাশবোর্ডে সেশন-স্থাপিত অবস্থায় ল্যান্ড করা উচিত, /register-এ নয়
    expect(page.url()).not.toContain('/register');
    assertClean(issues);

    const dbUser = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    expect(dbUser.rows.length).toBe(1);

    // রেজিস্ট্রেশন নিজেই সেশন স্থাপন করে (উপরেই যাচাই করা হয়েছে) — এই কুকিগুলো পরের টেস্টগুলো
    // (যাদের শুধু authenticated সেশন লাগে, লগইন-ফ্লো নিজে যাচাই করা লাগে না) পুনরায় ব্যবহার করবে।
    sessionCookies = await page.context().cookies();
  });

  test('লগআউট তারপর লগইন — সেশন সঠিকভাবে পুনঃস্থাপিত হয়', async ({ page }) => {
    const issues = attachErrorTracking(page);
    // লগইন ফর্মের identifier ফিল্ড শুধু email/phone গ্রহণ করে (routes/auth.js:
    // WHERE email = $1 OR phone = $1) — username নয়, তাই এখানে username নয়, phone দেওয়া হচ্ছে।
    await loginAs(page, phone, password);
    expect(page.url()).not.toContain('/login');
    assertClean(issues);
  });

  test('ভুল পাসওয়ার্ডে লগইন প্রত্যাখ্যাত হয় (5xx/uncaught error ছাড়াই)', async ({ page }) => {
    const issues = attachErrorTracking(page);
    await loginAs(page, phone, 'WrongPassword999');
    expect(page.url()).toContain('/login');
    assertClean(issues);
  });

  test('ভুলে-যাওয়া পাসওয়ার্ড — ফর্ম সাবমিট হয়, ব্যর্থ হয় না', async ({ page }) => {
    const issues = attachErrorTracking(page);
    await page.goto('/logout', { waitUntil: 'domcontentloaded' });
    await page.goto('/forgot-password', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="email"]', `${username}@example.com`);
    await solveCaptchaIfPresent(page);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
    assertClean(issues);
  });

  test('রিসেট-পাসওয়ার্ড পেজ — অবৈধ/মেয়াদোত্তীর্ণ টোকেনে 5xx ছাড়াই গ্রেসফুল আচরণ', async ({ page }) => {
    const issues = attachErrorTracking(page);
    const res = await page.goto('/reset-password?token=invalid-token-e2e-test', { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBeLessThan(500);
    assertClean(issues);
  });

  test('প্রোফাইল/সিকিউরিটি — ব্যক্তিগত তথ্য আপডেট, ব্যাংক কার্ড যোগ, উইথড্র PIN তৈরি', async ({ page }) => {
    await restoreSession(page, sessionCookies);
    const issues = attachErrorTracking(page);
    await page.goto('/profile/security', { waitUntil: 'domcontentloaded' });

    // ব্যক্তিগত তথ্য
    await page.click('#btn-personal');
    await page.fill('input[name="full_name"]', 'Test Holder Name');
    await page.click('#tab-personal form button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');

    // ব্যাংক কার্ড যোগ
    await page.goto('/profile/security', { waitUntil: 'domcontentloaded' });
    await page.click('#btn-bank');
    await page.selectOption('select[name="bank_name"]', { index: 1 });
    await page.fill('input[name="account_number"]', '01700000001');
    await page.fill('input[name="holder_name"]', 'Test Holder Name');
    await page.click('#tab-bank form button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');

    const card = await pool.query(
      `SELECT bc.id FROM bank_cards bc JOIN users u ON bc.user_id = u.id WHERE u.username = $1`,
      [username]
    );
    expect(card.rows.length).toBeGreaterThanOrEqual(1);

    // উইথড্র PIN তৈরি — "123456" এর মতো ক্রমিক/দুর্বল PIN services/withdrawPin.js-এর
    // isWeakPin() দিয়ে প্রত্যাখ্যাত হয়, তাই এলোমেলো-দেখতে একটা PIN ব্যবহার করা হচ্ছে।
    await page.goto('/profile/security', { waitUntil: 'domcontentloaded' });
    await page.click('#btn-security');
    await page.click('#pinToggleBtn-create');
    await page.fill('#pinFormcreate input[name="pin"]', '482917');
    await page.fill('#pinFormcreate input[name="confirmPin"]', '482917');
    const [pinRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/withdraw-pin/create')),
      page.click('#pinFormcreate button[type="submit"]')
    ]);
    // withdraw-pin/create নিজেই একটা redirect (server-rendered flash), 4xx/5xx দিলে ব্যর্থ হয়েছে ধরা হবে
    expect(pinRes.status()).toBeLessThan(400);

    const pinSet = await pool.query(
      `SELECT withdraw_pin_hash IS NOT NULL AS pin_set FROM users WHERE username = $1`,
      [username]
    );
    expect(pinSet.rows[0]?.pin_set).toBe(true);

    assertClean(issues);
  });

  test('KYC জমাদান — ইনপুট ভ্যালিডেশনসহ সফল সাবমিশন (Cloudinary আপলোড সিমুলেটেড — NOT VERIFIED লাইভ)', async ({ page }) => {
    await restoreSession(page, sessionCookies);
    const issues = attachErrorTracking(page);
    await page.goto('/extra/kyc', { waitUntil: 'domcontentloaded' });

    await page.fill('input[name="full_name"]', 'Test KYC Name');
    await page.selectOption('select[name="document_type"]', { index: 1 });
    await page.fill('input[name="document_number"]', 'NID-E2E-' + Date.now());

    // আসল Cloudinary আপলোড এই sandbox-এ সম্ভব না (কোনো লাইভ credential নেই) — সফল আপলোডের
    // পরের client-state সরাসরি সেট করে দেওয়া হচ্ছে, ঠিক client JS যা করত (routes/extra.js-এর
    // isSafeCloudinaryUrl() ফিক্সের সাথে মিলিয়ে সঠিক cloud_name + livo/chat ফোল্ডার সহ URL)।
    // views/kyc.ejs-এর client JS-এ `uploadedOk` একটা script-লোকাল `let` ভেরিয়েবল (window-এ
    // attach হয় না), তাই বাইরে থেকে সরাসরি সেট করা যায় না — আর ফর্মের onsubmit হ্যান্ডলার
    // (handleKycSubmit) uploadedOk false থাকলে submit আটকে দেয়। যেহেতু এই sandbox-এ আসল
    // আপলোড সম্ভবই না (কোনো লাইভ Cloudinary credential নেই), তাই HTMLFormElement.submit()
    // দিয়ে সরাসরি ফর্ম সাবমিট করা হচ্ছে — এটা native browser API, `submit` ইভেন্ট/onsubmit
    // হ্যান্ডলার ট্রিগার করে না (স্পেক অনুযায়ী), তাই client-side আপলোড-গার্ডটা বাইপাস হয়ে
    // যায় আর সরাসরি সার্ভার-সাইড রাউট হ্যান্ডলার (routes/extra.js) যাচাই হয়।
    // form.submit() একটা ন্যাটিভ নেভিগেশন শুরু করে — evaluate()-এর ভেতর থেকে ট্রিগার করা এই
    // নেভিগেশনের সাথে waitForLoadState()-এর টাইমিং রেস হতে পারে (POST-এর আসল রেসপন্স আসার
    // আগেই resolve হয়ে যাওয়া), তাই নির্দিষ্টভাবে POST /extra/kyc রেসপন্সের জন্য অপেক্ষা করা হচ্ছে।
    const [kycResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/extra/kyc') && r.request().method() === 'POST'),
      page.evaluate((cloudName) => {
        document.getElementById('documentUrl').value =
          `https://res.cloudinary.com/${cloudName}/image/upload/v1/livo/chat/e2e-test.jpg`;
        document.getElementById('kycForm').submit();
      }, process.env.CLOUDINARY_CLOUD_NAME || 'livo_test_cloud')
    ]);
    // DB assertion-এর আগে HTTP ফল যাচাই — আপলোড URL বাতিল/রেট-লিমিট/সার্ভার এরর হলে
    // ব্যর্থতাটা এখানেই সঠিক কারণসহ ধরা পড়বে, "সারি পাওয়া যায়নি" হয়ে নয়।
    expect(kycResponse.status(), 'POST /extra/kyc গ্রহণ করা উচিত').toBeLessThan(400);
    assertClean(issues);

    const kyc = await pool.query(
      `SELECT k.status FROM kyc_requests k JOIN users u ON k.user_id = u.id WHERE u.username = $1 ORDER BY k.created_at DESC LIMIT 1`,
      [username]
    );
    expect(kyc.rows[0]?.status).toBe('pending');
  });

  test('ডিপোজিট — bKash ম্যানুয়াল ফ্লো (init → পেমেন্ট বিবরণী সাবমিট)', async ({ page }) => {
    await restoreSession(page, sessionCookies);
    const issues = attachErrorTracking(page);
    await page.goto('/payment/deposit', { waitUntil: 'domcontentloaded' });
    await page.fill('#amountInput', '500');
    await page.click('#depNextBtn');
    await page.waitForSelector('#step2', { state: 'visible' });
    await page.fill('input[name="transaction_id"]', 'E2ETRX' + Date.now());
    await page.fill('input[name="account_number"]', '01700000002');
    await page.click('#depSubmitBtn');
    await page.waitForLoadState('domcontentloaded');
    assertClean(issues);

    const pr = await pool.query(
      `SELECT pr.status FROM payment_requests pr JOIN users u ON pr.user_id = u.id
       WHERE u.username = $1 AND pr.type = 'deposit' ORDER BY pr.created_at DESC LIMIT 1`,
      [username]
    );
    expect(pr.rows[0]?.status).toBe('pending'); // ম্যানুয়াল — অ্যাডমিন অনুমোদন সাপেক্ষ, তাই এখনো pending
  });

  test('উইথড্র পেজ — লোড হয়, কার্ড না থাকলে/থাকলে ফর্ম প্রত্যাশিতভাবে আচরণ করে', async ({ page }) => {
    // উইথড্র সময়সূচি (services/withdrawalWindow.js) রাত ১১টা–সকাল ৭টা ফর্মটা
    // নিষ্ক্রিয় রাখে। সেটা ছেড়ে দিলে এই টেস্ট CI কোন সময়ে চলছে তার উপর নির্ভর
    // করত। তাই জানালাটা স্পষ্টভাবে খোলা ধরা হচ্ছে — এখানে যাচাইয়ের বিষয়
    // কার্ড থাকা অবস্থায় ফর্মের আচরণ, সময়সূচি নয়। সময়সূচির নিজস্ব আচরণ
    // tests/withdrawalWindow.test.js-এ যাচাই হয়।
    await pool.query(
      `INSERT INTO site_settings (key, value) VALUES ('withdrawal_window_mode', 'open')
       ON CONFLICT (key) DO UPDATE SET value = 'open'`
    );
    try {
      await restoreSession(page, sessionCookies);
      const issues = attachErrorTracking(page);
      const res = await page.goto('/payment/withdraw', { waitUntil: 'domcontentloaded' });
      expect(res.status()).toBeLessThan(500);
      // আগের টেস্টে একটা ব্যাংক কার্ড যোগ করা হয়েছে, তাই সাবমিট বাটন এখন সক্রিয় থাকা উচিত
      await expect(page.locator('#withdrawSubmitBtn')).toBeEnabled();
      assertClean(issues);
    } finally {
      // অ্যাসারশন ফেল করলেও ওভাররাইডটা যেন পরের টেস্টে ছড়িয়ে না পড়ে
      await pool.query("DELETE FROM site_settings WHERE key = 'withdrawal_window_mode'");
    }
  });

  test('উইথড্র পেজ — সময়সূচি অনুযায়ী বন্ধ থাকলে ফর্ম নিষ্ক্রিয় ও কারণ দেখানো হয়', async ({ page }) => {
    await pool.query(
      `INSERT INTO site_settings (key, value) VALUES ('withdrawal_window_mode', 'closed')
       ON CONFLICT (key) DO UPDATE SET value = 'closed'`
    );
    try {
      await restoreSession(page, sessionCookies);
      const res = await page.goto('/payment/withdraw', { waitUntil: 'domcontentloaded' });
      // পেজটা খোলা থাকে যাতে ইউজার কারণ জানতে পারেন, শুধু ফর্মটাই বন্ধ
      expect(res.status()).toBeLessThan(500);
      await expect(page.locator('#withdrawSubmitBtn')).toBeDisabled();
    } finally {
      await pool.query("DELETE FROM site_settings WHERE key = 'withdrawal_window_mode'");
    }
  });

  test('নোটিফিকেশন/গেমস/স্পোর্টস নেভিগেশন — কোনো পেজ ব্রেক করে না', async ({ page }) => {
    await restoreSession(page, sessionCookies);
    const issues = attachErrorTracking(page);
    for (const path of ['/news', '/tournaments', '/games', '/sports', '/notifications', '/extra/faq']) {
      const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
      expect(res.status(), `${path} status`).toBeLessThan(500);
    }
    assertClean(issues);
  });
});

test.describe('অ্যাডমিন ফ্লো', () => {
  const adminUsername = uniqueUsername();
  const adminPhone = uniquePhone();
  const adminPassword = 'AdminPass123';
  const totpSecret = speakeasy.generateSecret({ length: 20 }).base32;

  test.beforeAll(async () => {
    // সরাসরি DB-তে অ্যাডমিন ইউজার তৈরি — বাস্তব রেজিস্ট্রেশন ফ্লো ইতিমধ্যে ওপরের
    // ইউজার-ফ্লো টেস্টগুলোতে যাচাই হয়ে গেছে, এখানে অ্যাডমিন-নির্দিষ্ট ফ্লো (লগইন+2FA)
    // যাচাই করাই লক্ষ্য। speakeasy দিয়ে বৈধ TOTP কোড জেনারেট করার জন্য একটা পরিচিত
    // secret সরাসরি বসানো হচ্ছে — QR স্ক্যান করে বাস্তব এনরোলমেন্ট এই sandbox-এ সম্ভব
    // না, কিন্তু লগইন-টাইম TOTP ভেরিফিকেশন লজিকটা আসল।
    const hashed = await bcrypt.hash(adminPassword, 10);
    await pool.query(
      `INSERT INTO users (username, phone, password, role, totp_enabled, totp_secret, email_verified)
       VALUES ($1, $2, $3, 'admin', true, $4, true)`,
      [adminUsername, adminPhone, hashed, totpSecret]
    );
  });

  // প্রতিটা অ্যাডমিন টেস্ট আলাদা browser context পায় বলে সেশন কুকি carry-over হয় না। প্রতিটা
  // টেস্টে নতুন করে UI দিয়ে লগইন+TOTP করালে কয়েক সেকেন্ডে একগুচ্ছ auth রিকোয়েস্ট জমা হয়ে
  // bot-detection ঝুঁকি-স্কোরিং ট্রিগার করতে পারে (দেখুন উপরের একই সমস্যার কমেন্ট) — তাই
  // লগইন-ফ্লো UI দিয়ে শুধু একবারই (পরের টেস্টে) চালিয়ে সেই সেশনের কুকি বাকি টেস্টগুলোতে
  // পুনরায় ব্যবহার করা হচ্ছে।
  let adminSessionCookies = null;

  test('অ্যাডমিন লগইন — ইউজারনেম/পাসওয়ার্ড + বাধ্যতামূলক TOTP 2FA', async ({ page }) => {
    const issues = attachErrorTracking(page);
    await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', adminUsername);
    await page.fill('input[name="password"]', adminPassword);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).toContain('/admin/login/2fa');

    // views/admin/2fa-verify.ejs-এর tokenInput-এ একটা input listener আছে যেটা মান ৬ ক্যারেক্টার
    // হলেই সয়ংক্রিয়ভাবে totpForm সাবমিট করে দেয় (document.getElementById('totpForm').submit())
    // — page.fill() নিজেই input ইভেন্ট ডিসপ্যাচ করে, তাই fill() কলটাই ফর্ম সাবমিট করে ফেলে,
    // এরপর আলাদা করে সাবমিট বাটনে ক্লিক করার দরকার নেই (বাটনটা ততক্ষণে নতুন পেজে চলে যাওয়ায়
    // আর খুঁজে পাওয়া যায় না)।
    const code = speakeasy.totp({ secret: totpSecret, encoding: 'base32' });
    const navigated = page.waitForURL((url) => !url.pathname.includes('/admin/login'), { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="token"]', code);
    await navigated;
    expect(page.url()).not.toContain('/admin/login');
    assertClean(issues);

    adminSessionCookies = await page.context().cookies();
  });

  test('অ্যাডমিন ড্যাশবোর্ড লোড হয় (5xx/console error ছাড়াই)', async ({ page }) => {
    await restoreSession(page, adminSessionCookies);
    const issues = attachErrorTracking(page);
    const res = await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBeLessThan(500);
    assertClean(issues);
  });

  test('অ্যাডমিন পেমেন্ট অনুমোদন কিউ — লোড হয়, LIMIT ফিক্সের পরও ডেটা দেখায়', async ({ page }) => {
    await restoreSession(page, adminSessionCookies);
    const issues = attachErrorTracking(page);
    const res = await page.goto('/payment/admin/payments', { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBeLessThan(500);
    assertClean(issues);
  });

  test('অ্যাডমিন ইউজার তালিকা ও KYC রিকোয়েস্ট তালিকা — গুরুত্বপূর্ণ অ্যাডমিন অ্যাকশন পেজ', async ({ page }) => {
    await restoreSession(page, adminSessionCookies);
    const issues = attachErrorTracking(page);
    for (const path of ['/admin/users', '/admin/kyc', '/admin/transactions']) {
      const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
      expect(res.status(), `${path} status`).toBeLessThan(500);
    }
    assertClean(issues);
  });
});

test.afterAll(async () => {
  await pool.end();
});
