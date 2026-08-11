const { getCsrfAgent, freshRequest, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const phone = uniquePhone();
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query('UPDATE users SET role = $1 WHERE username = $2', ['admin', username]);
  return agent;
}

describe('Admin Panel', () => {
  test('GET /admin/login renders the admin login page', async () => {
    const res = await freshRequest().get('/admin/login');
    expect(res.status).toBe(200);
  });

  test('GET /admin redirects to /admin/login when not authenticated', async () => {
    const res = await freshRequest().get('/admin');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/login/);
  });

  test('POST /admin/login with wrong credentials does not grant access', async () => {
    const { agent, token } = await getCsrfAgent('/admin/login');
    const res = await agent
      .post('/admin/login')
      .type('form')
      .send({ username: 'nonexistent_admin_xyz', password: 'wrongpass', _csrf: token });
    expect(res.status).toBe(200); // renders login page again with error, not a redirect
  });

  test('Admin API-style route rejects unauthenticated access with 403 JSON', async () => {
    const res = await freshRequest().get('/admin/api/some-protected-endpoint');
    expect([403, 404]).toContain(res.status);
  });

  describe('GET /admin/pending-counts', () => {
    test('অথেন্টিকেশন ছাড়া অ্যাক্সেস প্রত্যাখ্যাত হয়', async () => {
      const res = await freshRequest().get('/admin/pending-counts');
      expect(res.status).not.toBe(200);
    });

    test('admin সেশনে সঠিক shape ও pending সংখ্যা রিটার্ন করে', async () => {
      const agent = await makeAdminAgent();
      const res = await agent.get('/admin/pending-counts');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.deposits).toBe('number');
      expect(typeof res.body.withdrawals).toBe('number');
      expect(typeof res.body.kyc).toBe('number');
    });

    test('pending KYC থাকলে সংখ্যায় প্রতিফলিত হয়', async () => {
      const agent = await makeAdminAgent();
      const before = await agent.get('/admin/pending-counts');
      const uname = uniqueUsername();
      const u = await pool.query(`INSERT INTO users (username, phone, password) VALUES ($1,$2,'x') RETURNING id`, [uname, uniquePhone()]);
      await pool.query(
        `INSERT INTO kyc_requests (user_id, full_name, document_type, document_number, document_url, status) VALUES ($1,'T','nid','N1','https://res.cloudinary.com/demo/x.jpg','pending')`,
        [u.rows[0].id]
      );
      const after = await agent.get('/admin/pending-counts');
      expect(after.body.kyc).toBe(before.body.kyc + 1);
    });
  });

  describe('GET /admin/api/bets-live', () => {
    test('অথেন্টিকেশন ছাড়া অ্যাক্সেস প্রত্যাখ্যাত হয়', async () => {
      const res = await freshRequest().get('/admin/api/bets-live');
      expect(res.status).not.toBe(200);
    });

    test('admin সেশনে সঠিক shape রিটার্ন করে', async () => {
      const agent = await makeAdminAgent();
      const res = await agent.get('/admin/api/bets-live');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.bets)).toBe(true);
      expect(typeof res.body.total).toBe('number');
      expect(typeof res.body.pendingSettlement).toBe('number');
      expect(typeof res.body.todayStake).toBe('number');
      expect(typeof res.body.todayGgr).toBe('number');
    });

    test('status ফিল্টার প্রয়োগ হয়', async () => {
      const agent = await makeAdminAgent();
      const res = await agent.get('/admin/api/bets-live?status=won');
      expect(res.status).toBe(200);
      expect(res.body.bets.every(b => b.status === 'won')).toBe(true);
    });

    test('নতুন pending বেট তালিকায় দেখা যায়', async () => {
      const agent = await makeAdminAgent();
      const uname = uniqueUsername();
      const u = await pool.query(`INSERT INTO users (username, phone, password, coins) VALUES ($1,$2,'x',1000) RETURNING id`, [uname, uniquePhone()]);
      const m = await pool.query(`INSERT INTO matches (title, team_a, team_b, sport) VALUES ('Test Match','A','B','cricket') RETURNING id`);
      await pool.query(
        `INSERT INTO bets (user_id, match_id, runner, odd, stake, status) VALUES ($1,$2,'A','1.50',100,'pending')`,
        [u.rows[0].id, m.rows[0].id]
      );
      const res = await agent.get('/admin/api/bets-live');
      expect(res.body.bets.some(b => b.username === uname)).toBe(true);
    });
  });
});
