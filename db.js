const process = require('node:process');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;

const poolConfig = {
  connectionString: databaseUrl,
};

if (databaseUrl && !databaseUrl.includes('localhost') && !databaseUrl.includes('127.0.0.1')) {
  poolConfig.ssl = {
    rejectUnauthorized: false
  };
}

let pool;
try {
  pool = new Pool(poolConfig);
} catch (err) {
  console.error('Critical: Failed to create database pool:', err.message);
}

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. Database features will be unavailable.');
    return;
  }

  if (!pool) {
    console.error('Database pool was not initialized.');
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
