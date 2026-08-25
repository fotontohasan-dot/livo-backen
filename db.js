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

// ==================== কানেকশন পুলের স্পষ্ট সীমা (অডিট P2-14) ====================
// আগে কোনো পুল কনফিগ ছিল না, অর্থাৎ pg-র ডিফল্ট max=10 এবং কোনো
// connectionTimeoutMillis নেই — পুল নিঃশেষ হলে রিকোয়েস্ট *চিরকাল* অপেক্ষা করত
// (কোনো এরর নয়, শুধু ঝুলে থাকা)। এখন মানগুলো স্পষ্ট, env দিয়ে টিউনযোগ্য, এবং
// অপেক্ষার একটা সীমা আছে যাতে পুল-ক্ষুধা দ্রুত ব্যর্থতা হিসেবে ধরা পড়ে।
const POOL_MAX = Number(process.env.PGPOOL_MAX) > 0 ? Number(process.env.PGPOOL_MAX) : 20;
const POOL_IDLE_TIMEOUT_MS = Number(process.env.PGPOOL_IDLE_TIMEOUT_MS) > 0
  ? Number(process.env.PGPOOL_IDLE_TIMEOUT_MS) : 30000;
const POOL_CONNECTION_TIMEOUT_MS = Number(process.env.PGPOOL_CONNECTION_TIMEOUT_MS) > 0
  ? Number(process.env.PGPOOL_CONNECTION_TIMEOUT_MS) : 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveSslConfig(),
  max: POOL_MAX,
  idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS
});

// একটা idle ক্লায়েন্ট এরর দিলে (নেটওয়ার্ক ড্রপ, সার্ভার রিস্টার্ট) pg সেটাকে
// unhandled 'error' ইভেন্ট হিসেবে ছাড়ে — লিসেনার না থাকলে পুরো প্রসেস ক্র্যাশ করে।
pool.on('error', (err) => {
  console.error('⚠️ Postgres pool idle client error (পুল নিজেই রিকভার করবে):', err.message);
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
