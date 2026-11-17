#!/usr/bin/env node
// scripts/stagingCleanupProof.js
// ---------------------------------------------------------------------------
// শুধু STAGING: cleanupBankCardHolderName.js --apply-এর প্রমাণের জন্য নকল ডেটা বসায়/পরিষ্কার করে।
//   node scripts/stagingCleanupProof.js seed      → ১টি নকল ইউজার + ২টি কার্ড (১টি holder_name = পাসওয়ার্ড-সদৃশ, ১টি বৈধ নাম)
//   node scripts/stagingCleanupProof.js status    → নকল ইউজারের অবস্থা (শুধু সংখ্যা/ফ্ল্যাগ)
//   node scripts/stagingCleanupProof.js cleanup   → নকল ডেটা ও ব্যাকআপ টেবিলের নকল row মোছে
// গার্ড: APP_ENV (বা NODE_ENV) 'staging' না হলে কিছু করার আগেই থামে (exit 2) — DB-ই খোলে না।
// গোপনীয়তা: পাসওয়ার্ড/holder_name/DATABASE_URL কিছুই ছাপা হয় না। ওয়ালেট/সেটেলমেন্ট টেবিল ছোঁয়া হয় না (coins = 0)।
// ---------------------------------------------------------------------------
const { isStaging } = require('../utils/stagingGuard');

const PROOF_USERNAME = 'cleanup_proof_user';
const PROOF_BANK = 'PROOF-BANK';
const BACKUP_TABLE = 'bank_cards_holder_name_backup';

function guard(env = process.env) {
  if (!isStaging(env)) {
    console.error('থেমে গেছে: APP_ENV=staging নয়। এই স্ক্রিপ্ট শুধু staging-এ চলে।');
    return false;
  }
  return true;
}

async function main(cmd) {
  const { pool } = require('../db');
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');
  try {
    if (cmd === 'seed') {
      const exists = await pool.query('SELECT id FROM users WHERE username = $1', [PROOF_USERNAME]);
      if (exists.rowCount) { console.error('নকল ইউজার আগে থেকেই আছে — আগে cleanup চালান।'); return 1; }
      // পাসওয়ার্ড-সদৃশ মান (অক্ষর + অঙ্ক + চিহ্ন); এটাই ইউজারের পাসওয়ার্ড ও holder_name — কখনো ছাপা হয় না।
      const secret = 'Pw' + crypto.randomBytes(6).toString('hex') + '!';
      const hash = await bcrypt.hash(secret, 10);
      const u = await pool.query(
        `INSERT INTO users (username, password, full_name, role, coins) VALUES ($1, $2, 'Cleanup Proof', 'user', 0) RETURNING id`,
        [PROOF_USERNAME, hash]
      );
      const uid = u.rows[0].id;
      await pool.query(
        `INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name) VALUES ($1, $2, '0000000000', $3), ($1, $2, '0000000001', 'Proof Valid Name')`,
        [uid, PROOF_BANK, secret]
      );
      console.log('seed সম্পন্ন: নকল ইউজার ১, কার্ড ২ (১টি পাসওয়ার্ড-সদৃশ, ১টি বৈধ নাম)');
      return 0;
    }
    if (cmd === 'status') {
      const u = await pool.query('SELECT id, must_reset_password FROM users WHERE username = $1', [PROOF_USERNAME]);
      if (!u.rowCount) { console.log('নকল ইউজার নেই'); return 0; }
      const uid = u.rows[0].id;
      const c = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE holder_name IS NULL OR BTRIM(holder_name) = '')::int AS blank,
                COUNT(*) FILTER (WHERE holder_name IS NOT NULL AND BTRIM(holder_name) <> '')::int AS filled
           FROM bank_cards WHERE user_id = $1`, [uid]);
      console.log(`নকল ইউজার: must_reset_password=${u.rows[0].must_reset_password}, কার্ড ফাঁকা holder_name=${c.rows[0].blank}, অ-ফাঁকা=${c.rows[0].filled}`);
      return 0;
    }
    if (cmd === 'cleanup') {
      const u = await pool.query('SELECT id FROM users WHERE username = $1', [PROOF_USERNAME]);
      const uid = u.rowCount ? u.rows[0].id : null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (uid != null) {
          const t = await client.query('SELECT to_regclass($1) AS t', [`public.${BACKUP_TABLE}`]);
          if (t.rows[0].t) await client.query(`DELETE FROM ${BACKUP_TABLE} WHERE user_id = $1`, [uid]);
          await client.query('DELETE FROM bank_cards WHERE user_id = $1 AND bank_name = $2', [uid, PROOF_BANK]);
          await client.query('DELETE FROM users WHERE id = $1', [uid]);
        }
        const t2 = await client.query('SELECT to_regclass($1) AS t', [`public.${BACKUP_TABLE}`]);
        let backupLeft = 'টেবিল নেই';
        if (t2.rows[0].t) {
          const n = (await client.query(`SELECT COUNT(*)::int AS n FROM ${BACKUP_TABLE}`)).rows[0].n;
          if (n === 0) { await client.query(`DROP TABLE ${BACKUP_TABLE}`); backupLeft = 'খালি ছিল, টেবিল মোছা হয়েছে'; }
          else backupLeft = `${n} row আছে (নকল নয়) — মোছা হয়নি, মালিক সিদ্ধান্ত নেবেন`;
        }
        await client.query('COMMIT');
        console.log(`cleanup সম্পন্ন: নকল ডেটা মোছা হয়েছে; ব্যাকআপ টেবিল: ${backupLeft}`);
        return 0;
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('cleanup ব্যর্থ, rollback। কোড:', e && e.code); return 1; }
      finally { client.release(); }
    }
    console.error('ব্যবহার: node scripts/stagingCleanupProof.js seed|status|cleanup');
    return 2;
  } catch (e) {
    console.error('ব্যর্থ। কোড:', e && e.code);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  if (!guard()) process.exit(2);
  main(process.argv[2]).then((c) => process.exit(c));
}
module.exports = { guard, PROOF_USERNAME, PROOF_BANK };
