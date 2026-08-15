// tests/render/adminBackupHealth.test.js
// ---------------------------------------------------------------------------
// অ্যাডমিন ড্যাশবোর্ডে ব্যাকআপ স্ট্যাটাস দৃশ্যমানতার রিগ্রেশন টেস্ট।
//
// কেন দরকার: শিডিউলড ব্যাকআপ ব্যর্থ হলে এখন Telegram অ্যালার্ট যায়, কিন্তু Telegram
// কনফিগার করা না থাকলে (বা মেসেজ মিস হলে) অ্যাডমিনের জানার একমাত্র উপায় ছিল
// /admin/backups খুলে দেখা। ড্যাশবোর্ডে Server Health ও Queue Health কার্ড আগে থেকেই
// ছিল, কিন্তু ব্যাকআপের কোনো ইঙ্গিত ছিল না — অথচ ডেটা backup_history-তে আগেই ছিল।
//
// এখানে লক করা হচ্ছে:
//   ১) ড্যাশবোর্ড ব্যাকআপ হেলথ কার্ড রেন্ডার করে;
//   ২) কোনো সফল ব্যাকআপ না থাকলে সেটা issue হিসেবে দেখানো হয়;
//   ৩) RBAC অপরিবর্তিত — নন-অ্যাডমিন ড্যাশবোর্ডে ঢুকতে পারে না।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

async function registerUser(agent, token) {
  const username = uniqueUsername();
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  return username;
}

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = await registerUser(agent, token);
  await pool.query('UPDATE users SET role = $1 WHERE username = $2', ['admin', username]);
  return agent;
}

describe('অ্যাডমিন ড্যাশবোর্ড — ব্যাকআপ হেলথ দৃশ্যমানতা', () => {
  test('ড্যাশবোর্ডে Backup Health কার্ড রেন্ডার হয়', async () => {
    const agent = await makeAdminAgent();
    const res = await agent.get('/admin').set('User-Agent', REALISTIC_UA);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Backup Health');
    expect(res.text).toContain('backup-health-badge');
    expect(res.text).toContain('/admin/backups');
  });

  test('সফল ব্যাকআপ রেকর্ড থাকলে শেষ সফল সময় দেখানো হয়', async () => {
    await pool.query(
      `INSERT INTO backup_history (type, filename, size_bytes, checksum, status, source, created_at)
       VALUES ('config', 'test-backup.bin', 128, 'abc', 'completed', 'scheduled', NOW())`
    );

    const agent = await makeAdminAgent();
    const res = await agent.get('/admin').set('User-Agent', REALISTIC_UA);

    expect(res.status).toBe(200);
    expect(res.text).toContain('bh-last-success');
    // সদ্য সফল ব্যাকআপ আছে, তাই "কোনো সফল ব্যাকআপ রেকর্ড নেই" বার্তা থাকা উচিত নয়
    expect(res.text).not.toContain('কোনো সফল ব্যাকআপ রেকর্ড নেই');
  });

  test('RBAC অপরিবর্তিত — সাধারণ ইউজার ড্যাশবোর্ড দেখতে পায় না', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    await registerUser(agent, token);

    const res = await agent.get('/admin').set('User-Agent', REALISTIC_UA);
    expect(res.status).not.toBe(200);
  });
});
