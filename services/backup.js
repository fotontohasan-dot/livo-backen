// services/backup.js
// প্রতিদিন সব টেবিলের ডেটা JSON আকারে GitHub রিপোতে সেভ করে
// DB এক্সপায়ার/ডিলিট হয়ে গেলেও এই ব্যাকআপ থেকে ডেটা ফিরিয়ে আনা যাবে

const { pool } = require('../db');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // যেমন: fotontohasan-dot/livo-backen
const BACKUP_PATH = 'db-backups/backup-latest.json';

// এই টেবিলগুলো ব্যাকআপে বাদ যাবে (সেশন/লগ টাইপ, দরকার নেই)
const SKIP_TABLES = ['session'];

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

async function getExistingSha() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${BACKUP_PATH}`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
    );
    if (res.status === 200) {
      const data = await res.json();
      return data.sha;
    }
    return null;
  } catch {
    return null;
  }
}

async function uploadToGithub(jsonString) {
  const sha = await getExistingSha();
  const body = {
    message: `db backup ${new Date().toISOString()}`,
    content: Buffer.from(jsonString).toString('base64')
  };
  if (sha) body.sha = sha;

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${BACKUP_PATH}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub আপলোড ব্যর্থ (${res.status}): ${errText}`);
  }
}

let lastBackupAt = null;
let lastBackupError = null;

async function runBackupNow() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    lastBackupError = 'GITHUB_TOKEN / GITHUB_REPO সেট করা নেই (.env)';
    console.error('backup skipped:', lastBackupError);
    return { ok: false, error: lastBackupError };
  }
  try {
    const dump = await dumpAllTables();
    const payload = JSON.stringify({ generated_at: new Date().toISOString(), tables: dump }, null, 0);
    await uploadToGithub(payload);
    lastBackupAt = new Date();
    lastBackupError = null;
    console.log(`✅ DB ব্যাকআপ সম্পন্ন (${Object.keys(dump).length} টেবিল) — ${lastBackupAt.toISOString()}`);
    return { ok: true, tables: Object.keys(dump).length, at: lastBackupAt };
  } catch (err) {
    lastBackupError = err.message;
    console.error('❌ ব্যাকআপ ব্যর্থ:', err.message);
    return { ok: false, error: err.message };
  }
}

// প্রতি ২৪ ঘণ্টা পরপর অটো ব্যাকআপ (সার্ভার চালু থাকা অবস্থায়)
//
// আগে দুটো সমস্যা ছিল — দুটোই সহোদর services/backupManager.js-এর scheduleAutoBackup()-এ
// ইতিমধ্যে সমাধান করা ছিল, কিন্তু এখানে ছিল না:
//   ১. একাধিকবার কল করলে প্রতিবার নতুন setInterval তৈরি হতো (হ্যান্ডল কোথাও রাখা হতো না),
//      ফলে একই দিনে একাধিক ব্যাকআপ চলার ঝুঁকি থাকত এবং টাইমার বাতিলও করা যেত না।
//   ২. টাইমারে .unref() ছিল না, তাই ইন্টারভালটা Node-এর ইভেন্ট লুপ জীবিত রাখত —
//      প্রসেস স্বাভাবিকভাবে শেষ হতে পারত না (graceful shutdown ও টেস্টে open handle)।
let dailyBackupHandle = null;
function scheduleDailyBackup() {
  if (dailyBackupHandle) return; // দুবার শিডিউল হওয়া ঠেকানো
  const DAY_MS = 24 * 60 * 60 * 1000;
  // সার্ভার স্টার্ট হওয়ার ৫ মিনিট পর প্রথম ব্যাকআপ (DB কানেকশন স্টাবল হওয়ার সময় দিয়ে)
  const firstRun = setTimeout(runBackupNow, 5 * 60 * 1000);
  if (firstRun.unref) firstRun.unref();
  dailyBackupHandle = setInterval(runBackupNow, DAY_MS);
  if (dailyBackupHandle.unref) dailyBackupHandle.unref();
}

function getBackupStatus() {
  return { lastBackupAt, lastBackupError, configured: !!(GITHUB_TOKEN && GITHUB_REPO) };
}

module.exports = { runBackupNow, scheduleDailyBackup, getBackupStatus, restoreFromBackup, fetchLatestBackup };

// ডিপেন্ডেন্সি অনুযায়ী ইনসার্টের ক্রম (users আগে, তারপর যেগুলো users/matches রেফার করে)
const RESTORE_ORDER = [
  'users', 'matches', 'markets', 'bets', 'payment_requests', 'notifications',
  'chat_messages', 'news', 'kyc_requests', 'error_logs', 'login_logs', 'bonuses',
  'daily_reward_tiers', 'user_daily_rewards', 'referrals', 'referral_commissions',
  'daily_losses', 'vip_levels', 'mission_defs', 'user_missions', 'mission_claims',
  'wheel_spins', 'loyalty_ledger', 'user_badges', 'free_bets', 'periodic_claims',
  'daily_rewards', 'social_shares', 'bank_cards'
];

async function fetchLatestBackup() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${BACKUP_PATH}`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
  );
  if (!res.ok) throw new Error(`ব্যাকআপ পাওয়া যায়নি (${res.status})`);
  const meta = await res.json();
  const content = Buffer.from(meta.content, 'base64').toString('utf8');
  return JSON.parse(content);
}

// সতর্কতা: এটা টেবিলে থাকা id-গুলো ON CONFLICT DO NOTHING দিয়ে বসায় — বিদ্যমান ডেটা মুছে না,
// শুধু ফাঁকা/নতুন টেবিলে ব্যাকআপের ডেটা ফিরিয়ে আনে।
async function restoreFromBackup() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    throw new Error('GITHUB_TOKEN / GITHUB_REPO সেট করা নেই (.env)');
  }
  const backup = await fetchLatestBackup();
  const results = {};

  for (const table of RESTORE_ORDER) {
    const rows = backup.tables[table];
    if (!rows || rows.length === 0) { results[table] = 0; continue; }

    const columns = Object.keys(rows[0]);
    const colList = columns.map(c => `"${c}"`).join(', ');
    let inserted = 0;

    for (const row of rows) {
      const values = columns.map(c => row[c]);
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      try {
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
  return results;
}
