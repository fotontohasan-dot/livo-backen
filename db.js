const { Pool } = require('pg');

// প্রোডাকশনে (Render ইত্যাদি ম্যানেজড Postgres) SSL আবশ্যক, তাই ডিফল্ট true —
// এই আচরণ অপরিবর্তিত থাকছে যাতে বিদ্যমান ডিপ্লয়মেন্ট ভেঙে না যায়।
// শুধু লোকাল/Docker Compose-এর মতো non-SSL Postgres-এর ক্ষেত্রে DB_SSL=false সেট করতে হবে।
const DB_SSL = String(process.env.DB_SSL || 'true').toLowerCase() !== 'false';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: DB_SSL ? { rejectUnauthorized: false } : false
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
