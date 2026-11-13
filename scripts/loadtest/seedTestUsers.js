#!/usr/bin/env node
// scripts/loadtest/seedTestUsers.js — staging DB-তে টেস্ট ইউজার তৈরি/মোছা। শুধু STAGING (lib/guard.js checkDbTarget)।
//
//   LOADTEST_DB_URL=postgres://… LOADTEST_PASSWORD=… node scripts/loadtest/seedTestUsers.js [--count 500] [--cleanup]
//
// • ইউজারনেম `loadtest_0001…` ; coins = 0 (আসল কয়েন নেই), demo_balance বড় — বেট শুধু demo:true-তে (http.js)।
// • পাসওয়ার্ড রিপোতে নেই: LOADTEST_PASSWORD env থেকে আসে, bcrypt হ্যাশ হয়ে DB-তে যায়। লগে ছাপা হয় না।
// • ফোন নম্বর কাল্পনিক (019 + ৮ অঙ্ক, `0190…` রেঞ্জ) — আসল কারো নম্বর নয়; কোনো SMS/ইমেইল পাঠানো হয় না।
// • --cleanup: prefix-মিলে যাওয়া ইউজার ও তাদের ডেমো বেট/লেনদেন মোছে (production-এ চালানো যাবে না — একই guard)।
const { assertStagingDb } = require('./lib/guard');
const { num } = require('./lib/env');

async function main() {
  const db = assertStagingDb();
  const { Pool } = require('pg');
  const bcrypt = require('bcryptjs');
  const prefix = process.env.USER_PREFIX || 'loadtest_';
  const cleanup = process.argv.includes('--cleanup');
  const ssl = /\.render\.com|sslmode=require/i.test(db.url) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: db.url, max: 2, ssl });
  try {
    if (cleanup) {
      const ids = (await pool.query('SELECT id FROM users WHERE username LIKE $1', [prefix + '%'])).rows.map((r) => r.id);
      for (const t of ['bets', 'demo_transactions', 'coin_transactions', 'notifications']) {
        await pool.query(`DELETE FROM ${t} WHERE user_id = ANY($1::int[])`, [ids]).catch((e) => console.warn(`  ${t}: ${e.message}`));
      }
      const r = await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
      console.log(`🧹 ${r.rowCount} টেস্ট ইউজার মোছা হয়েছে (${db.host}/${db.dbName})`);
      return;
    }
    const pw = process.env.LOADTEST_PASSWORD;
    if (!pw || pw.length < 12) { console.error('❌ LOADTEST_PASSWORD (≥১২ অক্ষর) দরকার।'); process.exit(2); }
    const countArg = process.argv.indexOf('--count');
    const count = countArg > -1 ? Number(process.argv[countArg + 1]) : num('USER_COUNT', 500);
    const hash = await bcrypt.hash(pw, 12); // অ্যাপের BCRYPT_COST-এর সমান
    let made = 0;
    for (let i = 1; i <= count; i++) {
      const username = `${prefix}${String(i).padStart(4, '0')}`;
      const phone = '0190' + String(1000000 + i).slice(-7);
      const r = await pool.query(
        `INSERT INTO users (username, phone, password, coins, demo_balance, email_verified)
         VALUES ($1,$2,$3,0,1000000,true) ON CONFLICT DO NOTHING`, [username, phone, hash]);
      made += r.rowCount;
    }
    console.log(`✅ ${made}/${count} টেস্ট ইউজার তৈরি (${db.host}/${db.dbName}); বাকিগুলো আগে থেকেই ছিল`);
  } finally { await pool.end(); }
}
main().catch((e) => { console.error('seed error:', e.message); process.exit(1); });
