const { Pool } = require('pg');

// ==================== SSL কনফিগারেশন (এনভায়রনমেন্ট-সচেতন) ====================
// আগে এখানে `ssl: { rejectUnauthorized: false }` হার্ডকোড করা ছিল, অর্থাৎ pg সবসময় SSL
// হ্যান্ডশেক করার চেষ্টা করত। ম্যানেজড প্রোডাকশন ডাটাবেসে (Render/Heroku/RDS) এটাই দরকার,
// কিন্তু GitHub Actions-এর `postgres:16` সার্ভিস কন্টেইনারে SSL ডিফল্টভাবে বন্ধ থাকে —
// ফলে CI-তে টেস্ট শুরু হওয়ার আগেই মাইগ্রেশন ধাপে ব্যর্থ হতো:
//     Migration error: The server does not support SSL connections
// (লোকাল Ubuntu-র postgres প্যাকেজে `ssl = on` ডিফল্ট, তাই লোকালি সমস্যাটা ধরা পড়ত না।)
//
// এখন:
//   • DATABASE_SSL স্পষ্টভাবে সেট করা থাকলে সেটাই চূড়ান্ত (true/false) — যেকোনো এনভায়রনমেন্টে
//     ম্যানুয়ালি ওভাররাইড করার সুযোগ থাকে।
//   • NODE_ENV=test (লোকাল টেস্ট ও CI) হলে SSL বন্ধ — লোকাল/সার্ভিস-কন্টেইনার ডাটাবেস
//     প্লেইন TCP-তেই চলে।
//   • বাকি সব ক্ষেত্রে (production সহ) আগের আচরণ অপরিবর্তিত।
function resolveSslConfig() {
  const explicit = (process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (explicit === 'false' || explicit === '0' || explicit === 'off') return false;
  if (explicit === 'true' || explicit === '1' || explicit === 'on') return { rejectUnauthorized: false };

  if (process.env.NODE_ENV === 'test') return false;

  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSslConfig()
});

const connectDB = async () => {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL not set. Skipping DB connection.');
    return;
  }
  let retries = 5;
  while (retries > 0) {
    try {
      await pool.query('SELECT 1');
      console.log('✅ PostgreSQL connected successfully');
      return;
    } catch (error) {
      retries--;
      console.error(`❌ PostgreSQL connection error (${5 - retries}/5):`, error.message);
      if (retries === 0) {
        console.warn('⚠️ Could not connect to database. Continuing without DB.');
        return;
      }
      console.log(`⏳ Retrying in 5 seconds...`);
      await new Promise(res => setTimeout(res, 5000));
    }
  }
};

module.exports = { pool, connectDB, resolveSslConfig };
