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
// TLS সার্টিফিকেট যাচাই।
//
// আগে সব ক্ষেত্রেই `{ rejectUnauthorized: false }` ছিল — অর্থাৎ কানেকশন
// এনক্রিপ্টেড হতো, কিন্তু সার্ভার আসলেই আমাদের ডাটাবেস কি না তা কখনো যাচাই
// হতো না। ফলে MITM বা rogue এন্ডপয়েন্ট পুরো ট্রাফিক (ক্রেডেনশিয়াল সহ) পড়তে
// পারত এবং TLS থাকা সত্ত্বেও কেউ টের পেত না।
//
// এখন প্রোডাকশনে যাচাই চালু। কিছু ম্যানেজড হোস্ট (যেমন Render-এর ইন্টারনাল
// PostgreSQL) self-signed সার্টিফিকেট দেয় — সেক্ষেত্রে DATABASE_CA_CERT-এ CA
// সার্টিফিকেট দিলে যাচাই ওই CA-র বিপরীতে হবে।
//
// একান্তই দরকার হলে DATABASE_SSL_INSECURE=true দিয়ে যাচাই বন্ধ করা যায়,
// কিন্তু তখন স্টার্টআপে স্পষ্ট সতর্কবার্তা লগ হয় — নিঃশব্দে অনিরাপদ থাকে না।
function resolveSslConfig() {
  const explicit = (process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (explicit === 'false' || explicit === '0' || explicit === 'off') return false;

  if (process.env.NODE_ENV === 'test') return false;

  const isProduction = process.env.NODE_ENV === 'production';
  const ca = (process.env.DATABASE_CA_CERT || '').trim();
  const insecure = (process.env.DATABASE_SSL_INSECURE || '').trim().toLowerCase();
  const allowInsecure = insecure === 'true' || insecure === '1' || insecure === 'on';

  if (isProduction && allowInsecure) {
    console.warn('⚠️ DATABASE_SSL_INSECURE চালু — ডাটাবেস TLS সার্টিফিকেট যাচাই করা হচ্ছে না (MITM ঝুঁকি)।');
    return { rejectUnauthorized: false };
  }

  if (ca) return { rejectUnauthorized: true, ca };
  if (isProduction) return { rejectUnauthorized: true };

  // ডেভেলপমেন্ট: লোকাল/স্টেজিং সার্টিফিকেট প্রায়ই self-signed, তাই যাচাই শিথিল।
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
