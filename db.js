const { Pool } = require('pg');

// প্রোডাকশনে (Render ইত্যাদি ম্যানেজড Postgres) SSL আবশ্যক, তাই ডিফল্ট true —
// এই আচরণ অপরিবর্তিত থাকছে যাতে বিদ্যমান ডিপ্লয়মেন্ট ভেঙে না যায়।
// শুধু লোকাল/Docker Compose-এর মতো non-SSL Postgres-এর ক্ষেত্রে DB_SSL=false সেট করতে হবে।
const DB_SSL = String(process.env.DB_SSL || 'true').toLowerCase() !== 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: DB_SSL ? { rejectUnauthorized: false } : false
});

// pg Pool-এর idle ক্লায়েন্টে ব্যাকগ্রাউন্ডে এরর হলে (যেমন নেটওয়ার্ক ড্রপ) এটা না ধরলে
// পুরো প্রসেস ক্র্যাশ করতে পারে — এখানে শুধু লগ + Sentry রিপোর্ট করে প্রসেস বাঁচানো হচ্ছে
pool.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL pool error:', err.message);
  try {
    require('./services/sentry').captureException(err, { source: 'pg_pool_idle_error' });
  } catch (e) { /* সাইলেন্ট — Sentry ব্যর্থ হলেও DB pool চালু থাকবে */ }
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

module.exports = { pool, connectDB };
