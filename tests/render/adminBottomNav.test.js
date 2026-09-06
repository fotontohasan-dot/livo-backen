// tests/render/adminBottomNav.test.js
// ---------------------------------------------------------------------------
// Phase 7 — মোবাইল বটম নেভিগেশন।
//
// অডিটে পাওয়া চারটা আসল সমস্যা, প্রতিটার জন্য একটা করে গার্ড:
//   ১. z-index: 500 — নতুন সাইডবার ড্রয়ার (z-50) ও ব্যাকড্রপ (z-40)-এর অনেক
//      উপরে। মোবাইলে ড্রয়ার খুললে বটম নেভ তার উপরে ভেসে থাকত।
//   ২. ডেস্কটপেও দেখা যেত — সাইডবারের পাশাপাশি দ্বিতীয় প্রতিদ্বন্দ্বী
//      নেভিগেশন সিস্টেম, যেটা স্পেক স্পষ্টভাবে নিষেধ করে।
//   ৩. `/admin/dashboard` একটা রিডাইরেক্ট-অনলি রুট — প্রতিবার হোমে যেতে
//      বাড়তি HTTP রাউন্ড-ট্রিপ।
//   ৪. সম্পূর্ণ নেভিগেশনে কোনো পথ ছিল না ("More/Menu")।
// ---------------------------------------------------------------------------

const { readScript } = require('../helpers/viewScripts');
const fs = require('fs');
const path = require('path');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const { cleanupUsers } = require('../helpers/cleanup');

// তৈরি করা অ্যাডমিন ইউজার রেখে গেলে পরে চলা অ্যাডমিন-গণনা নির্ভর suite
// (admin, rbac) ভুল সংখ্যা দেখে ফেল করত — CI-এর একটানা রানে।
const createdUserIds = [];
afterAll(async () => { await cleanupUsers(createdUserIds); });

const ROOT = path.join(__dirname, '..', '..');
const BN_SRC = fs.readFileSync(path.join(ROOT, 'views/admin/partials/bottom-nav.ejs'), 'utf8');
const LAYOUT = fs.readFileSync(path.join(ROOT, 'views/admin/partials/admin-layout.ejs'), 'utf8');
const bn = require('../../locales/bn.json');
const en = require('../../locales/en.json');

async function makeAdminAgent(lang) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('btm');
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123',
            confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query("UPDATE users SET role='admin' WHERE username=$1", [username]);
  if (lang) await agent.get('/lang/' + lang);
  const r = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
  if (r.rows[0]) createdUserIds.push(r.rows[0].id);
  return agent;
}

describe('বটম নেভ — সাইডবার ড্রয়ারের সাথে সংঘাত নেই', () => {
  test('z-index ড্রয়ার (z-50) ও ব্যাকড্রপ (z-40)-এর নিচে', () => {
    const m = BN_SRC.match(/\.admin-bottom-nav\s*\{[\s\S]*?z-index:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeLessThan(40);
  });

  test('ডেস্কটপে (lg+) বটম নেভ লুকানো — দ্বিতীয় নেভিগেশন সিস্টেম নয়', () => {
    expect(BN_SRC).toMatch(/@media\s*\(min-width:\s*1024px\)[\s\S]*?\.admin-bottom-nav[\s\S]*?display:\s*none/);
  });

  // docs/CSP.md ধাপ ৩-এ লেআউট ও বটম-নেভের কোড
  // public/js/views/-এ সরানো হয়েছে, তাই সংজ্ঞা ও ক্রম এখন ওখানে যাচাই হয়।
  const LAYOUT_JS = readScript('/js/views/admin-partials-admin-layout.js');

  test('openMobileSidebar() গ্লোবাল স্কোপে সংজ্ঞায়িত, তাই বটম নেভ থেকে ডাকা যায়', () => {
    // টপ-লেভেল function declaration — ব্রাউজারে window-এর প্রপার্টি হয়।
    // কোনো IIFE/ব্লকের ভেতরে ঢুকে গেলে "More" নিঃশব্দে কাজ করা বন্ধ করত।
    expect(LAYOUT_JS).toMatch(/^function openMobileSidebar\(\)/m);
  });

  test('openMobileSidebar()-এর সংজ্ঞা বটম-নেভ include-এর আগে আসে', () => {
    // আগে দুটোই একই ফাইলে ছিল, তাই সূচক তুলনা করলেই হত। এখন সংজ্ঞাটা
    // লেআউটের স্ক্রিপ্ট ফাইলে আর ব্যবহার বটম-নেভের ফাইলে — তাই যাচাই হয়
    // লেআউটের <script src> ট্যাগটা include-এর আগে বসেছে কি না।
    const scriptIdx = LAYOUT.indexOf('/js/views/admin-partials-admin-layout.js');
    const incIdx = LAYOUT.indexOf("include('./bottom-nav')");
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(incIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeLessThan(incIdx);
    expect(LAYOUT_JS).toContain('function openMobileSidebar()');
  });

  test('কনটেন্ট এলাকায় বটম নেভের জন্য জায়গা রাখা আছে (কনটেন্ট ঢাকা পড়ে না)', () => {
    expect(LAYOUT).toContain('admin-content-scroll');
    expect(LAYOUT).toMatch(/\.admin-content-scroll\s*\{\s*padding-bottom/);
    expect(LAYOUT).toMatch(/safe-area-inset-bottom/);
  });
});

describe('বটম নেভের গঠন', () => {
  test('ডেড/রিডাইরেক্ট লিংক নেই — হোম সরাসরি /admin', () => {
    expect(BN_SRC).not.toContain('href="/admin/dashboard"');
    expect(BN_SRC).toContain('href="/admin"');
  });

  test('সম্পূর্ণ নেভিগেশনে পৌঁছানোর "More" পথ আছে', () => {
    expect(BN_SRC).toContain('adminBnMore');
    // বটম-নেভের কোডও এখন বাইরের ফাইলে
    expect(BN_SRC + readScript('/js/views/admin-partials-bottom-nav.js'))
      .toMatch(/openMobileSidebar/);
    expect(BN_SRC).toMatch(/aria-controls="adminSidebar"/);
  });

  test('সর্বোচ্চ ৫টা এন্ট্রি — মোবাইলে ভিড় হয় না', () => {
    const links = (BN_SRC.match(/<a\s[^>]*(?:href|id)=/g) || []).length;
    expect(links).toBeGreaterThan(0);
    expect(links).toBeLessThanOrEqual(5);
  });

  test('টাচ টার্গেট অন্তত 44px (Phase 9)', () => {
    const m = BN_SRC.match(/\.admin-bottom-nav a \{ min-height:\s*(\d+)px/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(44);
  });

  test('লেবেল হার্ডকোড নয় — i18n থেকে আসে', () => {
    for (const k of ['admin_bn_home', 'admin_bn_deposit', 'admin_bn_withdraw',
                     'admin_bn_chat', 'admin_bn_more']) {
      expect(BN_SRC).toContain(`t('${k}')`);
      expect(bn[k]).toBeTruthy();
      expect(en[k]).toBeTruthy();
    }
  });
});

describe('বটম নেভ — আসল রেন্ডার', () => {
  let bnAgent, enAgent;
  beforeAll(async () => {
    bnAgent = await makeAdminAgent(null);
    enAgent = await makeAdminAgent('en');
  });

  test('অ্যাডমিন পেজে ঠিক একবারই রেন্ডার হয় (ডুপ্লিকেট নেই)', async () => {
    for (const p of ['/admin', '/admin/kyc', '/admin/features']) {
      const res = await bnAgent.get(p);
      expect(res.status).toBe(200);
      expect((res.text.match(/class="admin-bottom-nav"/g) || []).length).toBe(1);
    }
  });

  test('লেবেল ভাষা অনুযায়ী বদলায়', async () => {
    const resEn = await enAgent.get('/admin');
    expect(resEn.text).toContain('>' + en.admin_bn_more + '<');
    const resBn = await bnAgent.get('/admin');
    expect(resBn.text).toContain('>' + bn.admin_bn_more + '<');
  });

  test('বটম নেভের প্রতিটা লিংক আসল রুটে যায় — ডেড লিংক নেই', async () => {
    for (const href of ['/admin', '/payment/admin/payments?tab=deposit',
                        '/payment/admin/payments?tab=withdraw', '/chat/admin']) {
      const r = await bnAgent.get(href);
      expect(r.status).not.toBe(404);
      expect(r.status).not.toBe(500);
      // রিডাইরেক্ট নয় — সরাসরি পেজ (বাড়তি রাউন্ড-ট্রিপ এড়াতে)
      expect(r.status).toBe(200);
    }
  });

  test('/api/notification-counts এখন kyc সংখ্যাও দেয় ("More" ব্যাজের জন্য)', async () => {
    const res = await bnAgent.get('/admin/api/notification-counts');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.kyc).toBe('number');
    const actual = (await pool.query(
      "SELECT COUNT(*)::int c FROM kyc_requests WHERE status='pending'")).rows[0].c;
    expect(res.body.kyc).toBe(actual);
  });
});
