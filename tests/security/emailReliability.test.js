// P2 — ইমেইল রিলায়েবিলিটি।
// services/deviceTracking.js এর নতুন-ডিভাইস অ্যালার্ট আগে সরাসরি SMTP-তে await করত, আর
// recordDeviceLogin() নিজেই routes/auth.js এর register ও login দুই জায়গাতেই await করা হয়।
// ফলে আউটবাউন্ড SMTP ব্লকড/ধীর হলে (Render-এ সাধারণ) প্রতিটা নতুন-ডিভাইস লগইন ও রেজিস্ট্রেশন
// পুরো connectionTimeout (services/email.js — ১০ সেকেন্ড) ধরে ঝুলে থাকত।
// এখন বাকি সব ইমেইলের মতোই queue-তে যায়, তাই কোনো HTTP রিকোয়েস্ট SMTP-র জন্য অপেক্ষা করে না।
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const SMTP_CONNECTION_TIMEOUT_MS = 10000; // services/email.js এ সেট করা

async function waitForJob(kind, to, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query(
      `SELECT id, payload FROM job_queue
       WHERE type = 'email' AND payload->>'kind' = $1 AND payload->>'to' = $2
       ORDER BY id DESC LIMIT 1`,
      [kind, to]
    );
    if (r.rows.length) return r.rows[0];
    await new Promise(res => setTimeout(res, 100));
  }
  return null;
}

describe('Email reliability — new device alert', () => {
  test('রেজিস্ট্রেশন SMTP-র জন্য অপেক্ষা করে না, অ্যালার্টটা queue-তে যায়', async () => {
    const email = `${uniqueUsername('nd')}@example.test`;
    const { agent, token } = await getCsrfAgent('/register');

    const started = Date.now();
    const res = await agent
      .post('/register')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({
        username: uniqueUsername('nd'),
        email,
        phone: uniquePhone(),
        password: 'SecurePass123',
        confirmPassword: 'SecurePass123',
        _csrf: token
      });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(302);
    // SMTP টাইমআউটের ধারেকাছেও যাওয়া চলবে না — আগে এই রিকোয়েস্ট পুরো ১০ সেকেন্ড ব্লক হতো
    expect(elapsed).toBeLessThan(SMTP_CONNECTION_TIMEOUT_MS);

    const job = await waitForJob('new_device', email);
    expect(job).not.toBeNull();
    expect(job.payload.deviceName).toBeTruthy();
  });

  test('রেজিস্ট্রেশনের ভেরিফিকেশন ইমেইলও একই queue পথেই যায়', async () => {
    const email = `${uniqueUsername('vf')}@example.test`;
    const { agent, token } = await getCsrfAgent('/register');

    await agent
      .post('/register')
      .set('User-Agent', REALISTIC_UA)
      .type('form')
      .send({
        username: uniqueUsername('vf'),
        email,
        phone: uniquePhone(),
        password: 'SecurePass123',
        confirmPassword: 'SecurePass123',
        _csrf: token
      });

    const job = await waitForJob('verification', email);
    expect(job).not.toBeNull();
    expect(job.payload.verifyUrl).toMatch(/\/verify-email\/[a-f0-9]{64}$/);
  });

  test("queue হ্যান্ডলার 'new_device' kind চেনে (অজানা kind থ্রো করে)", async () => {
    const captured = {};
    const sent = [];

    jest.doMock('../../services/queue', () => ({
      registerHandler: (type, fn) => { captured[type] = fn; }
    }));
    // ইমেইল মডিউলটাও isolate করা হচ্ছে — নাহলে হ্যান্ডলার আসল SMTP-তে কল করে বসে
    jest.doMock('../../services/email', () => ({
      sendOTP: jest.fn(),
      sendPasswordReset: jest.fn(),
      sendVerificationEmail: jest.fn(),
      sendNewDeviceAlert: (to, data) => { sent.push({ to, data }); return Promise.resolve(); }
    }));
    jest.isolateModules(() => { require('../../services/queueHandlers'); });
    jest.dontMock('../../services/queue');
    jest.dontMock('../../services/email');

    expect(typeof captured.email).toBe('function');

    await captured.email({
      kind: 'new_device', to: 'x@example.test',
      username: 'someone', deviceName: 'Chrome on Windows',
      ip: '10.0.0.1', location: 'Dhaka', time: new Date().toISOString()
    });
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe('x@example.test');
    expect(sent[0].data.deviceName).toBe('Chrome on Windows');

    await expect(captured.email({ kind: 'no_such_kind', to: 'x@example.test' })).rejects.toThrow();
    await expect(captured.email({ kind: 'new_device' })).rejects.toThrow(); // "to" নেই
  });
});
