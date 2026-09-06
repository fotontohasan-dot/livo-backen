// tests/render/homepageStructure.test.js
// ---------------------------------------------------------------------------
// হোমপেজের ইনফরমেশন আর্কিটেকচার রিগ্রেশন টেস্ট।
//
// এই কাজে যা ঠিক করা হয়েছে এবং এখানে লক করা হচ্ছে:
//   • হোমপেজে আগে শুধু গেম-গ্রিড ফিল্টারের ট্যাব ছিল (Hot/Slots/Live/Sports/Poker) —
//     ওগুলো ক্যাসিনো গেমের ক্যাটাগরি। আসল স্পোর্টস, ফুটবল, ক্রিকেট, টুর্নামেন্ট বা
//     লাইভ ম্যাচে যাওয়ার কোনো লিংকই হোমপেজে ছিল না।
//   • /sports/cricket রুট 500 দিত (matches ভিউ `sport` লোকাল ছাড়া রেন্ডার হয় না) —
//     অর্থাৎ একটা সম্পূর্ণ ডেড লিংক।
//   • "Recent Big Wins" ও "MEGA JACKPOT" হার্ডকোড করা বানানো ইউজারনেম ও টাকার অঙ্ক
//     দেখাত, কোনো ব্যাকএন্ড ডেটার সাথে সম্পর্ক ছাড়াই।
//
// সবচেয়ে গুরুত্বপূর্ণ অ্যাসারশন: ন্যাভিগেশনের প্রতিটা লিংক সত্যিই কাজ করে (ডেড লিংক নেই)।
// ---------------------------------------------------------------------------

const { withScripts } = require('../helpers/viewScripts');
const request = require('supertest');
// supertest-কে সরাসরি express অ্যাপ না দিয়ে helpers/app.js-এর শেয়ার্ড listening
// সার্ভার দেওয়া হচ্ছে — নাহলে supertest প্রতি রিকোয়েস্টে নিজে listen/close করে,
// যা সমান্তরাল রিকোয়েস্টে ECONNRESET তৈরি করত (helpers/app.js-এর ব্যাখ্যা দেখো)।
const { app } = require('../helpers/app');
const { pool } = require('../../db');

describe('হোমপেজ — প্রধান ক্যাটাগরি ন্যাভিগেশন', () => {
  let html;

  beforeAll(async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    html = res.text;
  });

  test('প্রধান ক্যাটাগরি ন্যাভ রেন্ডার হয়', () => {
    expect(html).toContain('main-cat-nav');
    expect(html).toContain('aria-label="প্রধান বিভাগ"');
  });

  test('স্পোর্টস, ফুটবল, ক্রিকেট, টুর্নামেন্ট — সবই হোমপেজ থেকে দৃশ্যমান', () => {
    for (const label of ['স্পোর্টস', 'ফুটবল', 'ক্রিকেট', 'টুর্নামেন্ট', 'ক্যাসিনো', 'প্রমোশন']) {
      expect(html).toContain(`<span>${label}</span>`);
    }
  });

  test('আইকনের পাশাপাশি টেক্সট লেবেল আছে (শুধু আইকন নয়)', () => {
    const items = html.match(/<a href="[^"]+" class="main-cat-item[^"]*">.*?<\/a>/g) || [];
    expect(items.length).toBeGreaterThanOrEqual(6);
    for (const item of items) {
      expect(item).toMatch(/<i class="fas [^"]+"><\/i>/); // আইকন
      expect(item).toMatch(/<span>[^<]+<\/span>/);         // লেবেল
    }
  });

  test('ন্যাভিগেশনের প্রতিটা লিংক আসল রুটে যায় — কোনো ডেড লিংক নেই', async () => {
    const hrefs = [...html.matchAll(/<a href="([^"]+)" class="main-cat-item/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(6);

    const dead = [];
    for (const href of hrefs) {
      if (href.startsWith('#')) {
        // পেজ-ইন্টার্নাল অ্যাঙ্কর — টার্গেট এলিমেন্টটা সত্যিই আছে কি না দেখা হয়
        if (!html.includes(`id="${href.slice(1)}"`)) dead.push(`${href} (anchor target missing)`);
        continue;
      }
      const r = await request(app).get(href);
      // 200 = পাবলিক পেজ, 302 = লগইন দরকার (দুটোই বৈধ); 404/500 = ডেড লিংক
      if (![200, 302].includes(r.status)) dead.push(`${href} → ${r.status}`);
    }
    expect(dead).toEqual([]);
  });
});

// দ্রষ্টব্য: হোমপেজের লাইভ/আসন্ন ম্যাচ রেল ইচ্ছাকৃতভাবে সরিয়ে ফেলা হয়েছে —
// নতুন UX-এ ইউজার প্রথমে খেলা বেছে নেয়, তারপর ম্যাচ দেখে। সেই আচরণের কভারেজ
// এখন tests/render/sportsCategoryUx.test.js-এ আছে। এখানে শুধু নিশ্চিত করা হচ্ছে
// যে ম্যাচ-ডেটার এন্ডপয়েন্টটা এখনো কাজ করছে (Football/Cricket পেজ এটাই ব্যবহার করে)।
describe('ম্যাচ ডেটা এন্ডপয়েন্ট', () => {
  test('/matches/api/live এখনো কাজ করে', async () => {
    const res = await request(app).get('/matches/api/live');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cricket');
    expect(res.body).toHaveProperty('football');
  });
});

describe('হোমপেজ — বানানো আর্থিক ডেটা সরানো হয়েছে', () => {
  test('হার্ডকোড করা ভুয়া ইউজার/জয়ের অঙ্ক আর নেই', async () => {
    const res = await request(app).get('/');
    for (const fake of ['******119', '******642', '******458', '******622', '******778']) {
      expect(res.text).not.toContain(fake);
    }
    expect(res.text).not.toContain('88,885,063.59'); // বানানো জ্যাকপট অঙ্ক
  });

  test('Recent Big Wins এখন আসল এন্ডপয়েন্ট থেকে আসে, খালি অবস্থাও আছে', async () => {
    const res = await request(app).get('/');
    // docs/CSP.md ধাপ ৩-এ হোমপেজের কোড public/js/views/index.js-এ সরানো
    // হয়েছে, তাই fetch কলটা রেসপন্স + লোড করা স্ক্রিপ্ট একসাথে দেখে যাচাই।
    const page = withScripts(res.text);
    expect(page).toContain("fetch('/games/api/recent-wins'");
    // খালি অবস্থার বার্তাটাও এখন ওই স্ক্রিপ্টেই তৈরি হয়
    expect(page).toContain('এখনো কোনো বড় জয় নেই');
  });

  test('/games/api/recent-wins বৈধ আকারে সাড়া দেয় এবং ইউজারনেম মাস্ক করে', async () => {
    const res = await request(app).get('/games/api/recent-wins');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.wins)).toBe(true);

    for (const w of res.body.wins) {
      expect(w.user).toMatch(/^\*{6}/);          // পুরো ইউজারনেম কখনো যায় না
      expect(w).not.toHaveProperty('user_id');   // অভ্যন্তরীণ আইডি ফাঁস হয় না
      expect(w).not.toHaveProperty('email');
      expect(w).not.toHaveProperty('phone');
    }
  });

  test('জেতা হলে সেটা সত্যিই তালিকায় আসে (আসল ডেটা, বানানো নয়)', async () => {
    const u = await pool.query(
      `INSERT INTO users (username, phone, password) VALUES ($1, $2, 'x') RETURNING id`,
      [`winuser_${Date.now()}`, `019${Date.now().toString().slice(-8)}`]
    );
    const userId = u.rows[0].id;
    await pool.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, 1234, 'game_play', 'Test Game জয়')`,
      [userId]
    );

    const res = await request(app).get('/games/api/recent-wins');
    const found = res.body.wins.find((w) => w.game === 'Test Game জয়');
    expect(found).toBeDefined();
    expect(found.amount).toBe(1234);

    await pool.query('DELETE FROM coin_transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });
});

describe('বটম নেভিগেশন', () => {
  test('স্পোর্টস এন্ট্রি যোগ হয়েছে, পুরনো কোনো এন্ট্রি সরানো হয়নি', async () => {
    const res = await request(app).get('/');
    for (const label of ['হোম', 'স্পোর্টস', 'আমন্ত্রণ', 'প্রমোশন', 'সেবা', 'প্রোফাইল']) {
      expect(res.text).toContain(`<span>${label}</span>`);
    }
  });

  test('বটম নেভের সব লিংক আসল রুটে যায়', async () => {
    const res = await request(app).get('/');
    const nav = res.text.slice(res.text.indexOf('id="pubBottomNav"'));
    const hrefs = [...nav.matchAll(/<a href="([^"]+)" class="pub-nav-item/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(5);

    const dead = [];
    for (const href of hrefs) {
      const r = await request(app).get(href);
      if (![200, 302].includes(r.status)) dead.push(`${href} → ${r.status}`);
    }
    expect(dead).toEqual([]);
  });
});

describe('স্পোর্টস রুট', () => {
  test('/sports/cricket আর 500 দেয় না', async () => {
    const res = await request(app).get('/sports/cricket');
    expect(res.status).toBe(200);
  });

  test('সব স্পোর্টস রুট রেন্ডার হয়', async () => {
    for (const p of ['/sports', '/sports/football', '/sports/cricket', '/matches', '/matches/football', '/matches/cricket']) {
      const r = await request(app).get(p);
      expect([200, 302]).toContain(r.status);
    }
  });
});
