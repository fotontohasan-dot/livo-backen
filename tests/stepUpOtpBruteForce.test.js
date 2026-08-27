// tests/stepUpOtpBruteForce.test.js
// ---------------------------------------------------------------------------
// মাস্টার অডিট — routes/auth.js POST /verify-access (VPN/Tor লগইনের ইমেইল step-up OTP)।
//
// আগে ব্রুট-ফোর্স ক্যাপ ভাঙা ছিল: SELECT কোয়েরিতে `attempts` কলামটাই আনা হতো না
// (`SELECT id, user_id, purpose, code, expires_at, verified_at, created_at ...`), অথচ
// পরের চেক করত `if (row.attempts >= 5)` — row.attempts সবসময় undefined, তাই
// `undefined >= 5` কখনোই true হতো না। DB-তে attempts কাউন্ট ঠিকই বাড়ত (UPDATE ...
// SET attempts = attempts + 1), কিন্তু সেই কাউন্ট কখনো enforce হতো না — ইউজার
// unlimited বার ভুল কোড চেষ্টা করতে পারত, শুধু generalLimiter (300/15min, IP-ভিত্তিক)
// ছাড়া আর কোনো বাধা ছাড়াই। ৬-অঙ্কের কোড আর ১০ মিনিটের TTL মিলিয়ে এটা বাস্তবে
// ব্রুট-ফোর্সেবল ছিল।
//
// ফিক্স: SELECT-এ attempts কলাম যোগ করা হয়েছে। এই টেস্ট pendingLoginUserId সরাসরি
// session store-এ (user_sessions টেবিল, connect-pg-simple) লিখে এবং একটা
// step_up_verifications সারি সরাসরি DB-তে বসিয়ে পুরো VPN-detection/email-পাঠানো
// নির্ভরতা এড়িয়ে সরাসরি /verify-access রুটের ব্রুট-ফোর্স-ক্যাপ লজিক যাচাই করে।
// ---------------------------------------------------------------------------

const request = require('supertest');
// supertest-কে সরাসরি express অ্যাপ না দিয়ে helpers/app.js-এর শেয়ার্ড listening
// সার্ভার দেওয়া হচ্ছে — নাহলে supertest প্রতি রিকোয়েস্টে নিজে listen/close করে,
// যা সমান্তরাল রিকোয়েস্টে ECONNRESET তৈরি করত (helpers/app.js-এর ব্যাখ্যা দেখো)।
const { app } = require('./helpers/app');
const { pool } = require('../db');

function extractCsrfToken(html) {
  const match = /<meta name="csrf-token" content="([^"]*)"/.exec(html || '');
  return match ? match[1] : '';
}

async function makeUserWithPendingStepUp() {
  const username = 'stepup' + Date.now() + Math.floor(Math.random() * 1000);
  const phone = '019' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const userRes = await pool.query(
    `INSERT INTO users (username, phone, password, email, email_verified) VALUES ($1, $2, 'x', $3, true) RETURNING id`,
    [username, phone, `${username}@example.com`]
  );
  const userId = userRes.rows[0].id;

  const codeRes = await pool.query(
    `INSERT INTO step_up_verifications (user_id, code, purpose, ip, expires_at)
     VALUES ($1, '123456', 'vpn_login', '1.2.3.4', NOW() + INTERVAL '10 minutes') RETURNING id`,
    [userId]
  );
  const stepUpId = codeRes.rows[0].id;

  // একটা GET দিয়ে সেশন + CSRF টোকেন দুটোই স্থাপন করা হচ্ছে (raw supertest agent — .jar দরকার
  // পরের ধাপে session store-এ সরাসরি লেখার জন্য, তাই helpers/app.js-এর wrapAgentWithIp()
  // ব্যবহার করা হচ্ছে না, যেটা raw agent-কে wrap করে .jar অ্যাক্সেস লুকিয়ে ফেলে)
  const agent = request.agent(app);
  const getRes = await agent.get('/login');
  const token = extractCsrfToken(getRes.text);

  // agent-এর cookie jar থেকে sid বের করে সরাসরি session store-এ pendingLoginUserId বসানো —
  // VPN-detection/ইমেইল-পাঠানো নির্ভরতা ছাড়াই আসল রুট-লজিক (SELECT+attempts চেক) যাচাই করতে।
  // supertest/superagent-এর agent.jar `cookiejar` প্যাকেজের CookieJar (tough-cookie নয়)।
  const { CookieAccessInfo } = require('cookiejar');
  const sidCookie = agent.jar.getCookie('connect.sid', CookieAccessInfo.All);
  const rawSid = decodeURIComponent(sidCookie.value).split('.')[0].replace(/^s:/, '');

  const sessRow = await pool.query(`SELECT sess FROM user_sessions WHERE sid = $1`, [rawSid]);
  const sess = sessRow.rows[0].sess;
  sess.pendingLoginUserId = userId;
  await pool.query(`UPDATE user_sessions SET sess = $1 WHERE sid = $2`, [JSON.stringify(sess), rawSid]);

  return { agent, token, userId, stepUpId };
}

describe('POST /verify-access — step-up OTP ব্রুট-ফোর্স ক্যাপ (5 attempts)', () => {
  test('৫ বার ভুল কোডের পর ৬ষ্ঠ চেষ্টায় সঠিক কোড দিলেও প্রত্যাখ্যাত হয় (session ইতিমধ্যে ক্লিয়ার)', async () => {
    const { agent, token, stepUpId } = await makeUserWithPendingStepUp();

    for (let i = 0; i < 5; i++) {
      const res = await agent.post('/verify-access').type('form').send({ code: '999999', _csrf: token });
      expect(res.status).toBe(302);
    }

    const row = await pool.query(`SELECT attempts, verified_at FROM step_up_verifications WHERE id = $1`, [stepUpId]);
    expect(Number(row.rows[0].attempts)).toBe(5); // প্রতিটা ভুল চেষ্টায় সত্যিই বেড়েছে
    expect(row.rows[0].verified_at).toBeNull();

    // ৬ষ্ঠ চেষ্টা — এবার সঠিক কোড দিয়েও, কারণ ক্যাপ ইতিমধ্যে পার হয়ে গেছে (fix-এর আগে
    // এই চেকটাই কখনো true হতো না, তাই সঠিক কোড এখানে ভুলভাবে গ্রহণ হয়ে যেত)
    const finalRes = await agent.post('/verify-access').type('form').send({ code: '123456', _csrf: token });
    expect(finalRes.status).toBe(302);
    expect(finalRes.headers.location).toBe('/login');

    const finalRow = await pool.query(`SELECT verified_at FROM step_up_verifications WHERE id = $1`, [stepUpId]);
    expect(finalRow.rows[0].verified_at).toBeNull(); // কখনো verify হয়নি
  });

  test('৫ বারের কমে সঠিক কোড দিলে স্বাভাবিকভাবে verify হয় (ক্যাপ ফলস-পজিটিভ ব্লক করছে না)', async () => {
    const { agent, token, stepUpId } = await makeUserWithPendingStepUp();

    await agent.post('/verify-access').type('form').send({ code: '000000', _csrf: token });
    await agent.post('/verify-access').type('form').send({ code: '111111', _csrf: token });

    const row = await pool.query(`SELECT attempts FROM step_up_verifications WHERE id = $1`, [stepUpId]);
    expect(Number(row.rows[0].attempts)).toBe(2);

    const res = await agent.post('/verify-access').type('form').send({ code: '123456', _csrf: token });
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toBe('/login');

    const finalRow = await pool.query(`SELECT verified_at FROM step_up_verifications WHERE id = $1`, [stepUpId]);
    expect(finalRow.rows[0].verified_at).not.toBeNull();
  });
});
