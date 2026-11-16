#!/usr/bin/env node
// scripts/cleanupBankCardHolderName.js
// ---------------------------------------------------------------------------
// bank_cards.holder_name ক্লিনআপ।
//
// কেন: কার্ড-যোগ ফর্ম (views/profile/cards.ejs) "পাসওয়ার্ড" ইনপুটের মান holder_name কলামে
// সাধারণ টেক্সটে সংরক্ষণ করত।
//
// "আক্রান্ত row" = holder_name অ-ফাঁকা এবং নিচের *যেকোনো একটি* সত্য:
//   ক) utils/holderName.js-এর validateHolderName সেটা প্রত্যাখ্যান করে (অঙ্ক, চিহ্ন, দৈর্ঘ্য ২–৬০-এর বাইরে ইত্যাদি) —
//      ক্লিনআপ ও লেখার-পথের ভ্যালিডেটর হুবহু একই ফাংশন, তাই নিয়ম কখনো আলাদা হতে পারে না;
//   খ) মান বৈধ নামের মতো দেখালেও সেই row-এর ইউজারের নিজের লগইন পাসওয়ার্ডের সঙ্গে bcrypt-এ মেলে।
// বৈধ নাম (বাংলা স্বরচিহ্ন/হসন্ত/ZWJ/ZWNJ সহ) যেটা ইউজারের পাসওয়ার্ড নয়, সেটা কখনো ছোঁয়া হয় না।
// সীমা: অন্য কোনো (নিজের নয়) শুধু-অক্ষরের পাসওয়ার্ড নাম থেকে আলাদা করা অসম্ভব — সেটা ধরা পড়ে না।
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
// ব্যাকআপ টেবিল আগে থেকে থাকলে --apply থেমে যায় (exit 1, কিছু বদলায় না)।
// exit 0 → সফল | exit 1 → ব্যর্থ/থামানো (--apply ব্যর্থ হলে ট্রানজ্যাকশন rollback হয়)
// ---------------------------------------------------------------------------

const BACKUP_TABLE = 'bank_cards_holder_name_backup';
// শুধু প্রাথমিক ছাঁকনি (অ-ফাঁকা)। আসল "আক্রান্ত" সিদ্ধান্ত scanAffected()-এ — validateHolderName + নিজের-পাসওয়ার্ড মিল।
const NON_BLANK_WHERE = `holder_name IS NOT NULL AND BTRIM(holder_name) <> ''`;
const { validateHolderName } = require('../utils/holderName');
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

/** ব্যাকআপ টেবিল আগে থেকে আছে কি না (শুধু-পড়া)। */
async function backupTableExists(db) {
  const { rows } = await db.query(`SELECT to_regclass($1) AS t`, [`public.${BACKUP_TABLE}`]);
  return !!(rows && rows[0] && rows[0].t);
}

const ALLOWED_CHAR_RE = /[\p{L}\p{M}\u200c\u200d .'’-]/u;
/** শ্রেণি (শুধু গণনার জন্য; মান কখনো ফেরত/ছাপা হয় না)। বৈধ হলে 'valid'। সিদ্ধান্ত = validateHolderName, শ্রেণি শুধু বিবরণ। */
function classifyHolderName(value) {
  if (validateHolderName(value).valid) return 'valid';
  const v = String(value);
  const hasLetter = /\p{L}/u.test(v);
  const hasDigit = /\p{N}/u.test(v);
  const hasSymbol = [...v].some((ch) => !ALLOWED_CHAR_RE.test(ch) && !/\p{N}/u.test(ch));
  if (hasLetter && (hasDigit || hasSymbol)) return 'password_like'; // অক্ষর + অঙ্ক/চিহ্ন মেশানো
  if (hasDigit) return 'digits_only';
  if (hasSymbol) return 'symbols_only';
  return 'length_or_format';
}

async function ownPasswordMatches(userHash, value, compare) {
  if (!userHash) return false;
  const v = String(value);
  const cands = [...new Set([v, validateHolderName(v).value].filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 72))];
  for (const c of cands) { if (await compare(c, userHash)) return true; }
  return false;
}

/**
 * আক্রান্ত row চিহ্নিত করে। lock=true হলে (ট্রানজ্যাকশনের ভেতরে) সংশ্লিষ্ট row-গুলো FOR UPDATE করে — যাতে যা গোনা হলো
 * ঠিক তা-ই ব্যাকআপ/ফাঁকা হয়। কোনো মান ফেরত দেয় না — শুধু আইডি ও গণনা।
 */
async function scanAffected(db, { lock = false, compare } = {}) {
  const cmp = compare || ((plain, hash) => require('bcryptjs').compare(plain, hash));
  const { rows } = await db.query(
    `SELECT id, user_id, holder_name FROM bank_cards WHERE ${NON_BLANK_WHERE} ORDER BY id${lock ? ' FOR UPDATE' : ''}`
  );
  const byClass = { password_like: 0, digits_only: 0, symbols_only: 0, length_or_format: 0, own_password: 0 };
  let valid = 0;
  const ids = []; const users = new Set();
  const validRows = [];
  for (const r of rows) {
    const cls = classifyHolderName(r.holder_name);
    if (cls === 'valid') { valid += 1; validRows.push(r); continue; }
    byClass[cls] += 1; ids.push(r.id); if (r.user_id != null) users.add(r.user_id);
  }
  // বৈধ-দেখতে মান যেটা ইউজারের নিজের পাসওয়ার্ড — তাও আক্রান্ত
  const owners = [...new Set(validRows.map((r) => r.user_id).filter((x) => x != null))];
  if (owners.length) {
    const pw = await db.query(`SELECT id, password FROM users WHERE id = ANY($1::int[])`, [owners]);
    const hashOf = new Map(pw.rows.map((x) => [x.id, x.password]));
    for (const r of validRows) {
      if (r.user_id == null) continue;
      if (await ownPasswordMatches(hashOf.get(r.user_id), r.holder_name, cmp)) {
        byClass.own_password += 1; valid -= 1; ids.push(r.id); users.add(r.user_id);
      }
    }
  }
  return { ids, userIds: [...users], rows: ids.length, users: users.size, valid, byClass };
}

async function countAffected(db, opts) {
  const { rows, users, valid, byClass } = await scanAffected(db, opts);
  return { rows, users, valid, byClass };
}

/** একটাই ট্রানজ্যাকশন: ব্যাকআপ → ফাঁকা করা → রিসেট ফ্ল্যাগ। ফেরত দেয় আক্রান্ত user_id তালিকা (ছাপা হয় না)। */
async function applyInTransaction(client, opts = {}) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT false`);
    // আগে থেকে থাকলে ইচ্ছাকৃতভাবে ব্যর্থ (42P07) → ROLLBACK; কখনো ওভাররাইট/ড্রপ/মার্জ নয় (আগের ব্যাকআপ হারাবে না)।
    await client.query(`
      CREATE TABLE ${BACKUP_TABLE} (
        id SERIAL PRIMARY KEY,
        bank_card_id INTEGER NOT NULL,
        user_id INTEGER,
        holder_name TEXT,
        backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    // লক নিয়ে একই row-সেটের ওপর শ্রেণিবিন্যাস, ব্যাকআপ ও আপডেট (মাঝখানে বদলালে ভুল row ছোঁয়া হয় না)
    const scan = await scanAffected(client, { lock: true, compare: opts.compare });
    const ids = scan.ids;
    const userIds = scan.userIds;
    let clearedRows = 0;
    if (ids.length) {
      await client.query(`
        INSERT INTO ${BACKUP_TABLE} (bank_card_id, user_id, holder_name)
        SELECT id, user_id, holder_name FROM bank_cards WHERE id = ANY($1::int[])`, [ids]);
      const upd = await client.query(`UPDATE bank_cards SET holder_name = NULL WHERE id = ANY($1::int[])`, [ids]);
      clearedRows = upd.rowCount;
    }
    if (userIds.length) {
      await client.query(`UPDATE users SET must_reset_password = true WHERE id = ANY($1::int[])`, [userIds]);
    }
    await client.query('COMMIT');
    return { userIds, clearedRows };
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
    const c = before.byClass;
    out(`শ্রেণি — পাসওয়ার্ড-সদৃশ (অক্ষর+অঙ্ক/চিহ্ন): ${c.password_like}, শুধু অঙ্ক: ${c.digits_only}, শুধু চিহ্ন: ${c.symbols_only}, দৈর্ঘ্য/ফরম্যাট: ${c.length_or_format}, নিজের-পাসওয়ার্ড-মিল: ${c.own_password}; বৈধ নাম (অক্ষত থাকবে): ${before.valid}`);

    if (!args.apply) {
      out('DRY-RUN: কিছুই বদলানো হয়নি। সত্যিই চালাতে --apply দিন।');
      return 0;
    }
    // ব্যাকআপ টেবিল আগে থাকলে থামি — কিছু বদলাই না, সেশনও বাতিল করি না।
    if (await backupTableExists(pool)) {
      out(`থামানো হলো: ব্যাকআপ টেবিল ${BACKUP_TABLE} আগে থেকেই আছে। কিছু বদলানো হয়নি (ওভাররাইট/ড্রপ করা হয়নি)। আগে docs/BANK_CARD_HOLDER_NAME_CLEANUP.md অনুযায়ী পুরনো ব্যাকআপ যাচাই করে মালিকের সিদ্ধান্তে সরান।`);
      return 1;
    }
    if (before.rows === 0) {
      out('করার মতো কিছু নেই।');
      return 0;
    }

    const client = await pool.connect();
    let result;
    try {
      result = await applyInTransaction(client, { compare: deps.compare });
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
    if (err && err.code === '42P07') {
      out(`থামানো হলো: ব্যাকআপ টেবিল ${BACKUP_TABLE} আগে থেকেই আছে। ট্রানজ্যাকশন rollback হয়েছে, কিছু বদলানো হয়নি।`);
      return 1;
    }
    out(`ব্যর্থ (কোড: ${err && err.code ? err.code : 'unknown'}) — --apply হলে ট্রানজ্যাকশন rollback হয়েছে।`);
    return 1;
  }
}

module.exports = { run, parseArgs, usesRedisSessions, backupTableExists, countAffected, scanAffected, classifyHolderName, applyInTransaction, revokeRedisSessions, BACKUP_TABLE, NON_BLANK_WHERE };

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
