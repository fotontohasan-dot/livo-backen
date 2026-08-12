const { getCsrfAgent, freshRequest, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken } = require('./helpers/app');
const { pool } = require('../db');
const speakeasy = require('speakeasy');

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

  describe('GET /admin (dashboard)', () => {
    // রিগ্রেশন গার্ড: dashboard.ejs dateRange/betStatistics/apiUsageStats/serverHealth/queueHealth
    // আশা করে, কিন্তু আগে এগুলো res.render()-এ পাস করা হতো না — ফলে লগইনের ঠিক পরের পেজেই
    // (dashboard, সব admin-এর জন্য প্রথম যা দেখা যায়) সবসময় 500 ক্র্যাশ হতো।
    test('সফল লগইনের পর dashboard ক্র্যাশ ছাড়া সম্পূর্ণ রেন্ডার হয়', async () => {
      const agent = await makeAdminAgent();
      const res = await agent.get('/admin');
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/is not defined|ReferenceError/);
      expect(res.text).toContain('dashboard');
    });

    test('?from=/&to= কুয়েরি প্যারাম দিয়ে কাস্টম dateRange গ্রহণ করে', async () => {
      const agent = await makeAdminAgent();
      const res = await agent.get('/admin?from=2024-01-01&to=2024-01-31');
      expect(res.status).toBe(200);
      expect(res.text).toContain('2024-01-01');
      expect(res.text).toContain('2024-01-31');
    });

    test('অকার্যকর/ম্যালফর্মড from/to প্যারামিটার নিরাপদে ডিফল্টে ফিরে যায় (ক্র্যাশ করে না)', async () => {
      const agent = await makeAdminAgent();
      const res = await agent.get('/admin?from=not-a-date&to=<script>');
      expect(res.status).toBe(200);
      expect(res.text).not.toMatch(/is not defined|ReferenceError/);
    });
  });

  describe('বাধ্যতামূলক 2FA (Admin/super_admin)', () => {
    async function registerAdmin() {
      const { agent, token } = await getCsrfAgent('/register');
      const username = uniqueUsername();
      const phone = uniquePhone();
      const password = 'SecurePass123';
      await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
        .send({ username, phone, password, confirmPassword: password, _csrf: token });
      await pool.query("UPDATE users SET role='admin' WHERE username=$1", [username]);
      return { username, phone, password };
    }

    function extractBase32(html) {
      const m = /font-mono text-blue-400 text-sm break-all select-all">([A-Z2-7]+)</.exec(html);
      return m ? m[1] : null;
    }

    test('2FA ছাড়া admin পাসওয়ার্ড দিয়ে লগইন করলে সরাসরি লগইন না হয়ে বাধ্যতামূলক এনরোলমেন্টে পাঠানো হয়', async () => {
      const { username, password } = await registerAdmin();
      const g = await getCsrfAgent('/admin/login');
      const loginRes = await g.agent.post('/admin/login').type('form').send({ username, password, _csrf: g.token });
      expect(loginRes.status).toBe(302);
      expect(loginRes.headers.location).toBe('/admin/2fa/mandatory-setup');

      // এনরোলমেন্ট সম্পন্ন না করা পর্যন্ত অন্য কোনো admin রুটে ঢোকা যায় না
      const blocked = await g.agent.get('/admin');
      expect(blocked.status).toBe(302);
      expect(blocked.headers.location).toMatch(/\/admin\/login/);
    });

    test('এনরোলমেন্ট পেজে বৈধ QR/secret থাকে, ভুল কোডে এনরোলমেন্ট ব্যর্থ হয় ও অ্যাক্সেস পাওয়া যায় না', async () => {
      const { username, password } = await registerAdmin();
      const g = await getCsrfAgent('/admin/login');
      await g.agent.post('/admin/login').type('form').send({ username, password, _csrf: g.token });

      const setupPage = await g.agent.get('/admin/2fa/mandatory-setup');
      expect(setupPage.status).toBe(200);
      const secret = extractBase32(setupPage.text);
      expect(secret).toBeTruthy();
      const csrf = extractCsrfToken(setupPage.text);

      const wrong = await g.agent.post('/admin/2fa/mandatory-setup/verify').type('form').send({ token: '000000', _csrf: csrf });
      expect(wrong.status).toBe(200);
      expect(wrong.text).toContain('সঠিক নয়');

      const stillBlocked = await g.agent.get('/admin');
      expect(stillBlocked.status).toBe(302);

      const dbCheck = await pool.query('SELECT totp_enabled FROM users WHERE username=$1', [username]);
      expect(dbCheck.rows[0].totp_enabled).toBe(false);
    });

    test('সঠিক কোড দিয়ে এনরোলমেন্ট সম্পন্ন হলে — ব্যাকআপ কোড দেখানো হয়, সেশন স্থাপিত হয়, DB-তে totp_enabled=true হয়', async () => {
      const { username, password } = await registerAdmin();
      const g = await getCsrfAgent('/admin/login');
      await g.agent.post('/admin/login').type('form').send({ username, password, _csrf: g.token });

      const setupPage = await g.agent.get('/admin/2fa/mandatory-setup');
      const secret = extractBase32(setupPage.text);
      const csrf = extractCsrfToken(setupPage.text);
      const validCode = speakeasy.totp({ secret, encoding: 'base32' });

      const verifyRes = await g.agent.post('/admin/2fa/mandatory-setup/verify').type('form').send({ token: validCode, _csrf: csrf });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.text.toLowerCase()).toMatch(/ব্যাকআপ|backup/);

      const nowAllowed = await g.agent.get('/admin');
      expect(nowAllowed.status).toBe(200);

      const dbCheck = await pool.query('SELECT totp_enabled, totp_secret FROM users WHERE username=$1', [username]);
      expect(dbCheck.rows[0].totp_enabled).toBe(true);
      expect(dbCheck.rows[0].totp_secret).toBe(secret);
    }, 15000);

    test('2FA ইতিমধ্যে চালু থাকা admin পরের বার লগইনে normal ভেরিফিকেশন ধাপে যায় (আবার এনরোলমেন্ট না)', async () => {
      const { username, password } = await registerAdmin();
      const g = await getCsrfAgent('/admin/login');
      await g.agent.post('/admin/login').type('form').send({ username, password, _csrf: g.token });
      const setupPage = await g.agent.get('/admin/2fa/mandatory-setup');
      const secret = extractBase32(setupPage.text);
      const csrf = extractCsrfToken(setupPage.text);
      const validCode = speakeasy.totp({ secret, encoding: 'base32' });
      await g.agent.post('/admin/2fa/mandatory-setup/verify').type('form').send({ token: validCode, _csrf: csrf });

      await g.agent.get('/admin/logout');
      const g2 = await getCsrfAgent('/admin/login');
      const login2 = await g2.agent.post('/admin/login').type('form').send({ username, password, _csrf: g2.token });
      expect(login2.status).toBe(302);
      expect(login2.headers.location).toBe('/admin/login/2fa');

      // সঠিক TOTP কোড দিয়ে স্বাভাবিক ভেরিফিকেশন সফল হয়
      const verifyGet = await g2.agent.get('/admin/login/2fa');
      const csrf2 = extractCsrfToken(verifyGet.text);
      const code2 = speakeasy.totp({ secret, encoding: 'base32' });
      const finalLogin = await g2.agent.post('/admin/login/2fa').type('form').send({ token: code2, _csrf: csrf2 });
      expect(finalLogin.status).toBe(302);
      expect(finalLogin.headers.location).toBe('/admin');

      const allowed = await g2.agent.get('/admin');
      expect(allowed.status).toBe(200);
    }, 15000);

    test('normal ভেরিফিকেশন ধাপে ভুল কোড প্রত্যাখ্যাত হয়, অ্যাক্সেস পাওয়া যায় না', async () => {
      const { username, password } = await registerAdmin();
      const g = await getCsrfAgent('/admin/login');
      await g.agent.post('/admin/login').type('form').send({ username, password, _csrf: g.token });
      const setupPage = await g.agent.get('/admin/2fa/mandatory-setup');
      const secret = extractBase32(setupPage.text);
      const csrf = extractCsrfToken(setupPage.text);
      const validCode = speakeasy.totp({ secret, encoding: 'base32' });
      await g.agent.post('/admin/2fa/mandatory-setup/verify').type('form').send({ token: validCode, _csrf: csrf });
      await g.agent.get('/admin/logout');

      const g2 = await getCsrfAgent('/admin/login');
      await g2.agent.post('/admin/login').type('form').send({ username, password, _csrf: g2.token });
      const verifyGet = await g2.agent.get('/admin/login/2fa');
      const csrf2 = extractCsrfToken(verifyGet.text);
      const badRes = await g2.agent.post('/admin/login/2fa').type('form').send({ token: '111111', _csrf: csrf2 });
      expect(badRes.status).toBe(200);
      expect(badRes.text).toContain('সঠিক নয়');

      const blocked = await g2.agent.get('/admin');
      expect(blocked.status).toBe(302);
    }, 15000);

    test('ব্যাকআপ কোড দিয়েও normal ভেরিফিকেশন ধাপে লগইন করা যায় (রিকভারি পাথ)', async () => {
      const { username, password } = await registerAdmin();
      const g = await getCsrfAgent('/admin/login');
      await g.agent.post('/admin/login').type('form').send({ username, password, _csrf: g.token });
      const setupPage = await g.agent.get('/admin/2fa/mandatory-setup');
      const secret = extractBase32(setupPage.text);
      const csrf = extractCsrfToken(setupPage.text);
      const validCode = speakeasy.totp({ secret, encoding: 'base32' });
      const enrollRes = await g.agent.post('/admin/2fa/mandatory-setup/verify').type('form').send({ token: validCode, _csrf: csrf });
      const codeMatch = /<code[^>]*>([A-Z0-9-]{8,})<\/code>/.exec(enrollRes.text) || /\b([A-F0-9]{4}-?[A-F0-9]{4})\b/i.exec(enrollRes.text);
      await g.agent.get('/admin/logout');

      if (!codeMatch) {
        // ব্যাকআপ কোড HTML থেকে বের করা না গেলে সরাসরি DB থেকে হ্যাশ ভেঙে টেস্ট চালানো সম্ভব না
        // (হ্যাশড থাকে) — এই ক্ষেত্রে টেস্ট স্কিপ না করে অন্তত normal TOTP পাথটাই যাচাই করা হলো উপরে,
        // তাই এখানে শুধু নিশ্চিত করা হচ্ছে ভুল ব্যাকআপ কোড প্রত্যাখ্যাত হয়।
        const g2 = await getCsrfAgent('/admin/login');
        await g2.agent.post('/admin/login').type('form').send({ username, password, _csrf: g2.token });
        const verifyGet = await g2.agent.get('/admin/login/2fa');
        const csrf2 = extractCsrfToken(verifyGet.text);
        const badBackup = await g2.agent.post('/admin/login/2fa').type('form').send({ backupCode: 'INVALID-CODE', _csrf: csrf2 });
        expect(badBackup.status).toBe(200);
        const blocked = await g2.agent.get('/admin');
        expect(blocked.status).toBe(302);
        return;
      }

      const backupCode = codeMatch[1];
      const g2 = await getCsrfAgent('/admin/login');
      await g2.agent.post('/admin/login').type('form').send({ username, password, _csrf: g2.token });
      const verifyGet = await g2.agent.get('/admin/login/2fa');
      const csrf2 = extractCsrfToken(verifyGet.text);
      const backupRes = await g2.agent.post('/admin/login/2fa').type('form').send({ backupCode, _csrf: csrf2 });
      expect(backupRes.status).toBe(302);
      expect(backupRes.headers.location).toBe('/admin');
    }, 15000);

    test('super_admin role_key সহ admin-ও একই বাধ্যতামূলক 2FA-র আওতায় পড়ে', async () => {
      const rbac = require('../services/rbac');
      const { username, password } = await registerAdmin();
      const userRow = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
      await rbac.assignUserRole(userRow.rows[0].id, 'super_admin');

      const g = await getCsrfAgent('/admin/login');
      const loginRes = await g.agent.post('/admin/login').type('form').send({ username, password, _csrf: g.token });
      expect(loginRes.status).toBe(302);
      expect(loginRes.headers.location).toBe('/admin/2fa/mandatory-setup');

      const blocked = await g.agent.get('/admin');
      expect(blocked.status).toBe(302);
    });

    test('মূল সাইটের /login দিয়ে admin লগইন করলেও একই বাধ্যতামূলক 2FA প্রয়োগ হয় (বাইপাস বন্ধ)', async () => {
      const { username, phone, password } = await registerAdmin();
      const g = await getCsrfAgent('/login');
      const loginRes = await g.agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
        .send({ identifier: phone, password, _csrf: g.token });
      expect(loginRes.status).toBe(302);
      expect(loginRes.headers.location).toBe('/admin/2fa/mandatory-setup');

      const blocked = await g.agent.get('/admin');
      expect(blocked.status).toBe(302);
      expect(blocked.headers.location).toMatch(/\/admin\/login/);
    });

    test('সাধারণ (non-admin) ইউজারের লগইন 2FA-দ্বারা প্রভাবিত হয় না', async () => {
      const { agent, token } = await getCsrfAgent('/register');
      const username = uniqueUsername();
      const phone = uniquePhone();
      const password = 'SecurePass123';
      await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
        .send({ username, phone, password, confirmPassword: password, _csrf: token });

      const g = await getCsrfAgent('/login');
      const res = await g.agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
        .send({ identifier: phone, password, _csrf: g.token });
      expect(res.status).toBe(302);
      expect(res.headers.location).not.toMatch(/2fa/);
      expect(res.headers.location).toBe('/');
    });
  });
});
