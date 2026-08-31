const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/livo_test';

module.exports = async function globalSetup() {
  const runMigrations = require('../migrations');
  await runMigrations();

  // ফিচার ফ্ল্যাগ টেবিলটা পুরো টেস্ট DB-তে শেয়ার্ড এবং রান-এর মধ্যে টিকে থাকে।
  // enforcement টেস্টগুলো ইচ্ছাকৃতভাবে ফ্ল্যাগ বন্ধ করে (তারপর পুনরুদ্ধার করে),
  // কিন্তু কোনো রান মাঝপথে থেমে গেলে (timeout/kill/OOM) ফ্ল্যাগ বন্ধ অবস্থায়
  // রয়ে যায় — পরের রানে তখন সম্পূর্ণ অসম্পর্কিত suite ফেল করে: /matches,
  // /games, /coins ইত্যাদি 403 দেয় আর "dead link"/"404 প্রত্যাশিত" টেস্ট ভাঙে।
  //
  // প্রতিটা রান তাই একটা পরিচিত অবস্থা থেকে শুরু করে। এটা কোনো বাগ ঢাকছে না —
  // ফ্ল্যাগ প্রয়োগের আসল যাচাই featureFlagEnforcement টেস্টেই হয়, যেটা নিজেই
  // ফ্ল্যাগ বন্ধ করে দেখে।
  const { pool } = require('../db');
  await pool.query('UPDATE feature_flags SET enabled = true');
  console.log('[globalSetup] migrations applied, feature flags reset to enabled');
};
