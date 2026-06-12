const process = require('node:process');
const { Pool } = require('pg');

const isLocalhost = process.env.DATABASE_URL &&
  (process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalhost ? false : {
    rejectUnauthorized: false
  }
});

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. Database features will be unavailable.');
    return;
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      console.log('Database connected successfully');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Failed to connect to the database:', err.message);
    // Do not throw, allowing the app to start in a limited state
  }
}

module.exports = { pool, initDB };
