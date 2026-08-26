// রিগ্রেশন: routes/admin.js-এর /admin/notification-templates/:id/test-send রুটে SMS চ্যানেলের
// জন্য services/sms.js-এর sendSms() কখনো throw করে না — গেটওয়ে ব্যর্থ হলে { ok: false, message }
// রিটার্ন করে (services/sms.js:31)। আগে রেসপন্স সবসময় `{ success: true, ...result }` পাঠাত,
// ফলে result.ok===false হলেও top-level success hardcoded true থেকে যেত — অ্যাডমিন UI শুধু
// data.success দেখে (views/admin/notification-template-form.ejs), তাই একটা আসল SMS ব্যর্থতা
// সবুজ "পাঠানো হয়েছে" হিসেবে দেখানো হতো। এই টেস্ট services/sms মক করে sendSms() ব্যর্থ করায়,
// আর যাচাই করে যে রেসপন্সের success ফিল্ড এখন সত্যিকারের ফলাফল প্রতিফলিত করে।
jest.mock('../../services/sms', () => ({
  sendSms: jest.fn()
}));

const { sendSms } = require('../../services/sms');
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

async function makeSmsTemplate() {
  const key = `test_sms_tmpl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const row = (await pool.query(
    `INSERT INTO notification_templates (template_key, channel, lang, name, subject, body, variables)
     VALUES ($1, 'sms', 'bn', 'Test SMS Template', NULL, 'হ্যালো {{name}}', '["name"]')
     RETURNING id`,
    [key]
  )).rows[0];
  return row.id;
}

describe('Admin notification-template test-send — SMS success ফ্ল্যাগ সত্যিকারের ফলাফল প্রতিফলিত করে', () => {
  test('sendSms ব্যর্থ হলে (ok:false) রেসপন্সের success ও false হয়', async () => {
    sendSms.mockResolvedValueOnce({ ok: false, simulated: false, message: 'SMS গেটওয়ে এরর (500): boom' });

    const { agent, token } = await makeAdminAgent();
    const tmplId = await makeSmsTemplate();

    const res = await agent.post(`/admin/notification-templates/${tmplId}/test-send`)
      .set('X-CSRF-Token', token)
      .send({ target: '01700000000' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.ok).toBe(false);
  });

  test('sendSms সফল হলে (ok:true) রেসপন্সের success ও true হয়', async () => {
    sendSms.mockResolvedValueOnce({ ok: true, simulated: false, message: 'SMS পাঠানো হয়েছে' });

    const { agent, token } = await makeAdminAgent();
    const tmplId = await makeSmsTemplate();

    const res = await agent.post(`/admin/notification-templates/${tmplId}/test-send`)
      .set('X-CSRF-Token', token)
      .send({ target: '01700000000' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
