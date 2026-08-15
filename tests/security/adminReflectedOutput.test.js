// tests/security/adminReflectedOutput.test.js
// ---------------------------------------------------------------------------
// দুটো আলাদা কিন্তু সম্পর্কিত ত্রুটির গার্ড, দুটোই অ্যাডমিন পেজে "রিফ্লেক্ট" হওয়া ডেটা নিয়ে।
//
// ১) রিফ্লেক্টেড XSS — views/admin/backups.ejs ও views/admin/cache.ejs টেমপ্লেট-লিটারেলে
//    সরাসরি `+ created +`, `+ restored +`, `+ cleared +` বসাত। এই তিনটাই req.query থেকে
//    আসে এবং পুরো body `<%- %>` দিয়ে র (unescaped) HTML হিসেবে রেন্ডার হয় — অর্থাৎ
//    একটা লিঙ্কে ক্লিক করালেই অ্যাডমিনের সেশনে ইচ্ছেমতো স্ক্রিপ্ট চালানো যেত। অন্য সব
//    রিফ্লেক্টেড মান এই ফাইলগুলোতে escapeHtml() দিয়েই যেত, এই তিনটাই বাদ পড়েছিল।
//
// ২) আংশিক রিস্টোর "সফল" দেখানো — restoreDatabaseBackup() FK/কনস্ট্রেইন্টে বাদ পড়া
//    সারিগুলো result._skipped-এ গোনে, কিন্তু রুট নিঃশর্তভাবে সবুজ "রিস্টোর সম্পন্ন হয়েছে"
//    ব্যানারে রিডাইরেক্ট করত। ফলে ডেটা হারানো সত্ত্বেও অ্যাডমিন সম্পূর্ণ সফল রিস্টোর দেখত —
//    ব্যাকআপ সিস্টেমে এটাই সবচেয়ে বিপজ্জনক ব্যর্থতা, কারণ ভুল আত্মবিশ্বাস তৈরি করে।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const backupManager = require('../../services/backupManager');

const XSS = '<script>alert(1)</script>';
const XSS_IMG = '"><img src=x onerror=alert(1)>';

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query("UPDATE users SET role='admin', role_key='super_admin' WHERE username=$1", [username]);
  return { agent, token };
}

describe('অ্যাডমিন পেজে রিফ্লেক্টেড মান ও রিস্টোর রিপোর্টিং', () => {
  let admin;
  let csrf;

  beforeAll(async () => {
    admin = await makeAdminAgent();
    const page = await admin.agent.get('/admin/backups');
    const m = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '');
    csrf = m ? m[1] : admin.token;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('/admin/backups?restored= এ স্ক্রিপ্ট ট্যাগ এস্কেপ হয়ে যায়', async () => {
    const res = await admin.agent.get(`/admin/backups?restored=${encodeURIComponent(XSS)}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(XSS);
    expect(res.text).toContain('&lt;script&gt;'); // এস্কেপড রূপে আছে, কার্যকর ট্যাগ হিসেবে নয়
  });

  test('/admin/backups?created= এ অ্যাট্রিবিউট-ব্রেকিং পে-লোড এস্কেপ হয়', async () => {
    const res = await admin.agent.get(`/admin/backups?created=${encodeURIComponent(XSS_IMG)}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<img src=x onerror=');
  });

  test('/admin/cache?cleared= এ স্ক্রিপ্ট ট্যাগ এস্কেপ হয়ে যায়', async () => {
    const res = await admin.agent.get(`/admin/cache?cleared=${encodeURIComponent(XSS)}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(XSS);
  });

  test('আংশিক রিস্টোর সবুজ "সম্পন্ন" ব্যানারে দেখানো হয় না', async () => {
    const record = { id: 987001, type: 'database', filename: 'db-partial.bak', status: 'completed' };
    jest.spyOn(backupManager, 'getBackupById').mockResolvedValue(record);
    // দুইটা টেবিলে মোট ৫টা সারি বাদ পড়েছে — রিস্টোর আংশিক
    jest.spyOn(backupManager, 'restoreBackup').mockResolvedValue({
      users: 10, bets: 4, _skipped: { bets: 3, referrals: 2 }
    });

    const res = await admin.agent.post(`/admin/backups/${record.id}/restore`)
      .type('form').send({ _csrf: csrf });

    expect(res.status).toBe(302);
    const location = res.headers.location || '';
    expect(location).toContain('skipped=5');
    expect(location).toContain('error=restore_partial');
    // টেবিলের নাম বা pg-এর কারণ URL-এ যায় না
    expect(location).not.toContain('referrals');
    expect(location).not.toContain('bets');
  });

  test('আংশিক রিস্টোরের পেজে স্পষ্ট সতর্কতা দেখা যায়', async () => {
    const res = await admin.agent.get('/admin/backups?restored=database&skipped=5&error=restore_partial');
    expect(res.status).toBe(200);
    expect(res.text).toContain('আংশিক');
    expect(res.text).toContain('5');
    // "সম্পূর্ণ সফল" বার্তাটা যেন একই সাথে না দেখায়
    expect(res.text).not.toContain('database রিস্টোর সম্পন্ন হয়েছে');
  });

  test('সম্পূর্ণ সফল রিস্টোর আগের মতোই সফল হিসেবেই দেখানো হয় (আচরণ অপরিবর্তিত)', async () => {
    const record = { id: 987002, type: 'database', filename: 'db-full.bak', status: 'completed' };
    jest.spyOn(backupManager, 'getBackupById').mockResolvedValue(record);
    jest.spyOn(backupManager, 'restoreBackup').mockResolvedValue({ users: 10, bets: 7 });

    const res = await admin.agent.post(`/admin/backups/${record.id}/restore`)
      .type('form').send({ _csrf: csrf });

    expect(res.status).toBe(302);
    const location = res.headers.location || '';
    expect(location).toContain('restored=database');
    expect(location).not.toContain('skipped=');
    expect(location).not.toContain('restore_partial');
  });
});
