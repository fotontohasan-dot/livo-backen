const { getCsrfAgent, extractCsrfToken, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');

// ==================== Phase 2: পাসওয়ার্ড পরিবর্তন ====================
//
// পাসওয়ার্ড বদলানোর আসল নিরাপত্তা-উদ্দেশ্য শুধু নতুন পাসওয়ার্ড সেট করা নয় —
// চলমান অন্য সেশনগুলো কেটে দেওয়া। পাসওয়ার্ড ফাঁস হয়ে গেলে ভুক্তভোগীর
// একমাত্র হাতিয়ার এটাই; সেশন না কাটলে আক্রমণকারীর কুকি বৈধ থেকেই যায়
// এবং পাসওয়ার্ড বদলানো কার্যত অর্থহীন হয়ে পড়ে।
//
// routes/profile.js এটা করে (revokeAllOtherSessions), কিন্তু কোনো টেস্ট
// সম্পত্তিটা যাচাই করত না। কেউ লাইনটা সরিয়ে দিলে সব টেস্ট সবুজই থাকত।

const PASSWORD = 'SecurePass123';
const NEW_PASSWORD = 'EvenSaferPass456';

async function registerUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('pw');
  await agent.post('/register').type('form').send({
    username, phone: uniquePhone(), password: PASSWORD,
    confirmPassword: PASSWORD, _csrf: token
  });
  const r = await pool.query('SELECT id, password FROM users WHERE username = $1', [username]);
  return { agent, username, id: r.rows[0] && r.rows[0].id, hash: r.rows[0] && r.rows[0].password };
}

// দ্বিতীয় ডিভাইস সেশন সরাসরি DB-তে বসানো।
//
// লগইন প্রবাহে বট-ডিটেকশন ও ডিভাইস যাচাই আছে, তাই টেস্ট harness-এ
// দ্বিতীয় সত্যিকারের সেশন বানানো ভঙ্গুর। কিন্তু যাচাইয়ের বিষয়টা লগইন নয় —
// "পাসওয়ার্ড বদলালে অন্য সেশনগুলো revoked হয় কি না"। তাই সারিটা সরাসরি
// বসিয়ে revoked_at পরীক্ষা করা হয়; এটা আরও সরাসরি পর্যবেক্ষণ।
async function insertOtherSession(userId) {
  const r = await pool.query(
    `INSERT INTO device_sessions (user_id, sid, device_name, revoked_at)
     VALUES ($1, $2, $3, NULL) RETURNING id`,
    [userId, 'test-sid-' + Date.now(), 'Other Device']
  );
  return r.rows[0].id;
}

async function isRevoked(id) {
  const r = await pool.query('SELECT revoked_at FROM device_sessions WHERE id = $1', [id]);
  return !!(r.rows[0] && r.rows[0].revoked_at);
}

async function currentHash(id) {
  const r = await pool.query('SELECT password FROM users WHERE id = $1', [id]);
  return r.rows[0] && r.rows[0].password;
}

async function changePassword(agent, body) {
  const page = await agent.get('/profile/security');
  const token = extractCsrfToken(page.text);
  return agent.post('/profile/change-password').type('form').send({ ...body, _csrf: token });
}

describe('Phase 2 — পাসওয়ার্ড পরিবর্তন', () => {
  jest.setTimeout(90000);

  let user;

  beforeEach(async () => {
    user = await registerUser();
  });

  afterEach(async () => {
    if (user && user.id) {
      // পাসওয়ার্ড পরিবর্তন admin_logs-এ একটা সারি লেখে, যেটা users-এ
      // foreign key ধরে রাখে — তাই আগে সেটা মুছতে হয়।
      await pool.query('DELETE FROM admin_logs WHERE admin_id = $1', [user.id]);
      await pool.query('DELETE FROM device_sessions WHERE user_id = $1', [user.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    }
  });

  test('ভুল current password দিলে পাসওয়ার্ড বদলায় না', async () => {
    await changePassword(user.agent, {
      current_password: 'CompletelyWrong999', new_password: NEW_PASSWORD
    });
    expect(await currentHash(user.id)).toBe(user.hash);
  });

  test('current password ছাড়া পাঠালেও বদলায় না', async () => {
    // ফিল্ডটা অনুপস্থিত থাকলে bcrypt.compare(undefined, ...) — কোডটা যেন
    // ক্র্যাশ করে ৫০০ না দেয়, আবার পাসওয়ার্ডও যেন না বদলায়।
    const res = await changePassword(user.agent, { new_password: NEW_PASSWORD });
    expect(res.status).toBeLessThan(500);
    expect(await currentHash(user.id)).toBe(user.hash);
  });

  test('৮ অক্ষরের কম নতুন পাসওয়ার্ড প্রত্যাখ্যাত', async () => {
    await changePassword(user.agent, {
      current_password: PASSWORD, new_password: 'short7'
    });
    expect(await currentHash(user.id)).toBe(user.hash);
  });

  test('সঠিক তথ্যে পাসওয়ার্ড বদলায় এবং অন্য সেশনগুলো কেটে যায়', async () => {
    // "আক্রমণকারীর" সেশনের প্রতিরূপ
    const otherId = await insertOtherSession(user.id);
    expect(await isRevoked(otherId)).toBe(false);

    await changePassword(user.agent, {
      current_password: PASSWORD, new_password: NEW_PASSWORD
    });

    // পাসওয়ার্ড সত্যিই বদলেছে
    expect(await currentHash(user.id)).not.toBe(user.hash);

    // অন্য সেশনটা বাতিল — এটাই মূল সম্পত্তি। এটা না হলে পাসওয়ার্ড
    // বদলানো কার্যত অর্থহীন: চুরি হওয়া কুকি বৈধ থেকেই যেত।
    expect(await isRevoked(otherId)).toBe(true);

    // নিজের সেশন টিকে থাকে (নাহলে ব্যবহারকারী নিজেই বেরিয়ে যেত)
    const own = await user.agent.get('/profile');
    expect(own.status).toBe(200);
  });

  test('পরিবর্তনের সময় password_changed_at বসে', async () => {
    await changePassword(user.agent, {
      current_password: PASSWORD, new_password: NEW_PASSWORD
    });
    const r = await pool.query('SELECT password_changed_at FROM users WHERE id = $1', [user.id]);
    expect(r.rows[0].password_changed_at).toBeTruthy();
  });
});
