// রিগ্রেশন: routes/admin.js-এর /admin/notification-templates/:id/test-send রুটে ইমেইল
// চ্যানেলের জন্য একটা আলাদা, ad-hoc nodemailer transporter তৈরি হয় (services/email.js-এর
// মূল transporter থেকে ভিন্ন) — সেটাতে connectionTimeout/greetingTimeout/socketTimeout সেট
// ছিল না, ফলে SMTP পোর্ট ব্লকড থাকলে (অনেক হোস্টিং প্রোভাইডারে সাধারণ) এই টেস্ট-সেন্ড
// রিকোয়েস্টটা OS-লেভেল TCP timeout (৬০-১২০+ সেকেন্ড) পর্যন্ত ঝুলে থাকতে পারত। এই টেস্ট
// nodemailer.createTransport মক করে যাচাই করে যে transporter-টা এখন bounded timeout সহ তৈরি হয়।
jest.mock('nodemailer', () => {
  const actual = jest.requireActual('nodemailer');
  return {
    ...actual,
    createTransport: jest.fn((config) => ({
      __capturedConfig: config,
      sendMail: jest.fn(async () => ({ messageId: 'test-message-id' }))
    }))
  };
});

const nodemailer = require('nodemailer');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const phone = uniquePhone();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const row = (await pool.query('UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username])).rows[0];
  return { agent, token, userId: row.id };
}

async function makeEmailTemplate() {
  const key = `test_email_tmpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const row = (await pool.query(
    `INSERT INTO notification_templates (template_key, channel, lang, name, subject, body, variables)
     VALUES ($1, 'email', 'bn', 'Test Email Template', 'বিষয়', 'হ্যালো {{name}}', '["name"]')
     RETURNING id`,
    [key]
  )).rows[0];
  return row.id;
}

describe('Admin notification-template test-send — email transporter-এ bounded timeout আছে', () => {
  test('test-send transporter connectionTimeout/greetingTimeout/socketTimeout সহ তৈরি হয়', async () => {
    const { agent, token } = await makeAdminAgent();
    const tmplId = await makeEmailTemplate();

    const res = await agent.post(`/admin/notification-templates/${tmplId}/test-send`)
      .set('X-CSRF-Token', token)
      .send({ target: 'test@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(nodemailer.createTransport).toHaveBeenCalled();
    // module-load সময় services/email.js নিজেই একবার createTransport কল করে (সবসময় timeout
    // সহ) — তাই calls[0] নয়, সবচেয়ে *শেষ* কলটাই এই রিকোয়েস্টের সময় admin.js-এর ad-hoc
    // transporter থেকে আসা কলটা (route handler-এর ভেতরে প্রতি-রিকোয়েস্টে নতুন করে তৈরি হয়)।
    const calls = nodemailer.createTransport.mock.calls;
    const config = calls[calls.length - 1][0];
    expect(config.host).toBe('smtp.gmail.com');
    expect(config.connectionTimeout).toBeGreaterThan(0);
    expect(config.greetingTimeout).toBeGreaterThan(0);
    expect(config.socketTimeout).toBeGreaterThan(0);
  });
});
