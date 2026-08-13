// tests/security/adminTelegram.test.js
// ---------------------------------------------------------------------------
// Admin → Telegram Integration পেজের নিরাপত্তা কভারেজ:
//   • অথেন্টিকেশন গেট (isAdmin) — লগইন ছাড়া/সাধারণ ইউজার ঢুকতে পারে না
//   • CSRF — টোকেন ছাড়া কোনো mutation পাস করে না
//   • Secret leakage — bot token কোনো পেজ বা JSON response-এ ফেরত যায় না
//   • Audit — সেটিংস পরিবর্তন admin_logs + audit_logs দুটোতেই লেখা হয়
//   • Validation — অবৈধ chat id / bot token গ্রহণ করা হয় না
// এই টেস্টগুলো DB ব্যবহার করে (বাকি tests/security/*.test.js-এর মতোই)।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('../helpers/app');
const telegramConfig = require('../../services/telegramConfig');

const FAKE_TOKEN = '987654321:AAF-zyxwvutsrqponmlkjihgfedcba987654';

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const phone = uniquePhone();
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const userRes = await pool.query('UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username]);
  return { agent, token, username, userId: userRes.rows[0].id };
}

async function makeUserAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  return { agent, token, username };
}

describe('Admin Telegram Integration (routes/adminTelegram.js)', () => {
  afterEach(async () => {
    await pool.query('DELETE FROM telegram_settings WHERE id = 1').catch(() => {});
    telegramConfig.invalidateCache();
  });

  describe('অথেন্টিকেশন ও অথরাইজেশন', () => {
    test('লগইন ছাড়া সেটিংস পেজে ঢোকা যায় না', async () => {
      const res = await freshRequest().get('/admin/telegram');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login');
    });

    test('সাধারণ (non-admin) ইউজারও ঢুকতে পারে না', async () => {
      const { agent } = await makeUserAgent();
      const res = await agent.get('/admin/telegram');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login');
    });

    test('লগইন ছাড়া কোনো mutation করা যায় না', async () => {
      const res = await freshRequest().post('/admin/telegram/settings').type('form').send({ enabled: 'true' });
      expect([302, 403]).toContain(res.status);
      const row = await pool.query('SELECT * FROM telegram_settings WHERE id = 1');
      expect(row.rows.length).toBe(0);
    });

    test('অ্যাডমিন পেজটি দেখতে পারে', async () => {
      const { agent } = await makeAdminAgent();
      const res = await agent.get('/admin/telegram');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Telegram');
    });
  });

  describe('CSRF সুরক্ষা', () => {
    test('CSRF টোকেন ছাড়া সেটিংস সেভ 403 দেয়', async () => {
      const { agent } = await makeAdminAgent();
      const res = await agent.post('/admin/telegram/settings').type('form').send({ enabled: 'true', chat_id: '123456789' });
      expect(res.status).toBe(403);
    });

    test('CSRF টোকেন ছাড়া টোকেন রোটেশন 403 দেয়', async () => {
      const { agent } = await makeAdminAgent();
      const res = await agent.post('/admin/telegram/token').type('form').send({ bot_token: FAKE_TOKEN });
      expect(res.status).toBe(403);
      const row = await pool.query('SELECT bot_token_enc FROM telegram_settings WHERE id = 1');
      expect(row.rows.length).toBe(0);
    });

    test('ভুল টোকেন দিয়ে কানেকশন টেস্টও 403 দেয়', async () => {
      const { agent } = await makeAdminAgent();
      const res = await agent.post('/admin/telegram/test').send({ send_message: false }).set('X-CSRF-Token', 'made-up-token');
      expect(res.status).toBe(403);
    });
  });

  describe('সেটিংস সেভ ও ভ্যালিডেশন', () => {
    test('বৈধ chat id ও ক্যাটাগরি টগল সেভ হয়', async () => {
      const { agent, token } = await makeAdminAgent();
      const res = await agent.post('/admin/telegram/settings').type('form').send({
        _csrf: token,
        enabled: 'true',
        chat_id: '-1001234567890',
        'categories[deposit]': 'true',
        'categories[support]': 'true'
      });
      expect(res.status).toBe(302);

      const row = (await pool.query('SELECT * FROM telegram_settings WHERE id = 1')).rows[0];
      expect(row.enabled).toBe(true);
      expect(row.chat_id).toBe('-1001234567890');
      expect(row.categories.deposit).toBe(true);
      expect(row.categories.withdraw).toBe(false); // আনচেক করা চেকবক্স
    });

    test('অবৈধ chat id গ্রহণ করা হয় না', async () => {
      const { agent, token } = await makeAdminAgent();
      const res = await agent.post('/admin/telegram/settings').type('form').send({
        _csrf: token, enabled: 'true', chat_id: "123'; DROP TABLE users;--"
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');
      const row = await pool.query('SELECT * FROM telegram_settings WHERE id = 1');
      expect(row.rows.length).toBe(0);
    });

    test('অবৈধ ফরম্যাটের bot token গ্রহণ করা হয় না', async () => {
      const { agent, token } = await makeAdminAgent();
      const res = await agent.post('/admin/telegram/token').type('form').send({ _csrf: token, bot_token: 'not-a-real-token' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');
    });
  });

  describe('Secret সুরক্ষা (bot token কখনো ফেরত যায় না)', () => {
    test('সেভ করা টোকেন DB-তে এনক্রিপ্টেড থাকে, plaintext নয়', async () => {
      const { agent, token } = await makeAdminAgent();
      await agent.post('/admin/telegram/token').type('form').send({ _csrf: token, bot_token: FAKE_TOKEN });

      const row = (await pool.query('SELECT bot_token_enc FROM telegram_settings WHERE id = 1')).rows[0];
      expect(row.bot_token_enc).toBeTruthy();
      expect(row.bot_token_enc).not.toContain(FAKE_TOKEN);
      expect(row.bot_token_enc.startsWith('v1:')).toBe(true);
    });

    test('পেজের HTML-এ পুরো টোকেন থাকে না (শুধু masked hint)', async () => {
      const { agent, token } = await makeAdminAgent();
      await agent.post('/admin/telegram/token').type('form').send({ _csrf: token, bot_token: FAKE_TOKEN });

      const res = await agent.get('/admin/telegram');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(FAKE_TOKEN);
      expect(res.text).toContain('987654321:');
    });

    test('/status JSON-এ টোকেন থাকে না', async () => {
      const { agent, token } = await makeAdminAgent();
      await agent.post('/admin/telegram/token').type('form').send({ _csrf: token, bot_token: FAKE_TOKEN });

      const res = await agent.get('/admin/telegram/status');
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(FAKE_TOKEN);
      expect(res.body.status.tokenSet).toBe(true);
      expect(res.body.status.botToken).toBeUndefined();
    });
  });

  describe('Audit logging', () => {
    test('সেটিংস পরিবর্তন admin_logs ও audit_logs দুটোতেই লেখা হয়', async () => {
      const { agent, token, username } = await makeAdminAgent();
      await agent.post('/admin/telegram/settings').type('form').send({
        _csrf: token, enabled: 'true', chat_id: '123456789', 'categories[deposit]': 'true'
      });

      const adminLog = await pool.query(
        `SELECT * FROM admin_logs WHERE admin_username = $1 AND action_type = 'TELEGRAM_SETTINGS_UPDATE'`, [username]
      );
      expect(adminLog.rows.length).toBeGreaterThan(0);

      // logEvent() fire-and-forget, তাই একটু সময় দিয়ে যাচাই
      await new Promise(r => setTimeout(r, 300));
      const auditLog = await pool.query(
        `SELECT * FROM audit_logs WHERE actor_username = $1 AND action = 'TELEGRAM_SETTINGS_CHANGED'`, [username]
      );
      expect(auditLog.rows.length).toBeGreaterThan(0);
      expect(auditLog.rows[0].category).toBe('settings');
    });

    test('টোকেন রোটেশন high-risk হিসেবে লগ হয় এবং লগে plaintext টোকেন থাকে না', async () => {
      const { agent, token, username } = await makeAdminAgent();
      await agent.post('/admin/telegram/token').type('form').send({ _csrf: token, bot_token: FAKE_TOKEN });

      const adminLog = await pool.query(
        `SELECT * FROM admin_logs WHERE admin_username = $1 AND action_type = 'TELEGRAM_TOKEN_ROTATED'`, [username]
      );
      expect(adminLog.rows.length).toBeGreaterThan(0);
      expect(adminLog.rows[0].details).not.toContain(FAKE_TOKEN);

      await new Promise(r => setTimeout(r, 300));
      const auditLog = await pool.query(
        `SELECT * FROM audit_logs WHERE actor_username = $1 AND action = 'TELEGRAM_TOKEN_ROTATED'`, [username]
      );
      expect(auditLog.rows.length).toBeGreaterThan(0);
      expect(auditLog.rows[0].risk_level).toBe('high');
      expect(JSON.stringify(auditLog.rows[0].details)).not.toContain(FAKE_TOKEN);
    });
  });

  describe('নোটিফিকেশন ফ্লো', () => {
    test('ইন্টিগ্রেশন বন্ধ থাকলে টেস্ট নোটিফিকেশন পাঠানো হয় না', async () => {
      const { agent, token } = await makeAdminAgent();
      await agent.post('/admin/telegram/settings').type('form').send({ _csrf: token, enabled: 'false', chat_id: '123456789' });

      const res = await agent.post('/admin/telegram/test-notification')
        .set('X-CSRF-Token', token)
        .send({ category: 'deposit' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.reason).toBe('disabled');
    });

    test('ক্যাটাগরি বন্ধ থাকলে সেই ক্যাটাগরির নোটিফিকেশন আটকায়', async () => {
      const { agent, token } = await makeAdminAgent();
      // withdraw আনচেক রেখে সেভ
      await agent.post('/admin/telegram/settings').type('form').send({
        _csrf: token, enabled: 'true', chat_id: '123456789', 'categories[deposit]': 'true'
      });
      await agent.post('/admin/telegram/token').type('form').send({ _csrf: token, bot_token: FAKE_TOKEN });

      const res = await agent.post('/admin/telegram/test-notification')
        .set('X-CSRF-Token', token)
        .send({ category: 'withdraw' });

      expect(res.status).toBe(400);
      expect(res.body.reason).toBe('category_disabled');
    });
  });
});
