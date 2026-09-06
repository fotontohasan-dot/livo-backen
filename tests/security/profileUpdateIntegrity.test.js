const { getCsrfAgent, extractCsrfToken, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');

// ==================== Phase 2: প্রোফাইল আপডেট ====================
//
// /profile/update ও /profile/update-personal — দুটোই ব্যবহারকারীর নিজের
// পরিচয়সূচক ক্ষেত্র বদলায়। এখানে তিনটে আলাদা ঝুঁকি:
//
//   ১. mass assignment — request body-তে id পাঠিয়ে অন্যের সারি বদলানো।
//      কোডে query-গুলো req.session.user.id ব্যবহার করে, body-র কিছু নয়।
//
//   ২. পরিচয় দখল — অন্যের username বা phone নিজের নামে বসিয়ে দেওয়া।
//      phone দিয়ে অ্যাকাউন্ট রিকভারি হয়, তাই এটা দখলের রাস্তা হতে পারত।
//      DB-তে দুটোতেই unique index আছে, কিন্তু কোনো টেস্ট সেটা যাচাই করত না।
//
//   ৩. সেশন দূষণ — UPDATE ব্যর্থ হলেও req.session.user.* যদি বসে যেত,
//      তাহলে সেশন আর DB আলাদা হয়ে যেত এবং পেজে ভুল তথ্য দেখাত।

const PASSWORD = 'SecurePass123';

async function registerUser(prefix) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername(prefix);
  const phone = uniquePhone();
  await agent.post('/register').type('form').send({
    username, phone, password: PASSWORD, confirmPassword: PASSWORD, _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, username, phone, id: r.rows[0] && r.rows[0].id };
}

async function post(agent, path, body, csrfFrom) {
  const page = await agent.get(csrfFrom);
  const token = extractCsrfToken(page.text);
  return agent.post(path).type('form').send({ ...body, _csrf: token });
}

async function row(id) {
  const r = await pool.query(
    'SELECT username, phone, full_name FROM users WHERE id = $1', [id]
  );
  return r.rows[0];
}

async function cleanup(u) {
  if (!u || !u.id) return;
  await pool.query('DELETE FROM admin_logs WHERE admin_id = $1', [u.id]);
  await pool.query('DELETE FROM device_sessions WHERE user_id = $1', [u.id]);
  await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
}

describe('Phase 2 — প্রোফাইল আপডেটের অখণ্ডতা', () => {
  jest.setTimeout(90000);

  let alice;
  let bob;

  beforeEach(async () => {
    alice = await registerUser('pa');
    bob = await registerUser('pb');
  });

  afterEach(async () => {
    await cleanup(alice);
    await cleanup(bob);
  });

  test('body-তে id পাঠিয়ে অন্যের সারি বদলানো যায় না', async () => {
    const bobBefore = await row(bob.id);

    await post(alice.agent, '/profile/update',
      { id: bob.id, user_id: bob.id, username: uniqueUsername('hax') }, '/profile');

    // ববের সারি অক্ষত
    expect(await row(bob.id)).toEqual(bobBefore);
  });

  test('অন্যের username দখল করা যায় না', async () => {
    const aliceBefore = await row(alice.id);

    await post(alice.agent, '/profile/update', { username: bob.username }, '/profile');

    const after = await row(alice.id);
    expect(after.username).toBe(aliceBefore.username);
    // ববেরটাও বদলায়নি
    expect((await row(bob.id)).username).toBe(bob.username);
  });

  test('অন্যের phone দখল করা যায় না', async () => {
    // phone দিয়ে অ্যাকাউন্ট রিকভারি হয় — দখল করা গেলে সেটা
    // অ্যাকাউন্ট টেকওভারের রাস্তা হত।
    const aliceBefore = await row(alice.id);

    await post(alice.agent, '/profile/update-personal',
      { full_name: 'Alice Test', phone: bob.phone }, '/profile/security');

    expect((await row(alice.id)).phone).toBe(aliceBefore.phone);
    expect((await row(bob.id)).phone).toBe(bob.phone);
  });

  test('ব্যর্থ আপডেটের পরে সেশন আর DB আলাদা হয়ে যায় না', async () => {
    await post(alice.agent, '/profile/update', { username: bob.username }, '/profile');

    // প্রোফাইল পেজে যা দেখানো হয় তা DB-র মানের সাথে মিলতে হবে
    const dbUsername = (await row(alice.id)).username;
    const page = await alice.agent.get('/profile');
    expect(page.status).toBe(200);
    expect(page.text).toContain(dbUsername);
    expect(page.text).not.toContain(bob.username);
  });

  test('বৈধ পরিবর্তন কাজ করে', async () => {
    // উল্টো দিক — নাহলে "সব আপডেট ব্যর্থ" অবস্থাতেও উপরের সব টেস্ট
    // পাস করত, অর্থাৎ ফিচারটা সম্পূর্ণ ভাঙা থাকলেও সবুজ দেখাত।
    const fresh = uniqueUsername('ok');
    await post(alice.agent, '/profile/update', { username: fresh }, '/profile');
    expect((await row(alice.id)).username).toBe(fresh);
    alice.username = fresh;
  });
});
