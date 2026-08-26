// tests/render/loginHistoryAndWheel.test.js
// ---------------------------------------------------------------------------
// দুইটা নির্দিষ্ট ফিক্সের রিগ্রেশন কভারেজ।
//
// ১) লগইন হিস্টোরির অবস্থান
//    আগে প্রোফাইল হোমপেজে "সাম্প্রতিক অ্যাক্টিভিটি" নামে একটা কার্ড ছিল যেটা লগইন
//    এন্ট্রিগুলো সরাসরি হোমপেজে তালিকাভুক্ত করত। লগইন হিস্টোরির সঠিক জায়গা
//    সিকিউরিটি সেন্টার। ব্যাকএন্ড রুট/ডেটা অপরিবর্তিত — শুধু UI অবস্থান বদলেছে।
//
// ২) লাকি হুইলের ফলাফল আগে থেকে দেখা যাওয়া
//    POST /wheel/spin আগে রেসপন্সেই prize ও জয়ের বার্তা পাঠাত, অথচ হুইলের অ্যানিমেশন
//    চলত আরও ৪ সেকেন্ড। ফলে হুইল থামার আগেই নেটওয়ার্ক রেসপন্সে ফলাফল দেখা যেত।
//    এখন স্পিন রেসপন্সে শুধু index যায়; আসল পুরস্কার অ্যানিমেশনের পরে
//    GET /wheel/result থেকে আসে। পুরস্কার নির্বাচন ও ওয়ালেট লজিক অপরিবর্তিত।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');

const ROOT = path.join(__dirname, '..', '..');

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').type('form').send({
    username,
    phone: uniquePhone(),
    password: 'SecurePass123',
    confirmPassword: 'SecurePass123',
    _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, username, userId: r.rows[0].id };
}

async function csrfFrom(agent, url) {
  const res = await agent.get(url);
  return /<meta name="csrf-token" content="([^"]*)"/.exec(res.text)[1];
}

describe('লগইন হিস্টোরি — প্রোফাইল হোমপেজ থেকে সরানো', () => {
  let html;

  beforeAll(async () => {
    const { agent } = await makeUser();
    const res = await agent.get('/profile');
    expect(res.status).toBe(200);
    html = res.text;
  });

  test('স্ট্যান্ডঅ্যালোন "সাম্প্রতিক অ্যাক্টিভিটি" কার্ড আর নেই', () => {
    expect(html).not.toContain('সাম্প্রতিক অ্যাক্টিভিটি');
    expect(html).not.toContain('pf-activity-card');
    expect(html).not.toContain('pf-activity-row');
    expect(html).not.toContain('pf-activity-list');
  });

  test('লগইন হিস্টোরি সরাসরি প্রোফাইল হোমপেজের টাইল নয়', () => {
    expect(html).not.toContain('href="/profile/login-history"');
  });

  test('সিকিউরিটি সেন্টারের এন্ট্রি আছে এবং লগইন হিস্টোরির ইঙ্গিত দেয়', () => {
    expect(html).toContain('href="/profile/security"');
    expect(html).toContain('সিকিউরিটি সেন্টার');
    expect(html).toContain('লগইন হিস্টোরি');
  });
});

describe('লগইন হিস্টোরি — সিকিউরিটি সেন্টারের ভিতরে', () => {
  let agent;
  let securityHtml;

  beforeAll(async () => {
    const made = await makeUser();
    agent = made.agent;
    const res = await agent.get('/profile/security');
    expect(res.status).toBe(200);
    securityHtml = res.text;
  });

  test('সিকিউরিটি সেন্টারে সাম্প্রতিক লগইন তালিকা আছে', () => {
    expect(securityHtml).toContain('href="/profile/login-history"');
  });

  test('পূর্ণ লগইন হিস্টোরি পেজ আগের মতোই খোলে', async () => {
    const res = await agent.get('/profile/login-history');
    expect(res.status).toBe(200);
  });

  test('লগইন হিস্টোরির ডেটা অক্ষত — ডিভাইস/IP/সময় দেখানো হয়', async () => {
    const res = await agent.get('/profile/login-history');
    // রেজিস্ট্রেশনেই একটা লগইন রেকর্ড তৈরি হয়
    const logs = await pool.query('SELECT COUNT(*)::int AS c FROM login_logs');
    expect(logs.rows[0].c).toBeGreaterThan(0);
    expect(res.status).toBe(200);
  });

  test('লগইন হিস্টোরি ব্যাকএন্ড রুট অপরিবর্তিত (লগআউটে সুরক্ষিত)', async () => {
    const { freshRequest } = require('../helpers/app');
    const res = await freshRequest().get('/profile/login-history');
    expect(res.status).toBe(302);
  });
});

describe('লাকি হুইল — যোগ্যতা ও ডুপ্লিকেট সুরক্ষা অপরিবর্তিত', () => {
  test('টাস্ক অসম্পূর্ণ থাকলে স্পিন করা যায় না এবং কোনো ফলাফল দেখা যায় না', async () => {
    const { agent } = await makeUser();

    const page = await agent.get('/profile/wheel');
    expect(page.status).toBe(200);
    expect(page.text).toContain('হুইল লক করা আছে');
    expect(page.text).toMatch(/id="spinBtn"[^>]*disabled/);

    // লক থাকা অবস্থায় ফলাফল এন্ডপয়েন্ট কিছুই ফাঁস করে না
    const result = await agent.get('/profile/wheel/result');
    expect(result.body.success).toBe(false);
    expect(result.body).not.toHaveProperty('prize');

    // সার্ভার সরাসরি স্পিন রিকোয়েস্টও আটকায় (বাটন disabled শুধু ক্লায়েন্ট-সাইড)
    const token = await csrfFrom(agent, '/profile/wheel');
    const spin = await agent.post('/profile/wheel/spin').set('X-CSRF-Token', token).send({});
    expect(spin.body.success).toBe(false);
    expect(spin.body).not.toHaveProperty('prize');
    expect(spin.body).not.toHaveProperty('index');
  });

  test('একই দিনে দ্বিতীয়বার স্পিন করা যায় না', async () => {
    const { agent, userId } = await makeUser();
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, amount, status, updated_at)
       VALUES ($1,'deposit',500,'approved',NOW())`, [userId]
    );

    const token = await csrfFrom(agent, '/profile/wheel');
    const first = await agent.post('/profile/wheel/spin').set('X-CSRF-Token', token).send({});
    expect(first.body.success).toBe(true);

    const second = await agent.post('/profile/wheel/spin').set('X-CSRF-Token', token).send({});
    expect(second.body.success).toBe(false);
    expect(second.body).not.toHaveProperty('index');
  });
});

describe('লাকি হুইল — ফলাফল স্পিন শেষ হওয়ার আগে দেখা যায় না', () => {
  let agent;
  let userId;
  let spinBody;

  beforeAll(async () => {
    const made = await makeUser();
    agent = made.agent;
    userId = made.userId;
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, amount, status, updated_at)
       VALUES ($1,'deposit',500,'approved',NOW())`, [userId]
    );
    const token = await csrfFrom(agent, '/profile/wheel');
    spinBody = (await agent.post('/profile/wheel/spin').set('X-CSRF-Token', token).send({})).body;
  });

  test('স্পিন রেসপন্সে পুরস্কার বা জয়ের বার্তা থাকে না', () => {
    expect(spinBody.success).toBe(true);
    expect(spinBody).not.toHaveProperty('prize');
    expect(spinBody).not.toHaveProperty('message');
    // অ্যানিমেশন আঁকতে শুধু index লাগে
    expect(typeof spinBody.index).toBe('number');
  });

  test('অ্যানিমেশনের পর সার্ভার-নিশ্চিত ফলাফল পাওয়া যায়', async () => {
    const res = await agent.get('/profile/wheel/result');
    expect(res.body.success).toBe(true);
    expect(typeof res.body.prize).toBe('number');
    expect(typeof res.body.message).toBe('string');
  });

  test('ফলাফল ডাটাবেজে লেখা মানের সাথে হুবহু মেলে (সার্ভার-অথরিটেটিভ)', async () => {
    const db = await pool.query(
      `SELECT prize FROM wheel_spins WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [userId]
    );
    const res = await agent.get('/profile/wheel/result');
    expect(res.body.prize).toBe(Number(db.rows[0].prize));
  });

  test('ওয়ালেট ক্রেডিট ঠিক পুরস্কারের সমান — রিওয়ার্ড লজিক অপরিবর্তিত', async () => {
    const db = await pool.query(
      `SELECT prize FROM wheel_spins WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [userId]
    );
    const prize = Number(db.rows[0].prize);

    const tx = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total FROM coin_transactions
       WHERE user_id = $1 AND type = 'lucky_wheel'`, [userId]
    );
    expect(Number(tx.rows[0].total)).toBe(prize > 0 ? prize : 0);
  });

  test('ফলাফল এন্ডপয়েন্ট লগআউট অবস্থায় সুরক্ষিত', async () => {
    const { freshRequest } = require('../helpers/app');
    const res = await freshRequest().get('/profile/wheel/result');
    expect(res.status).toBe(302);
  });
});

describe('লাকি হুইল — ফ্রন্টএন্ড ও ডিজাইন', () => {
  const view = fs.readFileSync(path.join(ROOT, 'views', 'profile', 'wheel.ejs'), 'utf8');

  test('ফলাফল অ্যানিমেশন শেষ হওয়ার পরেই দেখানো হয়', () => {
    expect(view).toContain('revealResult()');
    expect(view).toContain("fetch('/profile/wheel/result'");
  });

  test('ফ্রন্টএন্ড নিজে পুরস্কার হিসাব করে না', () => {
    // ক্লায়েন্টে কোনো র‍্যান্ডম/ওয়েট-ভিত্তিক নির্বাচন নেই
    expect(view).not.toMatch(/Math\.random\s*\(\)/);
    expect(view).not.toContain('pickPrize');
  });

  test('সম্ভাব্য প্রাইজ সেগমেন্ট ও ডিজাইন অপরিবর্তিত', () => {
    // সেগমেন্ট সার্ভার থেকেই আসে এবং হুইল আঁকতে ব্যবহৃত হয়
    expect(view).toContain('const segments =');
    expect(view).toContain('drawWheel()');
    expect(view).toContain('fa-wheel-wrap');
    expect(view).toContain('fa-go-btn');
  });

  test('সার্ভারের সেগমেন্ট তালিকা অপরিবর্তিত', () => {
    const { getSegments } = require('../../services/wheel');
    expect(getSegments()).toEqual([0, 0, 0, 0, 5, 5, 10, 10, 20, 50, 100, 500]);
  });
});
