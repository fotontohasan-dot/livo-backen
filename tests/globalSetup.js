const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/livo_test';

module.exports = async function globalSetup() {
  const runMigrations = require('../migrations');
  await runMigrations();
  console.log('[globalSetup] migrations applied once before test suite');
};
