#!/usr/bin/env node
// scripts/cleanupBankCardHolderName.js
// ---------------------------------------------------------------------------
// bank_cards.holder_name ক্লিনআপ।
//
// কেন: কার্ড-যোগ ফর্ম (views/profile/cards.ejs) "পাসওয়ার্ড" ইনপুটের মান holder_name কলামে
// সাধারণ টেক্সটে সংরক্ষণ করত। তাই ওই কলামের যেকোনো অ-ফাঁকা মান সংবেদনশীল ধরা হচ্ছে।
//
// ডিফল্ট = DRY-RUN: শুধু গোনে (SELECT COUNT), কিছুই বদলায় না।
//   node scripts/cleanupBankCardHolderName.js
//
// --apply দিলে (একটাই ট্রানজ্যাকশনে):
//   ১. আক্রান্ত row-গুলো আলাদা টেবিল bank_cards_holder_name_backup-এ রাখে,
//   ২. bank_cards.holder_name ফাঁকা (NULL) করে,
//   ৩. আক্রান্ত ইউজারদের users.must_reset_password = true বসায়
//      (middleware/auth.js পাসওয়ার্ড না বদলানো পর্যন্ত বাকি সব পাতা আটকে দেয়),
//   এবং commit-এর পর পুরনো সেশন বাতিল করে:
//      বিদ্যমান services/deviceTracking.revokeAllOtherSessions (device_sessions + user_sessions)
//      + Redis সেশন স্টোর থাকলে (বিদ্যমান হেল্পার যা ছোঁয় না) livo:sess:* থেকেও।
//   node scripts/cleanupBankCardHolderName.js --apply
//
// গোপনীয়তা: holder_name-এর কোনো মান, ইউজারের নাম/আইডি বা DB URL কোথাও ছাপা হয় না —
// শুধু সংখ্যা। ত্রুটিতে শুধু ত্রুটির কোড ছাপা হয়, বার্তা নয় (বার্তায় ডেটা থাকতে পারে)।
//
// exit 0 → সফল | exit 1 → ব্যর্থ (--apply ব্যর্থ হলে ট্রানজ্যাকশন rollback হয়)
// ---------------------------------------------------------------------------

const BACKUP_TABLE = 'bank_cards_holder_name_backup';
const AFFECTED_WHERE = `holder_name IS NOT NULL AND BTRIM(holder_name) <> ''`;
const REDIS_SESSION_PREFIX = 'livo:sess:'; // app.js-এর RedisStore prefix-এর সাথে মিল রাখতে হবে

function parseArgs(argv) {
  const known = new Set(['--apply', '--help', '-h']);
  const unknown = argv.filter((a) => !known.has(a));
  return {
    apply: argv.includes('--apply'),
    help: argv.includes('--help') || argv.includes('-h'),
    unknown,
  };
}

/** app.js-এর সেশন স্টোর বাছাইয়ের হুবহু শর্ত: Redis স্টোর ব্যবহৃত হচ্ছে কি না। */
function usesRedisSessions(env) {
  const redisEnabled = String(env.REDIS_ENABLED || 'true').toLowerCase() !== 'false';
  const useRedis = env.SESSION_STORE_TYPE === 'redis'
    || (redisEnabled && env.REDIS_URL && env.SESSION_STORE_TYPE !== 'postgres');
  return !!(useRedis && env.REDIS_URL);
}

async function countAffected(db) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS rows_count, COUNT(DISTINCT user_id)::int AS users_count
       FROM bank_cards WHERE ${AFFECTED_WHERE}`
  );
  return { rows: rows[0].rows_count, users: rows[0].users_count };
}

/** একটাই ট্রানজ্যাকশন: ব্যাকআপ → ফাঁকা করা → রিসেট ফ্ল্যাগ। ফেরত দেয় আক্রান্ত user_id তালিকা (ছাপা হয় না)। */
async function applyInTransaction(client) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
        id SERIAL PRIMARY KEY,
        bank_card_id INTEGER NOT NULL,
        user_id INTEGER,
        holder_name TEXT,
        backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    // লক নিয়ে একই row-সেটের ওপর ব্যাকআপ ও আপডেট, যাতে মাঝখানে নতুন মান ঢুকে ব্যাকআপ ছাড়া মুছে না যায়।
    await client.query(`SELECT id FROM bank_cards WHERE ${AFFECTED_WHERE} FOR UPDATE`);
    await client.query(`
      INSERT INTO ${BACKUP_TABLE} (bank_card_id, user_id, holder_name)
      SELECT id, user_id, holder_name FROM bank_cards WHERE ${AFFECTED_WHERE}`);
    const userRes = await client.query(
      `SELECT DISTINCT user_id FROM bank_cards WHERE ${AFFECTED_WHERE} AND user_id IS NOT NULL`
    );
    const userIds = userRes.rows.map((r) => r.user_id);
    const upd = await client.query(`UPDATE bank_cards SET holder_name = NULL WHERE ${AFFECTED_WHERE}`);
    if (userIds.length) {
      await client.query(`UPDATE users SET must_reset_password = true WHERE id = ANY($1::int[])`, [userIds]);
    }
    await client.query('COMMIT');
    return { userIds, clearedRows: upd.rowCount };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* উপেক্ষা */ }
    throw err;
  }
}

/** Redis সেশন স্টোরে থাকা সংশ্লিষ্ট ইউজারদের সেশন মুছে ফেলে; কতগুলো মুছল তার সংখ্যা ফেরত দেয়। */
async function revokeRedisSessions(redis, userIds) {
  const wanted = new Set(userIds.map(String));
  let deleted = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${REDIS_SESSION_PREFIX}*`, 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      let uid;
      try {
        const raw = await redis.get(key);
        uid = raw ? JSON.parse(raw)?.user?.id : undefined;
      } catch (_) { continue; } // ভাঙা/অন্য ধরনের কী — ছোঁয়া হয় না
      if (uid !== undefined && wanted.has(String(uid))) {
        deleted += await redis.del(key);
      }
    }
  } while (cursor !== '0');
  return deleted;
}

async function run({ argv, env, out, deps }) {
  const args = parseArgs(argv);
  if (args.help) {
    out('ব্যবহার: node scripts/cleanupBankCardHolderName.js [--apply]\n  (কোনো ফ্ল্যাগ না দিলে DRY-RUN: শুধু গোনে, কিছু বদলায় না)');
    return 0;
  }
  if (args.unknown.length) {
    out(`অজানা অপশন (${args.unknown.length}টি) — শুধু --apply বা --help চলবে।`);
    return 1;
  }
  if (!env.DATABASE_URL) {
    out('DATABASE_URL সেট নেই — থামানো হলো।');
    return 1;
  }

  const pool = deps.pool;
  try {
    const before = await countAffected(pool);
    out(`[${args.apply ? 'APPLY' : 'DRY-RUN'}] আক্রান্ত row: ${before.rows}, আক্রান্ত ইউজার: ${before.users}`);

    if (!args.apply) {
      out('DRY-RUN: কিছুই বদলানো হয়নি। সত্যিই চালাতে --apply দিন।');
      return 0;
    }
    if (before.rows === 0) {
      out('করার মতো কিছু নেই।');
      return 0;
    }

    const client = await pool.connect();
    let result;
    try {
      result = await applyInTransaction(client);
    } finally {
      client.release();
    }
    out(`ব্যাকআপ (${BACKUP_TABLE}) ও ফাঁকা করা সম্পন্ন: ${result.clearedRows}টি row, ${result.userIds.length}জন ইউজারের রিসেট ফ্ল্যাগ বসানো হয়েছে।`);

    // ---- সেশন বাতিল (commit-এর পর; ব্যর্থ হলেও রিসেট ফ্ল্যাগ isAuth-এ বাকি সেশন আটকে রাখে) ----
    let pgRevoked = 0;
    let sessionErrors = 0;
    const redisSids = [];
    for (const uid of result.userIds) {
      try {
        const sidRes = await pool.query(`SELECT sid FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL`, [uid]);
        redisSids.push(...sidRes.rows.map((r) => r.sid));
        pgRevoked += await deps.revokeAllOtherSessions(uid, '', 'SECURITY_CLEANUP');
      } catch (_) { sessionErrors += 1; }
      try { await deps.invalidateAuthCache(uid); } catch (_) { /* ক্যাশের TTL মাত্র ৩০ সেকেন্ড */ }
    }
    let redisDeleted = 0;
    if (usesRedisSessions(env)) {
      let redis;
      try {
        redis = deps.createRedis(env.REDIS_URL);
        redisDeleted = await revokeRedisSessions(redis, result.userIds);
      } catch (_) {
        sessionErrors += 1;
      } finally {
        if (redis) { try { redis.disconnect(); } catch (_) { /* উপেক্ষা */ } }
      }
    }
    out(`সেশন বাতিল: ডাটাবেস/ডিভাইস ${pgRevoked}টি, Redis ${redisDeleted}টি; ব্যর্থ ধাপ: ${sessionErrors}।`);
    if (sessionErrors) out('⚠️ কিছু সেশন-বাতিল ধাপ ব্যর্থ — তবু রিসেট ফ্ল্যাগ থাকায় ওই ইউজাররা পাসওয়ার্ড না বদলে কিছু করতে পারবেন না।');
    return 0;
  } catch (err) {
    out(`ব্যর্থ (কোড: ${err && err.code ? err.code : 'unknown'}) — --apply হলে ট্রানজ্যাকশন rollback হয়েছে।`);
    return 1;
  }
}

module.exports = { run, parseArgs, usesRedisSessions, countAffected, applyInTransaction, revokeRedisSessions, BACKUP_TABLE, AFFECTED_WHERE };

if (require.main === module) {
  require('dotenv').config();
  const process = require('node:process');
  const { pool } = require('../db');
  const { revokeAllOtherSessions } = require('../services/deviceTracking');
  const cache = require('../services/cache');
  const deps = {
    pool,
    revokeAllOtherSessions,
    invalidateAuthCache: (uid) => cache.del(`auth:active:${uid}`),
    createRedis: (url) => new (require('ioredis'))(url, { maxRetriesPerRequest: 1 }),
  };
  run({ argv: process.argv.slice(2), env: process.env, out: (m) => console.log(m), deps })
    .then((code) => { process.exit(code); })
    .catch(() => { console.log('ব্যর্থ (অপ্রত্যাশিত ত্রুটি)।'); process.exit(1); });
}
