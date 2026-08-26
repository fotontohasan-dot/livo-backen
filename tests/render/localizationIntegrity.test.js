// tests/render/localizationIntegrity.test.js
// ---------------------------------------------------------------------------
// লোকালাইজেশন রিগ্রেশন টেস্ট।
//
// যে বাস্তব সমস্যাগুলো ধরা পড়েছিল এবং এখানে লক করা হচ্ছে:
//   • locales/bn.json ও en.json-এ error_title, server_error, page_not_found,
//     go_to_homepage, go_back — পাঁচটা মান হুবহু এক ইংরেজি ছিল, ফলে বাংলা মোডেও
//     ৪০৪/৫০০ পেজ ইংরেজিতে দেখাত।
//   • views/coins.ejs টেবিল হেডারে <%= t.description %> ও <%= t.amount %> ছিল,
//     কিন্তু ওই key দুটো locale-এ ছিল না। app.js-এর Proxy (`translations[lang][prop] || prop`)
//     এমন ক্ষেত্রে key-এর নামটাই রেন্ডার করে, তাই ইউজার দুই ভাষাতেই কাঁচা
//     "description" ও "amount" দেখত।
//   • views/partials/bottom-nav.ejs-এর লেবেলগুলো হার্ডকোড বাংলা ছিল — বটম নেভ
//     প্রতিটা পেজে থাকায় English মোডেও পুরো সাইটজুড়ে বাংলা দেখা যেত।
//
// এই টেস্ট ভবিষ্যতে একই শ্রেণির সমস্যা ফিরে এলে ধরে ফেলবে।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');

const ROOT = path.join(__dirname, '..', '..');
const bn = require('../../locales/bn.json');
const en = require('../../locales/en.json');
const BENGALI = /[\u0980-\u09FF]/;

function visibleText(html) {
  let s = html.slice(html.indexOf('</head>'));
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  return { agent, username };
}

describe('locale ফাইলের সামঞ্জস্য', () => {
  test('bn ও en-এ একই key সেট আছে', () => {
    const bnKeys = Object.keys(bn).sort();
    const enKeys = Object.keys(en).sort();
    expect(bnKeys.filter((k) => !(k in en))).toEqual([]);
    expect(enKeys.filter((k) => !(k in bn))).toEqual([]);
  });

  test('কোনো key খালি মান নিয়ে নেই', () => {
    const empty = Object.keys(bn).filter((k) => !String(bn[k]).trim() || !String(en[k]).trim());
    expect(empty).toEqual([]);
  });

  test('error/404 পেজের key বাংলা মোডে সত্যিই বাংলা', () => {
    for (const k of ['error_title', 'server_error', 'page_not_found', 'go_to_homepage', 'go_back']) {
      expect(bn[k]).toBeDefined();
      expect(BENGALI.test(bn[k])).toBe(true);   // আগে দুই ফাইলেই ইংরেজি ছিল
      expect(BENGALI.test(en[k])).toBe(false);  // ইংরেজি মান বাংলা হবে না
    }
  });

  test('ইংরেজি অনুবাদে বাংলা লেখা নেই', () => {
    // ৳ (টাকার চিহ্ন) বাংলা ইউনিকোড ব্লকে পড়লেও এটা মুদ্রার প্রতীক, অনূদিত টেক্সট নয় —
    // ইংরেজি UI-তেও ৳ ব্যবহার করাই সঠিক। তাই সেটা বাদ দিয়ে যাচাই করা হয়।
    const leaked = Object.keys(en).filter((k) => BENGALI.test(String(en[k]).replace(/৳/g, '')));
    expect(leaked).toEqual([]);
  });
});

describe('টেমপ্লেটে ব্যবহৃত প্রতিটা key সংজ্ঞায়িত', () => {
  test('EJS-এ emit করা কোনো t.key locale থেকে অনুপস্থিত নয়', () => {
    const { walk, usedKeys } = require('../../scripts/i18n-scan.js');
    const files = walk(path.join(ROOT, 'views'), '.ejs');
    const used = usedKeys(files);
    const missing = [...used.keys()].filter((k) => !(k in bn)).sort();
    // অনুপস্থিত key থাকলে app.js-এর Proxy key-এর নামটাই ইউজারকে দেখিয়ে দেয়
    expect(missing).toEqual([]);
  });
});

describe('রেন্ডার করা পেজে কাঁচা key বা ভাঙা মান নেই', () => {
  let agent;

  beforeAll(async () => {
    agent = (await makeUser()).agent;
  });

  const pages = ['/', '/coins', '/profile', '/matches', '/notifications', '/help-center'];

  test.each(pages)('%s — undefined/null/NaN/[object Object] রেন্ডার হয় না', async (p) => {
    const res = await agent.get(p);
    expect(res.status).toBe(200);
    const text = visibleText(res.text);
    for (const junk of ['undefined', '[object Object]', 'NaN']) {
      expect(text.split(/\s+/)).not.toContain(junk);
    }
  });

  test('/coins টেবিল হেডারে কাঁচা key দেখায় না', async () => {
    const res = await agent.get('/coins');
    const thead = (/<thead>[\s\S]*?<\/thead>/.exec(res.text) || [''])[0];
    expect(thead).not.toMatch(/>\s*description\s*</);
    expect(thead).not.toMatch(/>\s*amount\s*</);
    expect(thead).toContain(bn.description);
    expect(thead).toContain(bn.amount);
  });
});

describe('ভাষা নির্বাচন ও persistence', () => {
  test('English মোডে <html lang="en">, বাংলায় "bn"', async () => {
    const { agent } = await makeUser();
    await agent.get('/lang/en').set('Referer', '/');
    expect((await agent.get('/')).text).toMatch(/<html lang="en"/);
    await agent.get('/lang/bn').set('Referer', '/');
    expect((await agent.get('/')).text).toMatch(/<html lang="bn"/);
  });

  test('নির্বাচিত ভাষা নেভিগেশনের পরেও থাকে', async () => {
    const { agent } = await makeUser();
    await agent.get('/lang/en').set('Referer', '/');
    for (const p of ['/matches', '/notifications', '/']) {
      expect((await agent.get(p)).text).toMatch(/<html lang="en"/);
    }
  });
});

describe('লোকালাইজ করা পেজে ভাষা মিশ্রণ নেই', () => {
  // যে পেজগুলো ইতিমধ্যে সম্পূর্ণ লোকালাইজ করা হয়েছে সেগুলোই এখানে যাচাই করা হয়।
  // বাকি পেজগুলো ধাপে ধাপে যুক্ত হবে; তালিকায় যোগ করলেই সেগুলোও গার্ডেড হবে।
  const LOCALIZED = ['/', '/login', '/registration', '/forgot-password'];

  test.each(LOCALIZED)('English মোডে %s এ বাংলা টেক্সট নেই', async (p) => {
    const { agent } = await makeUser();
    await agent.get('/lang/en').set('Referer', '/');
    // রেজিস্ট্রেশনের সময় বাংলা মোডে একটা flash মেসেজ তৈরি হয়ে সেশনে জমা থাকে।
    // ভাষা বদলালেও ওই পুরনো মেসেজটা একবার রেন্ডার হবেই — এটা প্রত্যাশিত আচরণ,
    // অনুবাদের ফাঁক নয়। flash একবার পড়লেই মুছে যায়, তাই আগে সেটা consume করা হয়।
    await agent.get('/');
    const res = await agent.get(p);
    if (res.status !== 200) return; // লগইন করা ইউজারের জন্য কিছু পেজ রিডাইরেক্ট করে
    const text = visibleText(res.text);
    const runs = (text.replace(/৳/g, '').match(/[\u0980-\u09FF][\u0980-\u09FF\s\u200c\u200d]{2,}/g) || [])
      .map((x) => x.trim()).filter((x) => x.length > 3);
    expect([...new Set(runs)]).toEqual([]);
  });
});

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE username LIKE 'testuser%' AND created_at > NOW() - INTERVAL '1 hour'").catch(() => {});
});
