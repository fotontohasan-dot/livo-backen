// tests/render/viewSmoke.test.js
// ---------------------------------------------------------------------------
// EJS রেন্ডার স্মোক টেস্ট।
//
// কেন দরকার: প্রোডাকশন অডিটে দুটো টেমপ্লেট বাগ ধরা পড়েছিল যেগুলো ৩৪৭টা টেস্টের পুরো স্যুট
// পাস করা সত্ত্বেও অদৃশ্য ছিল, কারণ দুটোই শুধুমাত্র *ডেটা থাকলে* ট্রিগার হতো:
//   • views/leaderboard.ejs — লুপের ভেতরে undefined `market`/`market` রেফারেন্স ছিল। ইউজার
//     তালিকা খালি থাকলে লুপ চলত না, তাই পেজ 200 দিত; একটাও ইউজার থাকলেই 500।
//   • views/admin/backups.ejs — size_bytes (BIGINT) স্ট্রিং হিসেবে আসে, ১০২৪-এর কম হলে
//     n.toFixed() TypeError দিত। কোনো ব্যাকআপ রেকর্ড না থাকলে row() কখনো কল হতো না।
//
// তাই এই ফাইলে দুই স্তরের কভারেজ:
//   ১) সব .ejs ফাইল অন্তত সিনট্যাক্টিক্যালি কম্পাইল হয় (টাইপো/আনক্লোজড ট্যাগ ধরে)।
//   ২) গুরুত্বপূর্ণ পেজগুলো *বাস্তব ডেটা সিড করে* HTTP দিয়ে রেন্ডার করা হয় এবং 500 না
//      হওয়া নিশ্চিত করা হয় — উপরের দুই ধরনের বাগ এখানেই ধরা পড়বে।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('../helpers/app');

const VIEWS_DIR = path.join(__dirname, '..', '..', 'views');

function listEjsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listEjsFiles(full));
    else if (entry.name.endsWith('.ejs')) out.push(full);
  }
  return out;
}

async function registerUser(agent, token) {
  const username = uniqueUsername();
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const row = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return { username, userId: row.rows[0] ? row.rows[0].id : null };
}

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const { username } = await registerUser(agent, token);
  const res = await pool.query('UPDATE users SET role = $1 WHERE username = $2 RETURNING id', ['admin', username]);
  return { agent, token, userId: res.rows[0].id };
}

describe('EJS রেন্ডার স্মোক টেস্ট', () => {
  describe('সব টেমপ্লেট কম্পাইল হয়', () => {
    const files = listEjsFiles(VIEWS_DIR);

    test('views/ ডিরেক্টরিতে টেমপ্লেট পাওয়া গেছে', () => {
      expect(files.length).toBeGreaterThan(0);
    });

    test('প্রতিটা .ejs ফাইল সিনট্যাক্স এরর ছাড়াই কম্পাইল হয়', () => {
      const failures = [];
      for (const file of files) {
        try {
          // include() রিজলভ করার জন্য filename দরকার; compile() রান করে না, শুধু পার্স করে
          ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file, client: false });
        } catch (err) {
          failures.push(`${path.relative(VIEWS_DIR, file)}: ${err.message.split('\n')[0]}`);
        }
      }
      expect(failures).toEqual([]);
    });
  });

  describe('ডেটা থাকা অবস্থায় পেজ রেন্ডার (রিগ্রেশন গার্ড)', () => {
    let adminAgent;
    let seededUserId;

    beforeAll(async () => {
      const admin = await makeAdminAgent();
      adminAgent = admin.agent;

      // পাবলিক লিডারবোর্ডে অন্তত একটা সারি থাকা নিশ্চিত করা — খালি তালিকায় বাগটা লুকিয়ে থাকত
      const { agent, token } = await getCsrfAgent('/register');
      const seeded = await registerUser(agent, token);
      seededUserId = seeded.userId;
      await pool.query('UPDATE users SET total_points = 500 WHERE id = $1', [seededUserId]);

      // ব্যাকআপ পেজে অন্তত একটা সারি — size_bytes ১০২৪-এর কম রাখা হচ্ছে ইচ্ছাকৃতভাবে,
      // কারণ ওই কেসেই BIGINT→string বাগটা ট্রিগার হতো
      await pool.query(
        `INSERT INTO backup_history (type, filename, size_bytes, encrypted, compressed, checksum, status, source)
         VALUES ('config', 'smoke-test-backup.tar.gz', 512, false, true, 'deadbeef', 'completed', 'manual')`
      );
    });

    test('পাবলিক /leaderboard — ইউজার থাকা অবস্থায় 200 (500 নয়)', async () => {
      const res = await freshRequest().get('/leaderboard');
      expect(res.status).toBe(200);
    });

    test('/leaderboard আউটপুটে সিড করা ইউজারের সারি থাকে', async () => {
      const res = await freshRequest().get('/leaderboard');
      expect(res.status).toBe(200);
      expect(res.text).toContain('PTS');
    });

    test('/admin/backups — ছোট (১ KB-এর কম) ব্যাকআপ রেকর্ড থাকা অবস্থায় 200', async () => {
      const res = await adminAgent.get('/admin/backups');
      expect(res.status).toBe(200);
      expect(res.text).toContain('smoke-test-backup.tar.gz');
    });

    test('/admin/backups — সাইজ মানুষ-পাঠযোগ্য ফরম্যাটে দেখায় (toFixed ক্র্যাশ নয়)', async () => {
      const res = await adminAgent.get('/admin/backups');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/512\.0 B/);
    });

    test('/admin/leaderboard — সার্চসহ 200 এবং লোড-এরর মেসেজ দেখায় না', async () => {
      const res = await adminAgent.get('/admin/leaderboard?search=smoke');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('লিডারবোর্ড লোড করা যায়নি');
    });

    test('গুরুত্বপূর্ণ পাবলিক পেজগুলো কোনোটাই 500 দেয় না', async () => {
      const paths = ['/', '/login', '/register', '/leaderboard', '/matches', '/sports', '/news', '/promotions', '/tournaments'];
      const failures = [];
      for (const p of paths) {
        const res = await freshRequest().get(p);
        if (res.status >= 500) failures.push(`${p} → ${res.status}`);
      }
      expect(failures).toEqual([]);
    });

    test('গুরুত্বপূর্ণ অ্যাডমিন পেজগুলো কোনোটাই 500 দেয় না', async () => {
      const paths = ['/admin/dashboard', '/admin/backups', '/admin/leaderboard', '/admin/kyc', '/admin/deposits'];
      const failures = [];
      for (const p of paths) {
        const res = await adminAgent.get(p);
        if (res.status >= 500) failures.push(`${p} → ${res.status}`);
      }
      expect(failures).toEqual([]);
    });
  });
});
