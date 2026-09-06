// tests/render/adminInlineScriptIntegrity.test.js
// ---------------------------------------------------------------------------
// প্রতিটা অ্যাডমিন পেজের ইনলাইন <script> ব্রাউজারে পার্স হয় কিনা।
//
// কেন দরকার: বিদ্যমান রেন্ডার টেস্টগুলো HTML দেখে — স্ট্যাটাস কোড, নির্দিষ্ট
// টেক্সট, EJS এরর। কিন্তু সার্ভার নিখুঁত HTML পাঠিয়েও তার ভেতরে অবৈধ
// JavaScript থাকতে পারে; তখন পেজ "রেন্ডার হয়েছে" মনে হয় অথচ ব্রাউজারে সব
// ইন্টারঅ্যাকশন মরে থাকে।
//
// ঠিক সেটাই হয়েছিল: kyc.ejs-এ একটা `${...}` ইন্টারপোলেশন হুবহু ব্রাউজারে
// চলে যাচ্ছিল (ফাইলটা admin-layout-এর body ব্যাকটিক প্যাটার্ন ব্যবহার করে না),
// ফলে গোটা স্ক্রিপ্ট ব্লক সিনট্যাক্স এররে ভেঙে পড়ত — মডাল, বাল্ক অ্যাকশন,
// ডকুমেন্ট প্রিভিউ কিছুই কাজ করত না। Jest সেটা ধরেনি, ধরেছিল E2E।
// এই টেস্ট সেই ফাঁকটা Jest স্তরেই বন্ধ করে।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const { cleanupUsers } = require('../helpers/cleanup');

const PAGES = [
  '/admin', '/admin/users', '/admin/kyc', '/admin/features', '/admin/settings',
  '/admin/reports', '/admin/security-overview', '/admin/audit-logs',
  '/admin/matches', '/admin/games', '/admin/news', '/admin/announcements',
  '/payment/admin/payments', '/payment/admin/deposits',
  // docs/CSP.md ধাপ ৩-এ এই পেজগুলোর কোড JSON ডেটা ব্লক + বাইরের স্ক্রিপ্টে
  // ভাগ করা হয়েছে। এদের body একটা JS template literal, তাই JSON-টা
  // ${...} দিয়ে বসানো হয় — একটা ভুল escape করলেই ব্লকটা অবৈধ JSON হয়ে
  // যেত এবং পেজের সব আচরণ নীরবে বন্ধ হত। তাই এরা তালিকায়।
  // '/admin/markets' বাদ — ওই পাথে কোনো রুট নেই (404)।
  '/admin/bets', '/admin/support'
];

const createdUserIds = [];
let agent;

beforeAll(async () => {
  const r = await getCsrfAgent('/register');
  const username = uniqueUsername('injs');
  await r.agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123',
            confirmPassword: 'SecurePass123', _csrf: r.token });
  const row = await pool.query("UPDATE users SET role='admin' WHERE username=$1 RETURNING id", [username]);
  if (row.rows[0]) createdUserIds.push(row.rows[0].id);
  agent = r.agent;
});

afterAll(async () => { await cleanupUsers(createdUserIds); });

// কমেন্ট বাদ দেওয়া হয় — কমেন্টের ভেতরে ${ বা অদ্ভুত টোকেন থাকা নিরীহ।
function stripComments(js) {
  return js.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// `<script type="application/json">` ব্লক executable নয় — ব্রাউজার ওটা
// পার্সও করে না, শুধু ডেটা হিসেবে ধরে রাখে (CSP মাইগ্রেশনে ইনলাইন কোডের
// বদলে এই ব্লক ব্যবহার করা হয়)। ওগুলো JS হিসেবে পার্স করতে গেলে JSON
// অবজেক্টের `{` ব্লক-স্টেটমেন্ট হিসেবে পড়ে `Unexpected token ':'` দেয়।
// তাই এখানে দুই ভাগ: executable ব্লক JS হিসেবে যাচাই, ডেটা ব্লক JSON হিসেবে।
const EXECUTABLE_TYPE = /\btype\s*=\s*["']?(?!text\/javascript|module|application\/javascript)[^"'\s>]+/i;

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(m => !EXECUTABLE_TYPE.test(m[1]))
    .map(m => m[2])
    .filter(js => js.trim().length > 0);
}

function jsonScripts(html) {
  return [...html.matchAll(/<script[^>]*\btype\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1])
    .filter(text => text.trim().length > 0);
}

describe('অ্যাডমিন পেজের ইনলাইন স্ক্রিপ্ট বৈধ JavaScript', () => {
  test.each(PAGES)('%s — প্রতিটা ইনলাইন <script> পার্স হয়', async (path) => {
    const res = await agent.get(path);
    expect([200, 302]).toContain(res.status);
    if (res.status !== 200) return;

    const scripts = inlineScripts(res.text);
    for (const js of scripts) {
      // new Function() শুধু পার্স করে, চালায় না — সিনট্যাক্স যাচাইয়ের নিরাপদ উপায়।
      expect(() => new Function(js)).not.toThrow();
    }
  });

  test.each(PAGES)('%s — প্রতিটা application/json ব্লক বৈধ JSON', async (path) => {
    const res = await agent.get(path);
    if (res.status !== 200) return;

    for (const text of jsonScripts(res.text)) {
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  test.each(PAGES)('%s — সার্ভার-সাইড টেমপ্লেট ইন্টারপোলেশন ব্রাউজারে ফাঁস হয়নি', async (path) => {
    const res = await agent.get(path);
    if (res.status !== 200) return;
    for (const js of inlineScripts(res.text)) {
      // ক্লায়েন্ট-সাইড টেমপ্লেট লিটারেল বৈধ, তাই শুধু সেই `${` ধরা হয় যেটা
      // একটা আইডেন্টিফায়ার দিয়ে শুরু হয়েও অরেন্ডার অবস্থায় রয়ে গেছে —
      // অর্থাৎ `${JSON.stringify(` বা `${t(` ধরনের সার্ভার-সাইড কল।
      expect(stripComments(js)).not.toMatch(/\$\{\s*(?:JSON\.stringify|t\(|esc\(|escapeHtml\()/);
    }
  });
});
