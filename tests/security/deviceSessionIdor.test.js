const { getCsrfAgent, extractCsrfToken, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');

// ==================== Phase 2: সেশন ব্যবস্থাপনা ====================
//
// /profile/security-এ ইউজার নিজের সক্রিয় ডিভাইস দেখতে ও লগআউট করতে পারে।
// রুটটা /profile/devices/:id/logout — অর্থাৎ একটা অনুমানযোগ্য id URL-এ
// যায়। এখানে মালিকানা যাচাই না থাকলে যেকোনো লগইন-করা ব্যবহারকারী অন্য
// যেকোনো ব্যবহারকারীকে জোর করে লগআউট করিয়ে দিতে পারত — একটা নীরব
// denial-of-service, আর অ্যাকাউন্ট দখলের চেষ্টার সময় ভুক্তভোগীকে সরিয়ে
// দেওয়ার উপায়ও।
//
// services/deviceTracking.js-এ শর্তটা আছে (WHERE id = $1 AND user_id = $2)।
// এই টেস্ট সেটা সোর্সে পড়ে নয়, সত্যিকারের দুটো অ্যাকাউন্ট বানিয়ে রানটাইমে
// প্রমাণ করে — কারণ শর্তটা পরে সরিয়ে ফেলা হলে সোর্স-পাঠ ধরত, কিন্তু
// ভুল টেবিলে যোগ করা হলে ধরত না।

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('dev');
  const password = 'SecurePass123';
  await agent.post('/register').type('form').send({
    username, phone: uniquePhone(), password, confirmPassword: password, _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, username, id: r.rows[0] && r.rows[0].id };
}

async function deviceSessionIds(userId) {
  const r = await pool.query(
    'SELECT id FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id',
    [userId]
  );
  return r.rows.map((x) => x.id);
}

describe('Phase 2 — ডিভাইস সেশন অন্য ব্যবহারকারী বাতিল করতে পারে না', () => {
  jest.setTimeout(60000);

  let victim;
  let attacker;

  beforeAll(async () => {
    victim = await makeUser();
    attacker = await makeUser();
  });

  afterAll(async () => {
    for (const u of [victim, attacker]) {
      if (u && u.id) {
        await pool.query('DELETE FROM device_sessions WHERE user_id = $1', [u.id]);
        await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
      }
    }
  });

  test('দুটো অ্যাকাউন্টেরই সক্রিয় ডিভাইস সেশন আছে', async () => {
    expect(victim.id).toBeTruthy();
    expect(attacker.id).toBeTruthy();
    expect((await deviceSessionIds(victim.id)).length).toBeGreaterThan(0);
  });

  test('আক্রমণকারী ভুক্তভোগীর সেশন বাতিল করতে পারে না', async () => {
    const before = await deviceSessionIds(victim.id);
    expect(before.length).toBeGreaterThan(0);
    const targetId = before[0];

    // আক্রমণকারী নিজের সেশনে লগইন, কিন্তু URL-এ ভুক্তভোগীর device id
    // চলমান সেশন থেকেই নতুন CSRF টোকেন নেওয়া
    const page = await attacker.agent.get('/profile/security');
    const token = extractCsrfToken(page.text);
    await attacker.agent
      .post(`/profile/devices/${targetId}/logout`)
      .type('form')
      .send({ _csrf: token });

    // ভুক্তভোগীর সেশনটা অক্ষত থাকতে হবে
    const after = await deviceSessionIds(victim.id);
    expect(after).toContain(targetId);
  });

  test('নিজের সেশন নিজে বাতিল করতে পারে', async () => {
    // উল্টো দিকটাও যাচাই — নাহলে "সব রিকোয়েস্ট ব্যর্থ" হলেও উপরের
    // টেস্ট পাস করত, অর্থাৎ ফিচারটা ভাঙা থাকলেও ধরা পড়ত না।
    const own = await deviceSessionIds(attacker.id);
    expect(own.length).toBeGreaterThan(0);

    const page = await attacker.agent.get('/profile/security');
    const token = extractCsrfToken(page.text);
    await attacker.agent
      .post(`/profile/devices/${own[0]}/logout`)
      .type('form')
      .send({ _csrf: token });

    const after = await deviceSessionIds(attacker.id);
    expect(after).not.toContain(own[0]);
  });
});
