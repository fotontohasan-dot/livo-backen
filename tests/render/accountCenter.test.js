// tests/render/accountCenter.test.js
// ---------------------------------------------------------------------------
// অ্যাকাউন্ট সেন্টার (প্রোফাইল) রিগ্রেশন টেস্ট।
//
// আগে মেম্বার সেন্টারে ৫টা বড় "হাব" টাইল ছিল (Wallet/VIP/Reward/Account/Support)।
// প্রতিটাতে ট্যাপ করলে নিচে একটা অ্যাকর্ডিয়ন প্যানেল খুলত — অর্থাৎ কার্ডের ভেতরে কার্ড,
// আর "মিশন" বা "লগইন হিস্টোরি"-র মতো আইটেম কোন হাবের ভেতরে আছে সেটা ইউজারকে আন্দাজ
// করতে হতো, দুই ট্যাপ ছাড়া পৌঁছানো যেত না।
//
// এখন প্রতিটা আইটেম স্বাধীন ও সরাসরি দৃশ্যমান, বিষয়ভিত্তিক সেকশনে ভাগ করা।
// এই টেস্ট নিশ্চিত করে —
//   ১) লগআউট অবস্থায় অ্যাকাউন্ট সেন্টারে ঢোকা যায় না;
//   ২) লগইন অবস্থায় ইউজারনেম, ইউজার আইডি, ব্যালেন্স, কপি বাটন ঠিকঠাক দেখায়;
//   ৩) গ্রিডের প্রতিটা লিংক আসল রুটে যায় — কোনো ডেড বাটন নেই;
//   ৪) আগের অ্যাকর্ডিয়নের কোনো গন্তব্য হারায়নি;
//   ৫) প্রতিটা টাইলে আইকনের পাশাপাশি টেক্সট লেবেল আছে;
//   ৬) লগআউট কাজ করে এবং সেশন সত্যিই শেষ হয়।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, freshRequest } = require('../helpers/app');
const { pool } = require('../../db');

// আগের অ্যাকর্ডিয়ন হাবগুলোতে যত গন্তব্য ছিল — একটাও হারানো চলবে না।
// (VIP-এর ৪টা লিংক ও রিওয়ার্ডের ডেইলি/উইকলি/মান্থলি/কুপন সবই একই পেজে যেত,
//  তাই সেগুলো একটা করে এন্ট্রিতে মিলিয়ে দেওয়া হয়েছে।)
const REQUIRED_DESTINATIONS = [
  '/profile/transactions',
  '/profile/cards',
  '/profile/vip',
  '/profile/rewards',
  '/profile/wheel',
  '/profile/cashback',
  '/profile/missions',
  '/profile/badges',
  '/profile/security',
  // দ্রষ্টব্য: /profile/login-history ইচ্ছাকৃতভাবে এই তালিকায় নেই — এখন সেটা
  // সিকিউরিটি সেন্টারের ভেতর দিয়ে পৌঁছানো হয়, প্রোফাইল হোমপেজের সরাসরি টাইল নয়।
  // কভারেজ: tests/render/loginHistoryAndWheel.test.js
  '/extra/kyc',
  '/profile/chat',
  '/help-center',
  '/profile/feedback',
  '/notifications'
];

async function makeUserAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent
    .post('/register')
    .type('form')
    .send({
      username,
      phone: uniquePhone(),
      password: 'SecurePass123',
      confirmPassword: 'SecurePass123',
      _csrf: token
    });
  return { agent, username };
}

describe('অ্যাকাউন্ট সেন্টার — অ্যাক্সেস কন্ট্রোল', () => {
  test('লগআউট অবস্থায় /profile-এ ঢোকা যায় না', async () => {
    const res = await freshRequest().get('/profile');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/login/);
  });

  test('লগইন অবস্থায় অ্যাকাউন্ট সেন্টার খোলে', async () => {
    const { agent } = await makeUserAgent();
    const res = await agent.get('/profile');
    expect(res.status).toBe(200);
    // মেম্বার সেন্টারের শিরোনাম এখন লোকালাইজড, তাই হার্ডকোড বাংলা টেক্সটের বদলে
    // বর্তমান লোকেলের অনুবাদটাই যাচাই করা হয় — ভাষা বদলালেও টেস্ট অর্থবহ থাকে।
    const bnLocale = require('../../locales/bn.json');
    expect(res.text).toContain(bnLocale.member_center);
  });
});

describe('অ্যাকাউন্ট সেন্টার — প্রোফাইল হেডার', () => {
  let html;
  let username;

  beforeAll(async () => {
    const made = await makeUserAgent();
    username = made.username;
    const res = await made.agent.get('/profile');
    expect(res.status).toBe(200);
    html = res.text;
  });

  test('ইউজারনেম দেখায়', () => {
    expect(html).toContain(username);
  });

  test('ইউজার আইডি ও কপি বাটন আছে', () => {
    // CSP মাইগ্রেশনে (docs/CSP.md ধাপ ২) ইনলাইন onclick সরিয়ে
    // data-profile-action hook করা হয়েছে; আচরণ public/js/profile-index.js-এ।
    expect(html).toMatch(/ID:\s*\d+/);
    expect(html).toContain('data-profile-action="copy-uid"');
    expect(html).toContain('data-profile-action="copy-username"');

    const js = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'public', 'js', 'profile-index.js'), 'utf8');
    expect(js).toMatch(/'copy-uid': copyUid/);
    expect(js).toMatch(/'copy-username': copyUsername/);
  });

  test('ব্যালেন্স ও রিফ্রেশ বাটন আছে', () => {
    expect(html).toContain('id="balanceText"');
    expect(html).toContain('data-profile-action="refresh-balance"');
    const js = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'public', 'js', 'profile-index.js'), 'utf8');
    expect(js).toMatch(/'refresh-balance': refreshBalance/);
  });

  test('মেম্বারশিপ (VIP) স্ট্যাটাস দেখায়', () => {
    expect(html).toContain('pf-vip-badge-sm');
    expect(html).toContain('href="/profile/vip"');
  });

  test('ডিপোজিট/উইথড্র/কার্ড — কুইক অ্যাকশন আছে', () => {
    expect(html).toContain('href="/payment/deposit"');
    expect(html).toContain('href="/payment/withdraw"');
    expect(html).toContain('href="/profile/cards"');
  });
});

describe('অ্যাকাউন্ট সেন্টার — ফ্ল্যাট মেম্বার গ্রিড', () => {
  let html;
  let agent;

  beforeAll(async () => {
    const made = await makeUserAgent();
    agent = made.agent;
    const res = await agent.get('/profile');
    html = res.text;
  });

  test('ফ্ল্যাট গ্রিড ব্যবহার হয়, অ্যাকর্ডিয়ন হাব নেই', () => {
    expect(html).toContain('mc-flat-grid');
    expect(html).not.toContain('toggleHub');
    expect(html).not.toContain('mc-hub-panel');
    expect(html).not.toContain('mc-hub-tile');
  });

  test('প্রতিটা টাইলে আইকন ও টেক্সট লেবেল দুটোই আছে', () => {
    const tiles = html.match(/<a href="[^"]+" class="mc-tile">[\s\S]*?<\/a>/g) || [];
    expect(tiles.length).toBeGreaterThanOrEqual(16);
    for (const tile of tiles) {
      expect(tile).toMatch(/<i class="fas [^"]+"><\/i>/);
      expect(tile).toMatch(/class="mc-tile-label">[^<]+</);
    }
  });

  test('আগের হাবের কোনো গন্তব্য হারায়নি', () => {
    for (const dest of REQUIRED_DESTINATIONS) {
      expect(html).toContain(`href="${dest}"`);
    }
  });

  test('গ্রিডের প্রতিটা লিংক আসল রুটে যায় — ডেড বাটন নেই', async () => {
    const hrefs = [...html.matchAll(/<a href="([^"]+)" class="mc-tile"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(16);

    const dead = [];
    for (const href of hrefs) {
      const res = await agent.get(href);
      if (![200, 302].includes(res.status)) dead.push(`${href} → ${res.status}`);
    }
    expect(dead).toEqual([]);
  });

  test('অস্তিত্বহীন রুটে (/profile/trusted-devices) কোনো লিংক নেই', async () => {
    // ভিউ ফাইল আছে কিন্তু রুট নেই — লিংক করলে ৪০৪ হতো
    expect(html).not.toContain('href="/profile/trusted-devices"');
    const res = await agent.get('/profile/trusted-devices');
    expect(res.status).toBe(404);
  });

  test('লগআউট স্পষ্টভাবে দৃশ্যমান', () => {
    expect(html).toContain('href="/logout"');
  });
});

describe('অ্যাকাউন্ট সেন্টার — ডেটা স্টেট ও লেআউট নিরাপত্তা', () => {
  // অ্যাক্টিভিটি ফিড কার্ড প্রোফাইল হোমপেজ থেকে সরিয়ে সিকিউরিটি সেন্টারে নেওয়া হয়েছে,
  // তাই এখানে তার খালি-অবস্থার কভারেজ আর প্রযোজ্য নয়।
  // নতুন কভারেজ: tests/render/loginHistoryAndWheel.test.js

  test('লম্বা ইউজারনেম লেআউট ভাঙে না (wrap সেট করা আছে)', async () => {
    const { agent } = await makeUserAgent();
    const res = await agent.get('/profile');
    // টাইল লেবেল ও ইউজারনেম — দুটোই wrap/ellipsis হ্যান্ডল করে
    expect(res.text).toMatch(/\.mc-tile-label\{[^}]*overflow-wrap:anywhere/);
  });

  test('মোবাইলে অনুভূমিক ওভারফ্লো ঠেকাতে গ্রিড রেসপনসিভ', async () => {
    const { agent } = await makeUserAgent();
    const res = await agent.get('/profile');
    expect(res.text).toMatch(/\.mc-flat-grid\{[^}]*grid-template-columns:repeat\(4,1fr\)/);
    expect(res.text).toMatch(/@media \(max-width:339px\)\{\.mc-flat-grid\{grid-template-columns:repeat\(3,1fr\)\}/);
    expect(res.text).toMatch(/@media \(min-width:768px\)\{\.mc-flat-grid\{grid-template-columns:repeat\(6,1fr\)\}/);
  });

  test('টাচ টার্গেট যথেষ্ট বড় (min-height ৬৪px)', async () => {
    const { agent } = await makeUserAgent();
    const res = await agent.get('/profile');
    expect(res.text).toMatch(/\.mc-tile\{[^}]*min-height:64px/);
  });
});

describe('অ্যাকাউন্ট সেন্টার — লগআউট', () => {
  test('লগআউটের পর সেশন শেষ হয় এবং সুরক্ষিত পেজে ঢোকা যায় না', async () => {
    const { agent } = await makeUserAgent();

    const before = await agent.get('/profile');
    expect(before.status).toBe(200);

    const out = await agent.get('/logout');
    expect([200, 302]).toContain(out.status);

    const after = await agent.get('/profile');
    expect(after.status).toBe(302);
    expect(after.headers.location).toMatch(/login/);
  });
});

describe('বিদ্যমান প্রোফাইল API অক্ষত', () => {
  test('/profile/api/balance আগের মতোই কাজ করে', async () => {
    const { agent } = await makeUserAgent();
    const res = await agent.get('/profile/api/balance');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('coins');
  });

  test('লগআউট অবস্থায় balance API সুরক্ষিত', async () => {
    const res = await freshRequest().get('/profile/api/balance');
    expect(res.status).toBe(302);
  });
});

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE username LIKE 'testuser%' AND created_at > NOW() - INTERVAL '1 hour'").catch(() => {});
});
