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
const RESTORE_ORDER = [
  'users', 'matches', 'markets', 'bets', 'payment_requests', 'notifications',
  'chat_messages', 'news', 'kyc_requests', 'error_logs', 'login_logs', 'bonuses',
  'daily_reward_tiers', 'user_daily_rewards', 'referrals', 'referral_commissions',
  'daily_losses', 'vip_levels', 'mission_defs', 'user_missions', 'mission_claims',
  'wheel_spins', 'loyalty_ledger', 'user_badges', 'free_bets', 'periodic_claims',
  'daily_rewards', 'social_shares', 'bank_cards', 'site_settings', 'bot_activity_logs',
  'ip_rules', 'backup_history'
];

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
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
    const filename = `db-${Date.now()}.bak`;
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
    const filename = `uploads-${Date.now()}.bak`;
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
    const filename = `config-${Date.now()}.bak`;
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
  const filePath = path.join(BACKUP_DIR, record.filename);
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
  for (const table of RESTORE_ORDER) {
    const rows = parsed.tables[table];
    if (!rows || rows.length === 0) { results[table] = 0; continue; }
    const columns = Object.keys(rows[0]);
    const colList = columns.map(c => `"${c}"`).join(', ');
    let inserted = 0;
    for (const row of rows) {
      const values = columns.map(c => row[c]);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      try {
        // বিদ্যমান ডেটা কখনো মোছা/ওভাররাইট হয় না — শুধু id conflict এ skip (নন-ডেস্ট্রাক্টিভ রিস্টোর)
        const r = await pool.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
          values
        );
        inserted += r.rowCount;
      } catch (e) {
        console.error(`restore: ${table} row skip —`, e.message);
      }
    }
    results[table] = inserted;
  }

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
  const filePath = path.join(BACKUP_DIR, record.filename);
  await fsp.unlink(filePath).catch(() => {}); // ফাইল আগে থেকে না থাকলেও সমস্যা নেই
  await pool.query('DELETE FROM backup_history WHERE id = $1', [id]);
  return true;
}

function getBackupFilePath(record) {
  return path.join(BACKUP_DIR, record.filename);
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
