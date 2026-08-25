// tests/security/turnoverConcurrency.test.js
// ---------------------------------------------------------------------------
// রিগ্রেশন গার্ড — অডিট P1-07 (turnover lost update) ও P2-01 (fail-open গেট)।
//
// আগের আচরণ: addTurnover() বোনাস রো পড়ত, JS-এ `Number(b.sports_done) + stake`
// হিসাব করত, তারপর `SET sports_done = $1` দিয়ে সেই ফলাফল লিখত। দুটো বাজি প্রায়
// একই সময়ে সেটল হলে দুজনেই একই পুরনো মান পড়ত এবং শেষেরটা আগেরটার ইনক্রিমেন্ট
// মুছে দিত — অর্থাৎ একটা বৃদ্ধি নিঃশব্দে হারিয়ে যেত।
//
// এই টেস্ট আগে ব্যর্থতা পুনরুৎপাদন করে (N সমান্তরাল কল → যোগফল < প্রত্যাশিত),
// তারপর ফিক্সের পর যোগফল ঠিক মেলে কিনা যাচাই করে।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { uniqueUsername, uniquePhone } = require('../helpers/app');
const { addTurnover } = require('../../services/turnover');

jest.setTimeout(60000);

async function makeUser() {
  const u = uniqueUsername('trn');
  const r = await pool.query(
    `INSERT INTO users (username, email, phone, password, role, coins, referral_code, email_verified)
     VALUES ($1,$2,$3,$4,'user',100000,$5,true) RETURNING id`,
    [u, `${u}@example.com`, uniquePhone(), await bcrypt.hash('Passw0rd!23', 10),
     crypto.randomBytes(6).toString('hex').toUpperCase()]
  );
  return r.rows[0].id;
}

async function makeActiveBonus(userId, { sportsRequired = 1000000, casinoRequired = 1000000 } = {}) {
  const r = await pool.query(
    `INSERT INTO bonuses (user_id, bonus_type, bonus_amount, sports_required, casino_required,
                          sports_done, casino_done, status, created_at)
     VALUES ($1,'deposit',1000,$2,$3,0,0,'active',NOW()) RETURNING id`,
    [userId, sportsRequired, casinoRequired]
  );
  return r.rows[0].id;
}

async function bonusRow(id) {
  const r = await pool.query('SELECT * FROM bonuses WHERE id=$1', [id]);
  return r.rows[0];
}

describe('services/turnover — সমান্তরাল ইনক্রিমেন্ট হারায় না (P1-07)', () => {
  test('৩০টি সমান্তরাল sports বাজির টার্নওভার সম্পূর্ণ যোগ হয়', async () => {
    const userId = await makeUser();
    const bonusId = await makeActiveBonus(userId);

    const N = 30;
    const STAKE = 100;
    // ঠিক এই সমান্তরালতাই আগে lost update ঘটাত: সব কলই প্রায় একই সময়ে
    // sports_done পড়ত (তখন ০) এবং সবাই ১০০ লিখত — যোগফল ৩০০০ নয়, ১০০ হয়ে যেত।
    await Promise.all(
      Array.from({ length: N }).map(() => addTurnover(userId, 'sports', STAKE))
    );

    const b = await bonusRow(bonusId);
    expect(Number(b.sports_done)).toBe(N * STAKE);
  });

  test('৩০টি সমান্তরাল casino বাজির টার্নওভারও সম্পূর্ণ যোগ হয়', async () => {
    const userId = await makeUser();
    const bonusId = await makeActiveBonus(userId);

    const N = 30;
    const STAKE = 50;
    await Promise.all(
      Array.from({ length: N }).map(() => addTurnover(userId, 'casino', STAKE))
    );

    const b = await bonusRow(bonusId);
    expect(Number(b.casino_done)).toBe(N * STAKE);
  });

  test('sports ও casino একসাথে চললেও দুটো কলাম আলাদাভাবে সঠিক থাকে', async () => {
    const userId = await makeUser();
    const bonusId = await makeActiveBonus(userId);

    const calls = [];
    for (let i = 0; i < 20; i++) calls.push(addTurnover(userId, 'sports', 10));
    for (let i = 0; i < 20; i++) calls.push(addTurnover(userId, 'casino', 7));
    await Promise.all(calls);

    const b = await bonusRow(bonusId);
    expect(Number(b.sports_done)).toBe(200);
    expect(Number(b.casino_done)).toBe(140);
  });

  test('casino_required = 0 হলে (daily reward) ক্যাসিনো টার্নওভার গণনা হয় না', async () => {
    const userId = await makeUser();
    const bonusId = await makeActiveBonus(userId, { casinoRequired: 0 });

    await Promise.all(
      Array.from({ length: 10 }).map(() => addTurnover(userId, 'casino', 100))
    );

    const b = await bonusRow(bonusId);
    expect(Number(b.casino_done)).toBe(0);
  });

  test('completed বোনাসে দেরিতে আসা বাজি আর টার্নওভার যোগ করে না', async () => {
    const userId = await makeUser();
    const bonusId = await makeActiveBonus(userId);
    await pool.query(`UPDATE bonuses SET status='completed' WHERE id=$1`, [bonusId]);

    await addTurnover(userId, 'sports', 500);

    const b = await bonusRow(bonusId);
    expect(Number(b.sports_done)).toBe(0);
  });

  test('সোর্স-লেভেল গার্ড: read-modify-write প্যাটার্ন ফিরে আসেনি', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'services', 'turnover.js'), 'utf8'
    );
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    // পুরনো বাগি রূপ: SET sports_done = $1 (JS-এ হিসাব করা মান)
    expect(code).not.toMatch(/SET\s+sports_done\s*=\s*\$1/);
    expect(code).not.toMatch(/SET\s+casino_done\s*=\s*\$1/);
    // নতুন নিরাপদ রূপ: SQL-এই ইনক্রিমেন্ট
    expect(code).toMatch(/sports_done\s*=\s*sports_done\s*\+/);
    expect(code).toMatch(/casino_done\s*=\s*casino_done\s*\+/);
  });
});

describe('routes/payment — টার্নওভার গেট fail-closed (P2-01)', () => {
  test('canWithdraw() ব্যতিক্রম দিলে উইথড্র এগোয় না', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'routes', 'payment.js'), 'utf8'
    );
    // পুরনো রূপে catch ব্লকে শুধু console.error ছিল, কোনো return ছিল না — অর্থাৎ
    // চেক ব্যর্থ হলেই উইথড্র চলে যেত। এখন catch অবশ্যই রিডাইরেক্ট করে ফিরে যায়।
    const catchBlock = /catch \(e\) \{\s*console\.error\('turnover check error[^']*'[^)]*\);\s*\}/;
    expect(src).not.toMatch(catchBlock);
    expect(src).toContain('withdrawal blocked, fail-closed');
  });
});
