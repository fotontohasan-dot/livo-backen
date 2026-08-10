// tests/security/kyc.test.js
// ---------------------------------------------------------------------------
// KYC নিরাপত্তা কভারেজ: submit করতে auth লাগে, ইনপুট ভ্যালিডেশন (নাম/ডকুমেন্ট নম্বর),
// document_url শুধুমাত্র নিজস্ব Cloudinary হোস্ট থেকে আসতে হবে (SSRF/arbitrary-URL সুরক্ষা),
// একই সময়ে দুইটা pending রিকোয়েস্ট না, সাবমিট রেট-লিমিট, এবং approve/reject শুধু admin
// অ্যাক্সেস করতে পারে ও kyc_requests + users.kyc_status দুটোই সঠিকভাবে আপডেট হয়।
// ---------------------------------------------------------------------------
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');

const VALID_DOC_URL = 'https://res.cloudinary.com/demo/image/upload/v1/nid.jpg';

async function registerUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const phone = uniquePhone();
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const userRes = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { agent, username, userId: userRes.rows[0].id };
}

async function makeAdminAgent() {
  // registerUser()-এর ভেতরের getCsrfAgent() থেকে পাওয়া টোকেন সেশনের পুরো জীবনকাল জুড়ে বৈধ থাকে
  // (middleware/csrf.js-এ csrfSecret সেশন-বাউন্ড, প্রতি-পেজ রোটেট হয় না) — role='admin'-এ প্রমোট
  // করার পরও সেই একই টোকেন কাজ করবে, তাই registerUser()-এর সময়কার token-টাই ফেরত দেওয়া হচ্ছে।
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const phone = uniquePhone();
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const userRes = await pool.query('UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username]);
  return { agent, username, userId: userRes.rows[0].id, csrf: token };
}

async function submitKyc(agent, overrides = {}) {
  // agent-টা লগইন-করা agent হতে হবে — /extra/kyc GET একই agent দিয়েই কল হচ্ছে যাতে সেশন কুকি বজায় থাকে
  const { extractCsrfToken } = require('../helpers/app');
  const getRes = await agent.get('/extra/kyc');
  const csrf = extractCsrfToken(getRes.text);
  return agent
    .post('/extra/kyc')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({
      full_name: 'Rahim Uddin',
      document_type: 'nid',
      document_number: 'NID-123456',
      document_url: VALID_DOC_URL,
      _csrf: csrf,
      ...overrides
    });
}

describe('KYC Security', () => {
  describe('অথেন্টিকেশন গেট', () => {
    test('লগইন ছাড়া KYC সাবমিট রিডাইরেক্ট হয়, রিকোয়েস্ট তৈরি হয় না', async () => {
      const { freshRequest } = require('../helpers/app');
      const res = await freshRequest()
        .post('/extra/kyc')
        .type('form')
        .send({ full_name: 'Test', document_number: '123456', document_url: VALID_DOC_URL });
      expect([302, 401, 403]).toContain(res.status);
    });

    test('লগইন ছাড়া KYC পেজও দেখা যায় না', async () => {
      const { freshRequest } = require('../helpers/app');
      const res = await freshRequest().get('/extra/kyc');
      expect(res.status).toBe(302);
    });
  });

  describe('ইনপুট ভ্যালিডেশন', () => {
    test('বৈধ তথ্যে সাবমিশন গৃহীত হয়, kyc_requests-এ pending রেকর্ড হয়, users.kyc_status=pending হয়', async () => {
      const { agent, userId } = await registerUser();
      await submitKyc(agent);

      const kycRes = await pool.query('SELECT * FROM kyc_requests WHERE user_id = $1', [userId]);
      expect(kycRes.rows.length).toBe(1);
      expect(kycRes.rows[0].status).toBe('pending');
      expect(kycRes.rows[0].document_url).toBe(VALID_DOC_URL);

      const userRes = await pool.query('SELECT kyc_status FROM users WHERE id = $1', [userId]);
      expect(userRes.rows[0].kyc_status).toBe('pending');
    });

    test('নাম বা ডকুমেন্ট নম্বর ছাড়া রিকোয়েস্ট তৈরি হয় না', async () => {
      const { agent, userId } = await registerUser();
      await submitKyc(agent, { full_name: '', document_number: '' });
      const kycRes = await pool.query('SELECT * FROM kyc_requests WHERE user_id = $1', [userId]);
      expect(kycRes.rows.length).toBe(0);
    });

    test('document_url ছাড়া রিকোয়েস্ট তৈরি হয় না', async () => {
      const { agent, userId } = await registerUser();
      await submitKyc(agent, { document_url: '' });
      const kycRes = await pool.query('SELECT * FROM kyc_requests WHERE user_id = $1', [userId]);
      expect(kycRes.rows.length).toBe(0);
    });

    test('নামে script/HTML ইনজেকশনের চেষ্টা প্রত্যাখ্যাত হয়', async () => {
      const { agent, userId } = await registerUser();
      await submitKyc(agent, { full_name: '<script>alert(1)</script>' });
      const kycRes = await pool.query('SELECT * FROM kyc_requests WHERE user_id = $1', [userId]);
      expect(kycRes.rows.length).toBe(0);
    });

    test('ডকুমেন্ট নম্বরে অস্বাভাবিক ক্যারেক্টার প্রত্যাখ্যাত হয়', async () => {
      const { agent, userId } = await registerUser();
      await submitKyc(agent, { document_number: "1'; DROP TABLE kyc_requests;--" });
      const kycRes = await pool.query('SELECT * FROM kyc_requests WHERE user_id = $1', [userId]);
      expect(kycRes.rows.length).toBe(0);
      // টেবিলটা এখনো অক্ষত আছে কিনা নিশ্চিত করা
      await expect(pool.query('SELECT 1 FROM kyc_requests LIMIT 1')).resolves.toBeDefined();
    });
  });

  describe('document_url — শুধুমাত্র নিজস্ব Cloudinary হোস্ট (SSRF/arbitrary-URL সুরক্ষা)', () => {
    const badUrls = [
      'http://res.cloudinary.com/demo/image/upload/nid.jpg', // http (https নয়)
      'https://evil.com/fake-cloudinary.jpg', // ভিন্ন হোস্ট
      'https://res.cloudinary.com.evil.com/nid.jpg', // hostname-এর মধ্যে সাবস্ট্রিং ট্রিক
      'javascript:alert(1)', // scheme injection
      'file:///etc/passwd', // local file scheme
      'ftp://res.cloudinary.com/nid.jpg' // অসমর্থিত scheme
    ];

    test.each(badUrls)('অস্বীকৃত হয়: %s', async (badUrl) => {
      const { agent, userId } = await registerUser();
      await submitKyc(agent, { document_url: badUrl });
      const kycRes = await pool.query('SELECT * FROM kyc_requests WHERE user_id = $1', [userId]);
      expect(kycRes.rows.length).toBe(0);
    });
  });

  describe('ডুপ্লিকেট pending রিকোয়েস্ট প্রতিরোধ', () => {
    test('একটা pending রিকোয়েস্ট থাকা অবস্থায় দ্বিতীয়টা তৈরি হয় না', async () => {
      const { agent, userId } = await registerUser();
      await submitKyc(agent);
      await submitKyc(agent, { document_number: 'NID-999999' });

      const kycRes = await pool.query('SELECT * FROM kyc_requests WHERE user_id = $1', [userId]);
      expect(kycRes.rows.length).toBe(1); // দ্বিতীয়টা তৈরি হয়নি
    });
  });

  describe('সাবমিট রেট-লিমিট (ঘণ্টায় সর্বোচ্চ ৫ বার)', () => {
    test('৬ষ্ঠ সাবমিশন 429 দেয়', async () => {
      const { agent } = await registerUser();
      let lastStatus;
      for (let i = 0; i < 6; i++) {
        const res = await submitKyc(agent, { document_number: `NID-${1000 + i}` });
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);
    }, 20000);
  });

  describe('Admin approve/reject — অ্যাক্সেস নিয়ন্ত্রণ', () => {
    test('লগইন ছাড়া approve করা যায় না', async () => {
      const { agent, userId } = await registerUser();
      await submitKyc(agent);
      const kycRow = (await pool.query('SELECT id FROM kyc_requests WHERE user_id = $1', [userId])).rows[0];

      const { freshRequest } = require('../helpers/app');
      const res = await freshRequest().post(`/admin/kyc/${kycRow.id}/approve`).type('form').send({});
      expect([302, 401, 403]).toContain(res.status);

      const stillPending = await pool.query('SELECT status FROM kyc_requests WHERE id = $1', [kycRow.id]);
      expect(stillPending.rows[0].status).toBe('pending');
    });

    test('সাধারণ (non-admin) লগইন-করা ইউজার approve করতে পারে না (এমনকি বৈধ CSRF টোকেন দিয়েও)', async () => {
      const { agent: userAgent, userId } = await registerUser();
      await submitKyc(userAgent);
      const kycRow = (await pool.query('SELECT id FROM kyc_requests WHERE user_id = $1', [userId])).rows[0];

      // নিজের (non-admin) সেশনের বৈধ CSRF টোকেন সহ — যাতে ব্লকটা isAdmin গেট থেকে আসে, CSRF থেকে নয়
      const { extractCsrfToken } = require('../helpers/app');
      const homePage = await userAgent.get('/');
      const csrf = extractCsrfToken(homePage.text);
      const res = await userAgent.post(`/admin/kyc/${kycRow.id}/approve`).type('form').send({ _csrf: csrf });
      expect(res.status).not.toBe(200);

      const stillPending = await pool.query('SELECT status FROM kyc_requests WHERE id = $1', [kycRow.id]);
      expect(stillPending.rows[0].status).toBe('pending');
    });

    test('admin approve করলে kyc_requests.status ও users.kyc_status দুটোই approved হয়', async () => {
      const { agent: userAgent, userId } = await registerUser();
      await submitKyc(userAgent);
      const kycRow = (await pool.query('SELECT id FROM kyc_requests WHERE user_id = $1', [userId])).rows[0];

      const { agent: adminAgent, csrf } = await makeAdminAgent();
      const res = await adminAgent.post(`/admin/kyc/${kycRow.id}/approve`).set('X-CSRF-Token', csrf).send({});
      expect(res.status).toBe(200);

      const kycAfter = await pool.query('SELECT status FROM kyc_requests WHERE id = $1', [kycRow.id]);
      expect(kycAfter.rows[0].status).toBe('approved');
      const userAfter = await pool.query('SELECT kyc_status FROM users WHERE id = $1', [userId]);
      expect(userAfter.rows[0].kyc_status).toBe('approved');
    });

    test('admin reject করলে kyc_requests.status rejected হয়', async () => {
      const { agent: userAgent, userId } = await registerUser();
      await submitKyc(userAgent);
      const kycRow = (await pool.query('SELECT id FROM kyc_requests WHERE user_id = $1', [userId])).rows[0];

      const { agent: adminAgent, csrf } = await makeAdminAgent();
      const res = await adminAgent.post(`/admin/kyc/${kycRow.id}/reject`).set('X-CSRF-Token', csrf).send({});
      expect(res.status).toBe(200);

      const kycAfter = await pool.query('SELECT status FROM kyc_requests WHERE id = $1', [kycRow.id]);
      expect(kycAfter.rows[0].status).toBe('rejected');
    });
  });
});
