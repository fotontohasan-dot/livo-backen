const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || '',
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1'))
    ? false
    : { rejectUnauthorized: false }
});

const connectDB = async () => {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL is not defined. Database operations will be disabled.');
    return;
  }
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected successfully');
  } catch (error) {
    console.error('❌ PostgreSQL connection error:', error.message);
    console.log('⚠️ Continuing without a persistent database connection...');
  }
};

module.exports = { pool, connectDB };
