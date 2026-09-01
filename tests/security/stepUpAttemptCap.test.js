// tests/security/stepUpAttemptCap.test.js
// ---------------------------------------------------------------------------
// VPN step-up ভেরিফিকেশন (/verify-access) — ৫ চেষ্টার সীমা atomic কি না।
//
// AUDIT FINDING (এখানে ঠিক করা হয়েছে): হ্যান্ডলারটি check-then-act ছিল — প্রথমে
// SELECT করে attempts পড়া হতো, তারপর আলাদা কোয়েরিতে attempts + 1। দুটোর মাঝে
// কোনো লক নেই, আর এই রুটে কোনো rate limiter-ও নেই। ফলে বহু রিকোয়েস্ট একসাথে
// পাঠালে সবাই একই attempts মান পড়ত এবং প্রত্যেকে একটি করে ভিন্ন কোড পরীক্ষা
// করতে পারত — ৫ চেষ্টার সীমা কার্যত অর্থহীন, ৬-অঙ্কের কোড সমান্তরালে
// ব্রুট-ফোর্স করা সম্ভব।
//
// এখানে সার্ভিস স্তরে সরাসরি DB-র বিপরীতে পরীক্ষা করা হচ্ছে (HTTP সেশনের
// pendingLoginUserId বসাতে আসল VPN detection দরকার হতো, যা টেস্টে নির্ভরযোগ্য
// নয়)। যে ইনভেরিয়েন্ট রক্ষা করতে হবে তা হলো: একটি কোড সারির বিপরীতে ৫টির বেশি
// চেষ্টা কখনো গোনা বা গ্রহণ করা যাবে না, সমান্তরাল হোক বা ক্রমিক।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');

let seq = 0;

async function makeUser() {
  seq++;
  const res = await pool.query(
    `INSERT INTO users (username, phone, password, coins) VALUES ($1, $2, 'x', 0) RETURNING id`,
    [`stepup_${Date.now()}_${seq}`, `0196${String(Date.now()).slice(-7)}${seq}`.slice(0, 14)]
  );
  return res.rows[0].id;
}

async function makeCode(userId, code = '123456', { ttlMinutes = 10 } = {}) {
  const res = await pool.query(
    `INSERT INTO step_up_verifications (user_id, code, purpose, ip, expires_at)
     VALUES ($1, $2, 'vpn_login', '1.2.3.4', NOW() + ($3 || ' minutes')::interval)
     RETURNING id`,
    [userId, code, String(ttlMinutes)]
  );
  return res.rows[0].id;
}

// রুটের atomic claim কোয়েরির হুবহু প্রতিরূপ — এটাই পরীক্ষার লক্ষ্য
async function attempt(userId, code) {
  const claim = await pool.query(
    `UPDATE step_up_verifications
        SET attempts = attempts + 1,
            verified_at = CASE WHEN code = $2 THEN NOW() ELSE NULL END
      WHERE id = (
              SELECT id FROM step_up_verifications
               WHERE user_id = $1 AND purpose = 'vpn_login' AND verified_at IS NULL
               ORDER BY created_at DESC LIMIT 1
            )
        AND attempts < 5
        AND verified_at IS NULL
        AND expires_at > NOW()
      RETURNING id, verified_at`,
    [userId, String(code || '')]
  );
  if (claim.rowCount === 0) return 'blocked';
  return claim.rows[0].verified_at ? 'verified' : 'wrong';
}

const attemptsOf = async (id) => Number(
  (await pool.query('SELECT attempts FROM step_up_verifications WHERE id=$1', [id])).rows[0].attempts
);

afterAll(async () => { await pool.end().catch(() => {}); });

describe('ক্রমিক চেষ্টা', () => {
  test('সঠিক কোড দিলে verified হয়', async () => {
    const u = await makeUser();
    await makeCode(u, '111111');
    expect(await attempt(u, '111111')).toBe('verified');
  });

  test('ভুল কোড চেষ্টা গোনে কিন্তু verify করে না', async () => {
    const u = await makeUser();
    const id = await makeCode(u, '222222');
    expect(await attempt(u, '999999')).toBe('wrong');
    expect(await attemptsOf(id)).toBe(1);
  });

  test('৫টি ভুল চেষ্টার পর সঠিক কোডও আর গ্রহণ করা হয় না', async () => {
    const u = await makeUser();
    const id = await makeCode(u, '333333');
    for (let i = 0; i < 5; i++) await attempt(u, '000000');
    expect(await attemptsOf(id)).toBe(5);
    expect(await attempt(u, '333333')).toBe('blocked');
  });

  test('মেয়াদোত্তীর্ণ কোড গ্রহণ করা হয় না', async () => {
    const u = await makeUser();
    await makeCode(u, '444444', { ttlMinutes: -1 });
    expect(await attempt(u, '444444')).toBe('blocked');
  });

  test('verify হয়ে যাওয়া কোড দ্বিতীয়বার ব্যবহার করা যায় না (replay)', async () => {
    const u = await makeUser();
    await makeCode(u, '555555');
    expect(await attempt(u, '555555')).toBe('verified');
    expect(await attempt(u, '555555')).toBe('blocked');
  });
});

describe('সমান্তরাল চেষ্টা — ব্রুট-ফোর্স সীমা', () => {
  test('২০টি সমান্তরাল ভুল চেষ্টাতেও attempts ৫ ছাড়ায় না', async () => {
    const u = await makeUser();
    const id = await makeCode(u, '666666');

    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      attempt(u, String(100000 + i))
    ));

    // check-then-act থাকলে সবগুলোই attempts=0 পড়ে ২০টা চেষ্টাই গোনা হতো
    expect(await attemptsOf(id)).toBeLessThanOrEqual(5);
  });

  test('২০টি সমান্তরাল চেষ্টার একটিতে সঠিক কোড থাকলেও সীমা ভাঙে না', async () => {
    const u = await makeUser();
    const id = await makeCode(u, '777777');

    const results = await Promise.all([
      ...Array.from({ length: 19 }, (_, i) => attempt(u, String(200000 + i))),
      attempt(u, '777777')
    ]);

    expect(await attemptsOf(id)).toBeLessThanOrEqual(5);
    // সঠিক কোড সর্বোচ্চ একবারই verify করতে পারে
    expect(results.filter(r => r === 'verified').length).toBeLessThanOrEqual(1);
  });

  test('সমান্তরাল সঠিক কোড — verify ঠিক একবারই হয়', async () => {
    const u = await makeUser();
    await makeCode(u, '888888');

    const results = await Promise.all(
      Array.from({ length: 5 }, () => attempt(u, '888888'))
    );
    expect(results.filter(r => r === 'verified')).toHaveLength(1);
  });
});
