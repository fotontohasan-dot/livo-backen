// tests/render/wheelPrizeMasking.test.js
// ---------------------------------------------------------------------------
// লাকি হুইল — স্পিনের আগে কোনো পুরস্কারের মান ফাঁস হয় না।
//
// আগে GET /profile/wheel ভিউতে getSegments()-এর পুরো prize তালিকা পাঠাত এবং
// ক্যানভাসে প্রতিটা ঘরের উপর মানটা লিখে দিত। ফলে ইউজার স্পিন করার আগেই দেখে ফেলত
// কোন ঘরে কত পুরস্কার, আর DevTools-এ `segments` অ্যারে থেকে index→prize ম্যাপিং
// বের করে স্পিন রেসপন্সের index দিয়ে অ্যানিমেশন শেষ হওয়ার আগেই ফলাফল জানা যেত।
//
// এখন ক্লায়েন্ট শুধু ঘরের সংখ্যা পায়। পুরস্কার নির্বাচন, ওয়ালেট ক্রেডিট ও
// GET /profile/wheel/result — সবই অপরিবর্তিত।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');
const { getSegments } = require('../../services/wheel');

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, userId: r.rows[0].id };
}

// হুইলের নিজের ইনলাইন স্ক্রিপ্ট — ক্লায়েন্টে সত্যিই কী পাঠানো হচ্ছে।
// (পেজের শেয়ার্ড স্ক্রিপ্টে অসম্পর্কিত সংখ্যা থাকে, তাই শুধু এই ব্লকটাই দেখা হয়।)
// docs/CSP.md ধাপ ৩-এ হুইলের কোড public/js/views/profile-wheel.js-এ সরানো
// হয়েছে। তাই ইনলাইন ব্লকের পাশাপাশি লোড করা স্ক্রিপ্ট ফাইলগুলোও দেখা হয় —
// প্রশ্নটা একই: "ক্লায়েন্টে কোন কোড যাচ্ছে"।
const { scriptOrder, readScript } = require('../helpers/viewScripts');

function scripts(html) {
  // ইনলাইন ব্লক + লোড করা বাইরের স্ক্রিপ্ট, প্রতিটা আলাদা আইটেম হিসেবে —
  // পুরো ডকুমেন্ট জুড়ে দিলে অপ্রাসঙ্গিক HTML ফিল্টারে ঢুকে পড়ত।
  const blocks = (html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [])
    .concat(scriptOrder(html).map(readScript));
  return blocks
    .filter((b) => b.includes('const segments =') || b.includes('drawWheel'))
    .join('\n')
    // রং (rgba/hex) ও পিক্সেল ইউনিটের সংখ্যা পুরস্কার নয় — বাদ দিয়ে যাচাই করা হয়
    .replace(/rgba?\([^)]*\)/gi, 'COLOR')
    .replace(/#[0-9a-f]{3,8}\b/gi, 'COLOR')
    .replace(/\d+px\b/gi, 'PX');
}

describe('লাকি হুইল — স্পিনের আগে পুরস্কার দেখা যায় না', () => {
  let html;
  let userId;
  let agent;

  beforeAll(async () => {
    const made = await makeUser();
    agent = made.agent;
    userId = made.userId;
    // ডিপোজিট দিলে হুইল আনলক — তবু পেজে কোনো পুরস্কার দেখা যাবে না
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, amount, status, updated_at)
       VALUES ($1,'deposit',500,'approved',NOW())`, [userId]
    );
    const res = await agent.get('/profile/wheel');
    expect(res.status).toBe(200);
    html = res.text;
  });

  test('ক্লায়েন্ট স্ক্রিপ্টে পুরস্কারের কোনো মান পাঠানো হয় না', () => {
    const js = scripts(html);
    // স্বতন্ত্র বড় পুরস্কারগুলো স্ক্রিপ্টে থাকা চলবে না।
    // (৫ ও ১০ বাদ — ওগুলো জ্যামিতি/অ্যানিমেশনের সাধারণ ধ্রুবক হিসেবেও আসতে পারে,
    //  তাই ওদের জন্য নিচের অ্যারে-লিটারেল চেকটাই আসল গার্ড।)
    for (const p of [20, 50, 100, 500]) {
      expect(js).not.toMatch(new RegExp(`\\b${p}\\b`));
    }
    // পুরনো সার্ভার-ইনজেক্টেড অ্যারেটা আর নেই — কোনো সংখ্যার তালিকাই ক্লায়েন্টে যায় না
    expect(js).not.toMatch(/const segments\s*=\s*\[/);
    expect(js).not.toMatch(/\[\s*\d+\s*(,\s*\d+\s*){3,}\]/);
  });

  test('ঘরের সংখ্যা অপরিবর্তিত — ডিজাইন ভাঙেনি', () => {
    // ঘরের সংখ্যা এখন JSON কনফিগে যায়, স্ক্রিপ্টে হার্ডকোড হয় না।
    expect(scripts(html)).toMatch(/new Array\(cfg\.segmentCount \|\| 12\)/);
    const cfg = /<script type="application\/json" id="profile-wheelConfig">([\s\S]*?)<\/script>/.exec(html);
    expect(cfg).not.toBeNull();
    expect(JSON.parse(cfg[1]).segmentCount).toBe(getSegments().length);
  });

  test('ক্যানভাসে পুরস্কারের বদলে নিরপেক্ষ চিহ্ন আঁকা হয়', () => {
    const js = scripts(html);
    expect(js).toContain("ctx.fillText('?'");
    expect(js).not.toMatch(/segments\[i\]\s*>\s*0/);
  });

  test('HTML-এ (স্ক্রিপ্টের বাইরেও) সম্ভাব্য পুরস্কারের তালিকা নেই', () => {
    // ইউজার আজ এখনো স্পিন করেনি, তাই কোনো "N কয়েন" মান পেজে থাকার কথা নয়
    const visible = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    expect(visible).not.toMatch(/\b(5|10|20|50|100|500)\s*কয়েন/);
  });

  test('GO বাটন ও হুইল র‍্যাপার আগের মতোই আছে', () => {
    expect(html).toContain('fa-wheel-wrap');
    expect(html).toContain('fa-go-btn');
    expect(html).toMatch(/id="spinBtn"/);
  });

  test('স্পিনের পর ফলাফল শুধু নিজের জেতা পুরস্কারই দেখায়', async () => {
    const page = await agent.get('/profile/wheel');
    const token = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
    const spin = await agent.post('/profile/wheel/spin').set('X-CSRF-Token', token).send({});
    expect(spin.body.success).toBe(true);
    expect(spin.body).not.toHaveProperty('prize');

    const result = await agent.get('/profile/wheel/result');
    const db = await pool.query(
      `SELECT prize FROM wheel_spins WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [userId]
    );
    expect(result.body.prize).toBe(Number(db.rows[0].prize));
    // ফলাফলে অন্য ঘরের কোনো তথ্য নেই
    expect(Object.keys(result.body).sort()).toEqual(['message', 'prize', 'success']);
  });
});
