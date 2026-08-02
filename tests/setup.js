const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

process.env.NODE_ENV = 'test';
process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test_secret_key_for_ci_only';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/livo_test';
process.env.PORT = process.env.PORT || String(20000 + Math.floor(Math.random() * 20000));
process.env.VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:test@example.com';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4123';
process.env.SSLCZ_IS_LIVE = process.env.SSLCZ_IS_LIVE || 'false';
