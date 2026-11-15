const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

process.env.NODE_ENV = 'test';
process.env.REDIS_ENABLED = process.env.REDIS_ENABLED || 'false';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test_secret_key_for_ci_only';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/bet420_test';
process.env.PORT = process.env.PORT || String(20000 + Math.floor(Math.random() * 20000));
process.env.VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:test@example.com';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4123';
process.env.SSLCZ_IS_LIVE = process.env.SSLCZ_IS_LIVE || 'false';

// টেস্ট-পরিবেশে কানেকশন লিক কমানো: প্রতিটা টেস্ট ফাইল (Jest sandbox) db.js ইমপোর্ট করে নিজস্ব
// pg Pool খোলে এবং ফাইল শেষে pool.end() হয় না। প্রোডাকশন ডিফল্ট (max ১০, idle ৩০s) টেস্টে
// প্রতি ফাইলে অকারণে বেশি কানেকশন ধরে রাখে। এখানে শুধু টেস্টে ছোট মান বসে; প্রোডাকশন কোড ও
// কনফিগ (db.js, render.yaml) অপরিবর্তিত। CI/লোকাল env-এ আগে থেকে সেট থাকলে সেটাই মানা হয়।
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '4';
process.env.DB_IDLE_TIMEOUT_MS = process.env.DB_IDLE_TIMEOUT_MS || '2000';
