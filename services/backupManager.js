// services/backupManager.js
// ---------------------------------------------------------------------------
// Backup & Restore System — Database / Uploaded Files / Configuration
// প্রতিটা ব্যাকআপ: gzip কম্প্রেশন + (কী দেওয়া থাকলে) AES-256-GCM এনক্রিপশন +
// SHA-256 checksum, লোকাল ডিস্কে সংরক্ষিত (BACKUP_DIR), মেটাডেটা DB-তে (backup_history)।
// এটা services/backup.js (পুরনো, GitHub-এ ডেইলি DB ব্যাকআপ) থেকে সম্পূর্ণ আলাদা ও
// স্বতন্ত্র — পুরনো সিস্টেম অপরিবর্তিত থাকছে, ব্যাকওয়ার্ড কম্প্যাটিবিলিটির জন্য।
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pool } = require('../db');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const ENC_KEY_RAW = process.env.BACKUP_ENCRYPTION_KEY || '';
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

// SKIP_TABLES: সেশন/ভারী-লগ টাইপ টেবিল বাদ (services/backup.js এর সাথে সামঞ্জস্যপূর্ণ)
const SKIP_TABLES = ['session'];
// ক্রম গুরুত্বপূর্ণ — প্রতিটা টেবিল তার নির্ভরশীল (FK) টেবিলের পরে আসতে হবে, নাহলে INSERT
// foreign-key violation-এ নিচের catch-এ সাইলেন্টলি স্কিপ হয়ে যায় এবং রিস্টোর "সফল" দেখায়।
//   • 'roles' users-এর আগে যোগ করা হয়েছে: users.role_key → roles(key) FK। roles রিস্টোর না
//     হওয়ায় role_key সেট করা প্রতিটা স্টাফ/অ্যাডমিন অ্যাকাউন্ট রিস্টোরে হারিয়ে যেত।
//   • 'coin_transactions' একেবারেই তালিকায় ছিল না — ব্যাকআপে ডেটা থাকা সত্ত্বেও রিস্টোরের পর
//     পুরো ওয়ালেট লেজার খালি থাকত, অথচ users.coins রিস্টোর হতো (ব্যালেন্স ও লেজার অসামঞ্জস্য)।
const RESTORE_ORDER = [
  'roles',
  'users', 'coin_transactions', 'matches', 'markets', 'bets', 'payment_requests', 'notifications',
  'chat_messages', 'news', 'kyc_requests', 'error_logs', 'login_logs', 'bonuses',
  'daily_reward_tiers', 'user_daily_rewards', 'referrals', 'referral_commissions',
  'daily_losses', 'vip_levels', 'mission_defs', 'user_missions', 'mission_claims',
  'wheel_spins', 'loyalty_ledger', 'user_badges', 'free_bets', 'periodic_claims',
  'daily_rewards', 'social_shares', 'bank_cards', 'site_settings', 'bot_activity_logs',
  'ip_rules', 'backup_history'
];

// RESTORE_ORDER-এর প্রায় সব টেবিলের প্রাইমারি কী 'id', কিন্তু site_settings-এর কী 'key'
// (migrations.js দেখুন: CREATE TABLE site_settings (key TEXT PRIMARY KEY, ...)) — আগে সব
// টেবিলের জন্য হার্ডকোড করা `ON CONFLICT (id)` ব্যবহার হতো, ফলে site_settings রিস্টোরের
// প্রতিটা row-ই "column id does not exist" এরর দিয়ে সবসময় সাইলেন্টলি স্কিপ হয়ে যেত
// (নিচের catch-এ) — site_settings ব্যাকআপ থেকে কখনো রিস্টোর হতোই না।
// roles-এর PK 'id' হলেও migrations সিস্টেম রোলগুলো নিজেই সিড করে, তাই ফ্রেশ DB-তে id নয়,
// 'key' দিয়েই ডুপ্লিকেট চেনা দরকার (নাহলে একই key দুইবার ঢোকানোর চেষ্টা UNIQUE-এ ভেঙে যেত)।
const TABLE_CONFLICT_KEY = { site_settings: 'key', roles: 'key' };

// users.referred_by_id → users(id) — নিজের টেবিলকেই রেফার করে। ডাম্পের সারিগুলো id-ক্রমে
// ইনসার্ট হয়, তাই কেউ যদি তার চেয়ে পরে ইনসার্ট হওয়া ইউজারকে রেফার করে থাকে, সেই সারিটা
// FK violation-এ স্কিপ হয়ে যেত (নীরব ডেটা লস)। তাই এই কলামগুলো প্রথম পাসে NULL রেখে
// ইনসার্ট করা হয়, সব সারি ঢোকার পর দ্বিতীয় পাসে আসল মান বসানো হয়।
const SELF_REFERENCING_COLUMNS = { users: ['referred_by_id'] };

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// ব্যাকআপ ফাইলের নাম — শুধু Date.now() ব্যবহার করলে একই মিলিসেকেন্ডে তৈরি হওয়া দুইটা ব্যাকআপ
// হুবহু একই ফাইলনেম পেত: দ্বিতীয়টা প্রথমটার ফাইল ওভাররাইট করত, এবং যেকোনো একটা ডিলিট করলে
// অন্যটার রেকর্ড ডিস্কে ফাইলবিহীন হয়ে পড়ত (restore/download স্থায়ীভাবে ব্যর্থ)। তাই শেষে
// একটা ছোট র‍্যান্ডম সাফিক্স যোগ করা হয়, যাতে নাম সবসময় ইউনিক থাকে।
function backupFilename(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.bak`;
}

function getEncryptionKey() {
  if (!ENC_KEY_RAW) return null;
  // যেকোনো length-এর পাসফ্রেজকে scrypt দিয়ে ঠিক ৩২ বাইট AES-256 কী-তে ডিরাইভ করা হয়
  return crypto.scryptSync(ENC_KEY_RAW, 'livo-backup-salt', 32);
}

function isEncryptionEnabled() {
  return !!getEncryptionKey();
}

/** buffer -> gzip -> (ঐচ্ছিক) AES-256-GCM এনক্রিপ্ট। ফরম্যাট: [1 byte flags][12 byte iv?][16 byte authTag?][ciphertext] */
function packBuffer(buffer) {
  const gzipped = zlib.gzipSync(buffer);
  const key = getEncryptionKey();
  if (!key) {
    return Buffer.concat([Buffer.from([0x00]), gzipped]); // flag 0 = শুধু কম্প্রেসড, এনক্রিপ্টেড নয়
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(gzipped), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([0x01]), iv, authTag, encrypted]); // flag 1 = কম্প্রেসড + এনক্রিপ্টেড
}

/** packBuffer()-এর বিপরীত। ভুল কী/কারাপ্টেড ফাইল হলে স্পষ্ট এরর থ্রো করে (Restore Verification-এর অংশ)। */
function unpackBuffer(buffer) {
  const flag = buffer[0];
  if (flag === 0x00) {
    return zlib.gunzipSync(buffer.subarray(1));
  }
  if (flag === 0x01) {
    const key = getEncryptionKey();
    if (!key) throw new Error('এই ব্যাকআপটি এনক্রিপ্টেড কিন্তু BACKUP_ENCRYPTION_KEY সেট নেই — ডিক্রিপ্ট করা যাবে না।');
    const iv = buffer.subarray(1, 13);
    const authTag = buffer.subarray(13, 29);
    const ciphertext = buffer.subarray(29);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]); // authTag ভুল হলে এখানেই throw করবে
    return zlib.gunzipSync(decrypted);
  }
  throw new Error('অজানা ব্যাকআপ ফরম্যাট — ফাইল কারাপ্টেড হতে পারে।');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function saveBackupRecord({ type, filename, sizeBytes, checksum, status, errorMessage, source, createdById, createdByUsername }) {
  const r = await pool.query(
    `INSERT INTO backup_history (type, filename, size_bytes, encrypted, compressed, checksum, status, error_message, source, created_by_id, created_by_username)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [type, filename, sizeBytes, isEncryptionEnabled(), true, checksum, status, errorMessage || null, source, createdById || null, createdByUsername || null]
  );
  return r.rows[0];
}

// ==================== Database Backup ====================
async function dumpAllTables() {
  const tablesRes = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const dump = {};
  for (const row of tablesRes.rows) {
    const t = row.table_name;
    if (SKIP_TABLES.includes(t)) continue;
    try {
      const data = await pool.query(`SELECT * FROM "${t}"`);
      dump[t] = data.rows;
    } catch (e) {
      console.error(`backup: table ${t} skip করা হলো —`, e.message);
    }
  }
  return dump;
}

async function createDatabaseBackup({ source = 'manual', createdById, createdByUsername } = {}) {
  ensureBackupDir();
  try {
    const dump = await dumpAllTables();
    const json = JSON.stringify({ type: 'database', generated_at: new Date().toISOString(), tables: dump });
    const packed = packBuffer(Buffer.from(json, 'utf8'));
    const checksum = sha256(packed);
    const filename = backupFilename('db');
    await fsp.writeFile(path.join(BACKUP_DIR, filename), packed);
    return await saveBackupRecord({
      type: 'database', filename, sizeBytes: packed.length, checksum,
      status: 'completed', source, createdById, createdByUsername
    });
  } catch (err) {
    return await saveBackupRecord({
      type: 'database', filename: '-', sizeBytes: 0, checksum: null,
      status: 'failed', errorMessage: err.message, source, createdById, createdByUsername
    });
  }
}

// ==================== Uploaded Files Backup ====================
function tarGzipDirectory(sourceDir) {
  return new Promise((resolve, reject) => {
    const parent = path.dirname(sourceDir);
    const base = path.basename(sourceDir);
    const chunks = [];
    const proc = spawn('tar', ['-C', parent, '-czf', '-', base]);
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', () => {}); // tar-এর সাধারণ stderr নয়েজ উপেক্ষা
    proc.on('error', reject); // tar বাইনারি না থাকলে
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`tar exited with code ${code}`));
    });
  });
}

async function createUploadsBackup({ source = 'manual', createdById, createdByUsername } = {}) {
  ensureBackupDir();
  try {
    if (!fs.existsSync(UPLOADS_DIR)) {
      throw new Error('public/uploads ফোল্ডার পাওয়া যায়নি — কিছু ব্যাকআপ করার নেই।');
    }
    const tarball = await tarGzipDirectory(UPLOADS_DIR); // ইতিমধ্যে gzip-কম্প্রেসড (tar -z)
    // এখানে আর দ্বিতীয়বার gzip করা হচ্ছে না (ডাবল-কম্প্রেশনে লাভ নেই), শুধু এনক্রিপশন ফ্ল্যাগ ফরম্যাট মেলাতে packBuffer রিইউজ করা হচ্ছে —
    // কিন্তু packBuffer গজিপও করে, তাই সরাসরি নিজস্ব র‍্যাপার ব্যবহার করা হলো uploads-এর জন্য।
    const key = getEncryptionKey();
    let packed;
    if (!key) {
      packed = Buffer.concat([Buffer.from([0x02]), tarball]); // flag 2 = tar.gz, এনক্রিপ্টেড নয়
    } else {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(tarball), cipher.final()]);
      const authTag = cipher.getAuthTag();
      packed = Buffer.concat([Buffer.from([0x03]), iv, authTag, encrypted]); // flag 3 = tar.gz + এনক্রিপ্টেড
    }
    const checksum = sha256(packed);
    const filename = backupFilename('uploads');
    await fsp.writeFile(path.join(BACKUP_DIR, filename), packed);
    return await saveBackupRecord({
      type: 'uploads', filename, sizeBytes: packed.length, checksum,
      status: 'completed', source, createdById, createdByUsername
    });
  } catch (err) {
    return await saveBackupRecord({
      type: 'uploads', filename: '-', sizeBytes: 0, checksum: null,
      status: 'failed', errorMessage: err.message, source, createdById, createdByUsername
    });
  }
}

function unpackUploadsBuffer(buffer) {
  const flag = buffer[0];
  if (flag === 0x02) return buffer.subarray(1); // tar.gz, plain
  if (flag === 0x03) {
    const key = getEncryptionKey();
    if (!key) throw new Error('এই আপলোড-ব্যাকআপটি এনক্রিপ্টেড কিন্তু BACKUP_ENCRYPTION_KEY সেট নেই।');
    const iv = buffer.subarray(1, 13);
    const authTag = buffer.subarray(13, 29);
    const ciphertext = buffer.subarray(29);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
  throw new Error('অজানা uploads ব্যাকআপ ফরম্যাট।');
}

// ==================== Configuration Backup ====================
// নিরাপত্তার জন্য .env-এর আসল মান কখনো ব্যাকআপে যায় না — শুধু কোন কোন key ব্যবহৃত হয় তার তালিকা
// (env.example থেকে) + site_settings টেবিলের ডেটা (যেটা secret না, সাইট কনফিগারেশন)।
async function createConfigBackup({ source = 'manual', createdById, createdByUsername } = {}) {
  ensureBackupDir();
  try {
    let envKeys = [];
    try {
      const exampleContent = await fsp.readFile(path.join(__dirname, '..', '.env.example'), 'utf8');
      envKeys = exampleContent.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && l.includes('='))
        .map(l => l.split('=')[0]);
    } catch (e) {}

    const settingsRes = await pool.query('SELECT key, value, updated_at FROM site_settings ORDER BY key');
    let pkg = {};
    try { pkg = JSON.parse(await fsp.readFile(path.join(__dirname, '..', 'package.json'), 'utf8')); } catch (e) {}

    const payload = {
      type: 'config',
      generated_at: new Date().toISOString(),
      node_version: process.version,
      app_version: pkg.version || null,
      env_var_names: envKeys, // শুধু নাম, কোনো secret value না
      site_settings: settingsRes.rows
    };
    const json = JSON.stringify(payload);
    const packed = packBuffer(Buffer.from(json, 'utf8'));
    const checksum = sha256(packed);
    const filename = backupFilename('config');
    await fsp.writeFile(path.join(BACKUP_DIR, filename), packed);
    return await saveBackupRecord({
      type: 'config', filename, sizeBytes: packed.length, checksum,
      status: 'completed', source, createdById, createdByUsername
    });
  } catch (err) {
    return await saveBackupRecord({
      type: 'config', filename: '-', sizeBytes: 0, checksum: null,
      status: 'failed', errorMessage: err.message, source, createdById, createdByUsername
    });
  }
}

// ==================== Restore ====================
/** ফাইল ডিস্কে ঠিক আছে কিনা যাচাই করে (Restore Verification) — checksum মিলছে কিনা, ফরম্যাট ভ্যালিড কিনা। */
async function verifyBackupFile(record) {
  const filePath = getBackupFilePath(record); // containment-চেক করা পাথ
  if (!fs.existsSync(filePath)) throw new Error('ব্যাকআপ ফাইল ডিস্কে পাওয়া যায়নি।');
  const buffer = await fsp.readFile(filePath);
  const actualChecksum = sha256(buffer);
  if (record.checksum && actualChecksum !== record.checksum) {
    throw new Error('Checksum মিলছে না — ফাইলটি কারাপ্টেড বা পরিবর্তিত হয়ে থাকতে পারে। রিস্টোর বাতিল করা হলো।');
  }
  return buffer;
}

async function restoreDatabaseBackup(record) {
  const buffer = await verifyBackupFile(record);
  const unpacked = unpackBuffer(buffer);
  const parsed = JSON.parse(unpacked.toString('utf8')); // JSON.parse ব্যর্থ হলেই এখানে থ্রো করবে — দ্বিতীয় verification layer
  if (!parsed || parsed.type !== 'database' || !parsed.tables) {
    throw new Error('ব্যাকআপ ফাইলের গঠন প্রত্যাশিত ফরম্যাটের সাথে মেলেনি।');
  }

  const results = {};
  const skipped = {};
  for (const table of RESTORE_ORDER) {
    const rows = parsed.tables[table];
    if (!rows || rows.length === 0) { results[table] = 0; continue; }
    const columns = Object.keys(rows[0]);
    const colList = columns.map(c => `"${c}"`).join(', ');
    const conflictKey = TABLE_CONFLICT_KEY[table] || 'id';
    const deferred = (SELF_REFERENCING_COLUMNS[table] || []).filter(c => columns.includes(c));
    let inserted = 0;
    let failed = 0;
    for (const row of rows) {
      const values = columns.map(c => (deferred.includes(c) ? null : row[c]));
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      try {
        // বিদ্যমান ডেটা কখনো মোছা/ওভাররাইট হয় না — শুধু প্রাইমারি-কী conflict এ skip (নন-ডেস্ট্রাক্টিভ রিস্টোর)
        const r = await pool.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT ("${conflictKey}") DO NOTHING`,
          values
        );
        inserted += r.rowCount;
      } catch (e) {
        failed++;
        console.error(`restore: ${table} row skip —`, e.message);
      }
    }

    // দ্বিতীয় পাস — সব সারি ঢোকার পর self-referencing কলামগুলোর আসল মান বসানো হয়।
    for (const col of deferred) {
      for (const row of rows) {
        if (row[col] === null || row[col] === undefined) continue;
        try {
          await pool.query(
            `UPDATE "${table}" SET "${col}" = $1 WHERE "${conflictKey}" = $2 AND "${col}" IS NULL`,
            [row[col], row[conflictKey]]
          );
        } catch (e) {
          console.error(`restore: ${table}.${col} backfill skip —`, e.message);
        }
      }
    }

    results[table] = inserted;
    // আগে ব্যর্থ সারিগুলো শুধু console-এ যেত, রিটার্ন ভ্যালুতে কিছু বোঝা যেত না — অ্যাডমিন
    // প্যানেলে রিস্টোর সবসময় "সফল" দেখাত যদিও সারি হারিয়ে যেত। এখন গুনতিটা রিপোর্ট হয়।
    if (failed > 0) skipped[table] = failed;
  }
  if (Object.keys(skipped).length) results._skipped = skipped;

  await pool.query('UPDATE backup_history SET restored_at = NOW() WHERE id = $1', [record.id]);
  return results;
}

async function restoreUploadsBackup(record) {
  const buffer = await verifyBackupFile(record);
  const tarball = unpackUploadsBuffer(buffer);
  const tmpFile = path.join(BACKUP_DIR, `restore-${Date.now()}.tar.gz`);
  await fsp.writeFile(tmpFile, tarball);
  try {
    await new Promise((resolve, reject) => {
      // public/-এ এক্সট্র্যাক্ট করা হয়, tarball-এর ভেতরে uploads/ ফোল্ডারসহ পাথ আছে
      const proc = spawn('tar', ['-C', path.join(__dirname, '..', 'public'), '-xzf', tmpFile]);
      proc.on('error', reject);
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar extract exited with code ${code}`)));
    });
  } finally {
    await fsp.unlink(tmpFile).catch(() => {});
  }
  await pool.query('UPDATE backup_history SET restored_at = NOW() WHERE id = $1', [record.id]);
  return { restored: true };
}

async function restoreConfigBackup(record) {
  const buffer = await verifyBackupFile(record);
  const unpacked = unpackBuffer(buffer);
  const parsed = JSON.parse(unpacked.toString('utf8'));
  if (!parsed || parsed.type !== 'config' || !Array.isArray(parsed.site_settings)) {
    throw new Error('কনফিগ ব্যাকআপের গঠন প্রত্যাশিত ফরম্যাটের সাথে মেলেনি।');
  }
  for (const s of parsed.site_settings) {
    await pool.query(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [s.key, s.value]
    );
  }
  try {
    const { invalidateSettingsCache } = require('./settings');
    if (invalidateSettingsCache) await invalidateSettingsCache();
  } catch (e) {}
  await pool.query('UPDATE backup_history SET restored_at = NOW() WHERE id = $1', [record.id]);
  return { restoredSettings: parsed.site_settings.length };
}

async function restoreBackup(record) {
  if (record.status !== 'completed') throw new Error('শুধু সফলভাবে সম্পন্ন হওয়া ব্যাকআপ রিস্টোর করা যাবে।');
  if (record.type === 'database') return restoreDatabaseBackup(record);
  if (record.type === 'uploads') return restoreUploadsBackup(record);
  if (record.type === 'config') return restoreConfigBackup(record);
  throw new Error('অজানা ব্যাকআপ টাইপ।');
}

// ==================== History / Delete / Download ====================
async function listBackups({ type = '', limit = 50 } = {}) {
  const params = [];
  let where = '';
  if (type) { params.push(type); where = `WHERE type = $${params.length}`; }
  params.push(limit);
  const r = await pool.query(
    `SELECT * FROM backup_history ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

async function getBackupById(id) {
  const r = await pool.query('SELECT * FROM backup_history WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function deleteBackup(id) {
  const record = await getBackupById(id);
  if (!record) throw new Error('ব্যাকআপ পাওয়া যায়নি।');
  // filename অবৈধ (ডিরেক্টরির বাইরে) হলে ডিস্কে হাত দেওয়া হয় না, কিন্তু DB রেকর্ডটা যেন
  // মুছে ফেলা যায় — নাহলে একটা খারাপ সারি চিরকাল অ্যাডমিন প্যানেলে আটকে থাকত।
  try {
    await fsp.unlink(getBackupFilePath(record)).catch(() => {}); // ফাইল আগে থেকে না থাকলেও সমস্যা নেই
  } catch (e) {
    console.error('deleteBackup: ফাইল পাথ প্রত্যাখ্যাত —', e.message);
  }
  await pool.query('DELETE FROM backup_history WHERE id = $1', [id]);
  return true;
}

// filename সবসময় backupFilename() দিয়ে সার্ভার-সাইডে তৈরি হয়, তাই এখানে path traversal-এর
// কোনো পরিচিত রিচেবল পাথ নেই। কিন্তু backup_history নিজেই একটা রিস্টোরযোগ্য টেবিল — অর্থাৎ
// ব্যাকআপ পে-লোড থেকে আসা মান এই কলামে বসতে পারে। তাই defense-in-depth হিসেবে দুই স্তরের যাচাই:
//   ১) লেক্সিক্যাল — রিজলভ করা পাথ BACKUP_DIR-এর সরাসরি সন্তান হতে হবে ('../', অ্যাবসোলিউট
//      পাথ, নেস্টেড সাবডিরেক্টরি — সবই বাতিল)।
//   ২) realpath — path.resolve() সিমলিংক অনুসরণ করে না, তাই BACKUP_DIR-এর ভেতরে বসানো একটা
//      সিমলিংক লেক্সিক্যাল চেক পাস করেও বাইরের ফাইল পড়তে/মুছতে পারত। ফাইলটা আসলে থাকলে তার
//      realpath-ও ডিরেক্টরির ভেতরে আছে কিনা মিলিয়ে দেখা হয়। BACKUP_DIR নিজে সিমলিংক হলে
//      (যেমন কন্টেইনারে মাউন্ট করা ভলিউম) সমস্যা হয় না, কারণ দুই পাশেই realpath নেওয়া হয়।
function getBackupFilePath(record) {
  const filename = String(record && record.filename ? record.filename : '');
  const root = path.resolve(BACKUP_DIR);
  const resolved = path.resolve(root, filename);
  if (resolved !== path.join(root, path.basename(resolved)) || !resolved.startsWith(root + path.sep)) {
    throw new Error('ব্যাকআপ ফাইলের নাম অবৈধ — ব্যাকআপ ডিরেক্টরির বাইরের পাথ গ্রহণ করা হয় না।');
  }

  let realResolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch (e) {
    return resolved; // ফাইল এখনো নেই — লেক্সিক্যাল চেকই যথেষ্ট (তৈরি হওয়ার পথ)
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch (e) {
    realRoot = root;
  }
  if (realResolved !== path.join(realRoot, path.basename(realResolved)) || !realResolved.startsWith(realRoot + path.sep)) {
    throw new Error('ব্যাকআপ ফাইলের নাম অবৈধ — সিমলিংক ব্যাকআপ ডিরেক্টরির বাইরে নির্দেশ করছে।');
  }
  return resolved;
}

// ==================== Scheduled Backup ====================
let scheduleHandle = null;
function scheduleAutoBackup() {
  if (scheduleHandle) return;
  const hours = parseInt(process.env.BACKUP_SCHEDULE_HOURS || '24', 10);
  if (!hours || hours <= 0) return; // 0/negative দিয়ে বন্ধ করা যায়
  const intervalMs = hours * 60 * 60 * 1000;
  const run = async () => {
    console.log('🗄️ Scheduled backup শুরু হচ্ছে...');
    await createDatabaseBackup({ source: 'scheduled' });
    await createUploadsBackup({ source: 'scheduled' });
    await createConfigBackup({ source: 'scheduled' });
    await pruneOldScheduledBackups();
    console.log('✅ Scheduled backup সম্পন্ন।');
  };
  setTimeout(run, 5 * 60 * 1000); // সার্ভার স্টার্টের ৫ মিনিট পর প্রথমবার
  scheduleHandle = setInterval(run, intervalMs);
  if (scheduleHandle.unref) scheduleHandle.unref();
}

// ডিস্ক ভরে যাওয়া এড়াতে scheduled ব্যাকআপ প্রতি টাইপে সর্বোচ্চ ১৪টা রাখা হয়, বাকিগুলো ডিলিট
async function pruneOldScheduledBackups() {
  for (const type of ['database', 'uploads', 'config']) {
    const rows = await pool.query(
      `SELECT id FROM backup_history WHERE type = $1 AND source = 'scheduled' ORDER BY created_at DESC OFFSET 14`,
      [type]
    );
    for (const row of rows.rows) await deleteBackup(row.id).catch(() => {});
  }
}

module.exports = {
  createDatabaseBackup, createUploadsBackup, createConfigBackup,
  restoreBackup, listBackups, getBackupById, deleteBackup, getBackupFilePath,
  scheduleAutoBackup, isEncryptionEnabled, BACKUP_DIR
};
