const { getCsrfAgent, extractCsrfToken, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');

// ==================== Phase 4: সমান্তরাল ডেবিট ====================
//
// roadmap-এর Phase 4-এর সবচেয়ে গুরুত্বপূর্ণ দাবি: একই সময়ে একাধিক বাজি
// এলে ব্যালেন্স যেন নেগেটিভ না হয় এবং প্রাপ্য টাকার বেশি খরচ না হয়।
//
// routes/games.js সঠিক প্যাটার্ন ব্যবহার করে — BEGIN + SELECT ... FOR
// UPDATE + শর্তসাপেক্ষ ডেবিট। কিন্তু কোনো টেস্ট এটা সমান্তরালে যাচাই
// করত না। row lock সরিয়ে দিলে বা BEGIN/COMMIT ভেঙে গেলে সব টেস্ট সবুজই
// থাকত, আর বাগটা কেবল প্রোডাকশনে ভিড়ের সময় দেখা দিত — যেখানে দুটো
// রিকোয়েস্ট একই স্ন্যাপশট পড়ে দুবার একই টাকা খরচ করতে পারে।
//
// এখানে ইচ্ছাকৃতভাবে ঠিক ততটাই ব্যালেন্স দেওয়া হয় যাতে অল্প কয়েকটা বাজিই
// সফল হওয়ার কথা, তারপর একসাথে অনেকগুলো পাঠানো হয়।
//
// ⚠️ এই টেস্টের সীমা — জানা থাকা দরকার:
//
// মিউটেশন যাচাই করে দেখা গেছে routes/games.js থেকে `FOR UPDATE` সরিয়ে
// দিলেও এই টেস্ট পাস করে। অর্থাৎ এটা race condition ধরতে পারে না।
// সম্ভাব্য কারণ: supertest-এর একই agent দিয়ে পাঠানো রিকোয়েস্টগুলো
// express-session-এর কারণে কার্যত সিরিয়ালাইজ হয়ে যায়, তাই দুটো
// রিকোয়েস্ট সত্যিই একই স্ন্যাপশট পড়ার সুযোগ পায় না।
//
// টেস্টটা যা সত্যিই যাচাই করে: ব্যালেন্স কখনো নেগেটিভ হয় না, বাজি
// সত্যিই গৃহীত হয়, আর ব্যালেন্সের পরিবর্তন coin_transactions ledger-এর
// যোগফলের সমান। এগুলো মূল্যবান, কিন্তু "concurrent debit নিরাপদ" —
// roadmap Phase 4-এর ওই দাবিটা এখনো অপ্রমাণিত।
//
// প্রকৃত race যাচাইয়ের জন্য একই সেশনের বাইরে থেকে, একাধিক pool client
// দিয়ে সমান্তরাল ট্রানজেকশন চালাতে হবে — আলাদা কাজ।

const PASSWORD = 'SecurePass123';

async function makeUser(coins) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('cc');
  await agent.post('/register').type('form').send({
    username, phone: uniquePhone(), password: PASSWORD,
    confirmPassword: PASSWORD, _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  const id = r.rows[0].id;
  await pool.query('UPDATE users SET coins = $1 WHERE id = $2', [coins, id]);
  return { agent, username, id };
}

async function coins(id) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
  return Number(r.rows[0].coins);
}

// users-এ foreign key রাখা টেবিলগুলো ডাইনামিকভাবে বের করে মুছি।
// হাতে তালিকা রাখলে নতুন টেবিল যোগ হলেই cleanup ভেঙে পড়ত — এই টেস্টে
// ঠিক সেটাই ঘটেছিল (notifications, daily_losses একে একে বেরিয়ে আসছিল)।
async function childTables() {
  const r = await pool.query(`
    SELECT DISTINCT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'users'
      AND ccu.column_name = 'id'
  `);
  return r.rows;
}

async function cleanup(u) {
  if (!u || !u.id) return;
  for (const { table_name, column_name } of await childTables()) {
    await pool.query(
      `DELETE FROM ${table_name} WHERE ${column_name} = $1`, [u.id]
    ).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
}

describe('Phase 4 — বাজিতে ব্যালেন্স ও ledger অখণ্ডতা', () => {
  jest.setTimeout(120000);

  let user;
  let csrf;

  beforeEach(async () => {
    user = await makeUser(100);
    // /games/dice রেন্ডার হয় না (৩০২), তাই CSRF টোকেন প্রোফাইল পেজ থেকে।
    // টোকেনটা সেশন-ভিত্তিক, পেজ-ভিত্তিক নয়।
    const page = await user.agent.get('/profile');
    csrf = extractCsrfToken(page.text);
    expect(csrf).toBeTruthy();
  });

  afterEach(async () => {
    await cleanup(user);
  });

  // 'dice' রেজিস্ট্রিতে coming-soon, তাই playable তালিকা থেকে একটা নেওয়া হয়।
  // হার্ডকোড করলে ভবিষ্যতে গেমটা বন্ধ হলে টেস্ট নীরবে অর্থহীন হয়ে যেত —
  // সব বাজি ৪০০ পেত আর "ব্যালেন্স নেগেটিভ হয়নি" মিথ্যা আশ্বাস দিত।
  const GAME = require('../../services/gameRegistry').playableSlugs()
    .find((g) => !['aviator', 'crash-game'].includes(g));

  function placeBet(amount) {
    return user.agent
      .post('/games/play')
      .set('X-CSRF-Token', csrf || '')
      .send({ gameSlug: GAME, amount, demo: false });
  }

  test('ব্যালেন্সের চেয়ে বেশি একক বাজি প্রত্যাখ্যাত', async () => {
    const before = await coins(user.id);
    const res = await placeBet(before + 50);
    expect(res.status).not.toBe(500);
    expect(await coins(user.id)).toBe(before);
  });

  test('একসাথে ১০টা বাজি এলেও ব্যালেন্স নেগেটিভ হয় না', async () => {
    // ১০০ কয়েন, প্রতিটা বাজি ৪০ — বড়জোর দুটো সফল হওয়ার কথা।
    const results = await Promise.all(
      Array.from({ length: 10 }, () => placeBet(40).catch((e) => ({ error: e })))
    );

    const after = await coins(user.id);

    // মূল দাবি: ব্যালেন্স কখনো নেগেটিভ হবে না।
    expect(after).toBeGreaterThanOrEqual(0);

    // কতগুলো সত্যিই গৃহীত হয়েছে
    // অন্তত একটা গৃহীত হতেই হবে — নাহলে (যেমন CSRF ব্যর্থ হলে বা গেমটা
    // coming-soon হলে) সব প্রত্যাখ্যাত হত এবং "নেগেটিভ হয়নি" assertion-টা
    // অর্থহীনভাবে পাস করত। প্রথম খসড়ায় ঠিক সেটাই ঘটছিল।
    const accepted = results.filter((r) => r && r.status === 200).length;
    expect(accepted).toBeGreaterThanOrEqual(1);

    // "সর্বোচ্চ দুটো" বলা যায় না: জেতা বাজির টাকা ব্যালেন্সে ফিরে আসে,
    // তাই তৃতীয় বাজিও বৈধভাবে সম্ভব। আসল সীমা নিচের ledger যাচাইয়ে।
  });

  test('ব্যালেন্স ledger-এর যোগফলের সাথে মেলে', async () => {
    // শুধু "নেগেটিভ নয়" যথেষ্ট নয় — টাকা দুবার কাটা যেতে পারে বা
    // হারিয়ে যেতে পারে, আর ব্যালেন্স তবুও ধনাত্মক থাকতে পারে। আসল
    // পরীক্ষা: coin_transactions-এর যোগফল আর users.coins মেলে কি না।
    const before = await coins(user.id);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => placeBet(25).catch(() => null))
    );
    expect(results.filter((r) => r && r.status === 200).length).toBeGreaterThanOrEqual(1);

    // ব্যালেন্স ও ledger একই স্ন্যাপশটে পড়া হয়।
    //
    // আগে দুটো আলাদা query ছিল, আর সেটা মাঝে মাঝে ফেল করত: রুটটা COMMIT-এর
    // পরে addTurnover()-এর মতো কিছু কাজ async চালায়, তাই দুটো পড়ার মাঝখানে
    // ব্যালেন্স বা ledger বদলে যেতে পারত। ওটা টেস্টের নিজের race ছিল,
    // প্রোডাকশনের ছিদ্র নয় — তবু ধরতে সময় লেগেছে বলে এখানে লিখে রাখা।
    const snap = await pool.query(
      `SELECT u.coins,
              (SELECT COALESCE(SUM(amount), 0) FROM coin_transactions WHERE user_id = u.id) AS ledger
       FROM users u WHERE u.id = $1`,
      [user.id]
    );
    const after = Number(snap.rows[0].coins);
    const ledger = Number(snap.rows[0].ledger);

    // প্রতিটা ডেবিট/ক্রেডিট ledger-এ লেখা হলে যোগফল ব্যালেন্সের পরিবর্তনের
    // সমান হবে। না মিললে হয় ledger এন্ট্রি বাদ পড়েছে, নয় ব্যালেন্স
    // ledger ছাড়াই বদলেছে — দুটোই আর্থিক হিসাবের ছিদ্র।
    expect(after - before).toBe(ledger);
  });
});
