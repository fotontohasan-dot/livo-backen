// tests/profileChangePassword.test.js
// ---------------------------------------------------------------------------
// মাস্টার অডিট — routes/profile.js POST /profile/change-password।
//
// registration (routes/auth.js:251) ও reset-password (routes/auth.js:855) দুটোই
// নতুন পাসওয়ার্ডে ≥8 ক্যারেক্টার বাধ্যতামূলক করে, কিন্তু এই self-service
// change-password পথে কোনো length চেক-ই ছিল না — একটা লগইন করা ইউজার নিজের পাসওয়ার্ড
// এক ক্যারেক্টারে বদলে ফেলতে পারত। এই টেস্ট নিশ্চিত করে দুর্বল নতুন পাসওয়ার্ড
// প্রত্যাখ্যাত হয় (আসল পাসওয়ার্ড অপরিবর্তিত থাকে) এবং যথেষ্ট লম্বা পাসওয়ার্ড স্বাভাবিকভাবে
// কাজ করে (ফলস-পজিটিভ ব্লক নয়)।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

async function makeLoggedInUser(password = 'OriginalPass123') {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password, confirmPassword: password, _csrf: token });
  const row = (await pool.query('SELECT id, password FROM users WHERE username=$1', [username])).rows[0];
  return { agent, token, userId: row.id, originalHash: row.password };
}

describe('POST /profile/change-password — নতুন পাসওয়ার্ডের ন্যূনতম দৈর্ঘ্য', () => {
  test('৮ ক্যারেক্টারের কম নতুন পাসওয়ার্ড প্রত্যাখ্যাত হয়, পুরনো পাসওয়ার্ড অপরিবর্তিত থাকে', async () => {
    const U = await makeLoggedInUser();

    const res = await U.agent.post('/profile/change-password').set('X-CSRF-Token', U.token)
      .type('form').send({ current_password: 'OriginalPass123', new_password: 'short1', confirmPassword: 'short1' });

    expect(res.status).toBe(302); // flash + redirect, ৫xx নয়

    const row = await pool.query('SELECT password FROM users WHERE id=$1', [U.userId]);
    expect(row.rows[0].password).toBe(U.originalHash); // বদলায়নি

    // পুরনো পাসওয়ার্ড দিয়ে এখনো লগইন করা যায় (নতুন দুর্বল পাসওয়ার্ড সেভ হয়নি প্রমাণ)
    const stillMatches = await bcrypt.compare('OriginalPass123', row.rows[0].password);
    expect(stillMatches).toBe(true);
  });

  test('৮ ক্যারেক্টার বা তার বেশি নতুন পাসওয়ার্ড স্বাভাবিকভাবে গ্রহণ হয়', async () => {
    const U = await makeLoggedInUser();

    const res = await U.agent.post('/profile/change-password').set('X-CSRF-Token', U.token)
      .type('form').send({ current_password: 'OriginalPass123', new_password: 'NewLongPass456', confirmPassword: 'NewLongPass456' });

    expect(res.status).toBe(302);

    const row = await pool.query('SELECT password FROM users WHERE id=$1', [U.userId]);
    expect(row.rows[0].password).not.toBe(U.originalHash); // বদলেছে
    const matchesNew = await bcrypt.compare('NewLongPass456', row.rows[0].password);
    expect(matchesNew).toBe(true);
  });
});
