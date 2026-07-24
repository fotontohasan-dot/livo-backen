// services/scheduler.js
// ---------------------------------------------------------------------------
// কেন্দ্রীয় Cron/Scheduler সিস্টেম। কোনো নতুন npm dependency ছাড়াই (setInterval-ভিত্তিক,
// backup.js/backupManager.js-এর বিদ্যমান প্যাটার্নের সাথে সামঞ্জস্যপূর্ণ) প্রতিটা Job-এর
// enable/disable, last-run, next-run, execution log DB-তে (cron_jobs, cron_job_logs) রাখা হয়,
// যাতে অ্যাডমিন প্যানেল থেকে ম্যানেজ করা যায় এবং সার্ভার রিস্টার্ট করলেও অবস্থা হারিয়ে না যায়।
// একটা Job ব্যর্থ হলেও বাকি Job-গুলো চলতে থাকে — একটা try/catch অন্যটাকে প্রভাবিত করে না।
// ---------------------------------------------------------------------------

const { pool } = require('../db');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ==================== Job সংজ্ঞা ====================
// handler() থ্রো করলেও runJob() নিজে থেকে ধরে ফেলে, log করে, বাকি সিস্টেমে প্রভাব ফেলে না।
function buildJobDefinitions() {
  return {
    daily_cleanup: {
      label: 'Daily Cleanup',
      description: 'পুরনো (৩০ দিনের বেশি) পড়া নোটিফিকেশন ও রিভোকড ডিভাইস সেশন মুছে ফেলে',
      defaultIntervalMs: DAY,
      defaultEnabled: true,
      handler: async () => {
        const notif = await pool.query(`DELETE FROM notifications WHERE is_read = true AND created_at < NOW() - INTERVAL '30 days'`);
        const devices = await pool.query(`DELETE FROM device_sessions WHERE revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '60 days'`);
        return `${notif.rowCount}টা পুরনো নোটিফিকেশন, ${devices.rowCount}টা পুরনো ডিভাইস-সেশন মোছা হয়েছে`;
      }
    },

    expired_token_cleanup: {
      label: 'Expired Token Cleanup',
      description: 'মেয়াদ শেষ হওয়া পাসওয়ার্ড-রিসেট ও ইমেইল-ভেরিফিকেশন টোকেন সাফ করে',
      defaultIntervalMs: HOUR,
      defaultEnabled: true,
      handler: async () => {
        const reset = await pool.query(`UPDATE users SET reset_token = NULL, reset_token_expiry = NULL WHERE reset_token_expiry IS NOT NULL AND reset_token_expiry < NOW()`);
        const verify = await pool.query(`UPDATE users SET verification_token = NULL, verification_token_expiry = NULL WHERE verification_token_expiry IS NOT NULL AND verification_token_expiry < NOW()`);
        return `${reset.rowCount}টা মেয়াদ-শেষ reset token, ${verify.rowCount}টা verification token সাফ হয়েছে`;
      }
    },

    old_log_cleanup: {
      label: 'Old Log Cleanup',
      description: 'admin_logs, error_logs, bot_activity_logs, cron_job_logs — ৯০ দিনের বেশি পুরনো এন্ট্রি মুছে ফেলে',
      defaultIntervalMs: DAY,
      defaultEnabled: true,
      handler: async () => {
        const tables = ['admin_logs', 'error_logs', 'bot_activity_logs'];
        let total = 0;
        const parts = [];
        for (const t of tables) {
          try {
            const r = await pool.query(`DELETE FROM ${t} WHERE created_at < NOW() - INTERVAL '90 days'`);
            total += r.rowCount;
            parts.push(`${t}: ${r.rowCount}`);
          } catch (e) {
            parts.push(`${t}: skip (${e.message})`);
          }
        }
        // নিজের লগ টেবিলও পরিষ্কার রাখা হচ্ছে, কিন্তু সাম্প্রতিক ইতিহাস (৯০ দিন) রেখে দেওয়া হয়
        const cronLogs = await pool.query(`DELETE FROM cron_job_logs WHERE started_at < NOW() - INTERVAL '90 days'`);
        parts.push(`cron_job_logs: ${cronLogs.rowCount}`);
        return `মোট ${total + cronLogs.rowCount} রো মোছা হয়েছে (${parts.join(', ')})`;
      }
    },

    backup_schedule: {
      label: 'Backup Schedule',
      description: 'ডেটাবেজ ব্যাকআপ (backupManager) — ডিফল্টভাবে বন্ধ, কারণ services/backup.js ও services/backupManager.js-এ ইতিমধ্যে নিজস্ব auto-backup শিডিউল চালু আছে। এখান থেকে চালু করলে অতিরিক্ত/দ্বৈত ব্যাকআপ শিডিউল যোগ হবে।',
      defaultIntervalMs: DAY,
      defaultEnabled: false,
      handler: async () => {
        const backupManager = require('./backupManager');
        const record = await backupManager.createDatabaseBackup({ source: 'cron' });
        return `ব্যাকআপ তৈরি হয়েছে: ${record.filename} (${record.sizeBytes} bytes)`;
      }
    },

    fraud_scan: {
      label: 'Fraud Scan',
      description: 'গত ২৪ ঘণ্টায় সক্রিয় (বেট/ডিপোজিট) ইউজারদের ব্যাচ Fraud Heuristic স্ক্যান কিউতে পাঠায়',
      defaultIntervalMs: 6 * HOUR,
      defaultEnabled: true,
      handler: async () => {
        const { enqueueFraudScan } = require('../queues');
        const result = await pool.query(`
          SELECT DISTINCT user_id FROM (
            SELECT user_id FROM bets WHERE created_at > NOW() - INTERVAL '24 hours'
            UNION
            SELECT user_id FROM payment_requests WHERE created_at > NOW() - INTERVAL '24 hours'
          ) AS active_users
          LIMIT 100
        `);
        let queued = 0;
        for (const row of result.rows) {
          try {
            await enqueueFraudScan({ userId: row.user_id });
            queued++;
          } catch (e) { /* একটা ইউজারের স্ক্যান ব্যর্থ হলেও বাকিরা চলবে */ }
        }
        return `${queued}/${result.rows.length} জন সক্রিয় ইউজারের fraud scan কিউতে পাঠানো হয়েছে`;
      }
    },

    queue_cleanup: {
      label: 'Queue Cleanup',
      description: 'BullMQ-এর পুরনো completed (২৪ ঘণ্টা+) ও failed (৭ দিন+) জব মুছে ফেলে',
      defaultIntervalMs: HOUR,
      defaultEnabled: true,
      handler: async () => {
        const { isQueueEnabled } = require('../queues/connection');
        if (!isQueueEnabled()) return 'Queue সিস্টেম নিষ্ক্রিয় (Redis নেই) — কিছু করার নেই';
        const { getQueue } = require('../queues/definitions');
        const { QUEUE_NAMES } = require('../queues/definitions');
        let cleaned = 0;
        const names = Object.values(QUEUE_NAMES);
        for (const name of names) {
          const q = getQueue(name);
          if (!q) continue;
          try {
            const completed = await q.clean(24 * HOUR, 1000, 'completed');
            const failed = await q.clean(7 * DAY, 1000, 'failed');
            cleaned += completed.length + failed.length;
          } catch (e) { /* একটা কিউ ব্যর্থ হলেও বাকিরা চলবে */ }
        }
        return `${names.length}টা কিউ থেকে মোট ${cleaned}টা পুরনো জব মোছা হয়েছে`;
      }
    },

    cache_cleanup: {
      label: 'Cache Cleanup',
      description: 'Redis সংযোগ ও স্ট্যাটাস যাচাই করে (TTL-ভিত্তিক key expiry Redis নিজেই সামলায়, তাই এটা মূলত একটা হেলথ-রিপোর্ট)',
      defaultIntervalMs: HOUR,
      defaultEnabled: true,
      handler: async () => {
        const cache = require('./cache');
        const status = cache.getStatus();
        if (!status.enabled) return 'Redis কনফিগার করা নেই (ঐচ্ছিক, DB fallback দিয়ে চলছে)';
        if (!status.connected) return `Redis সংযুক্ত নয়: ${status.lastError || 'অজানা কারণ'}`;
        const stats = await cache.getDetailedStats().catch(() => null);
        return stats ? `Redis সুস্থ — ${JSON.stringify(stats).slice(0, 200)}` : 'Redis সংযুক্ত ও সুস্থ';
      }
    },

    session_cleanup: {
      label: 'Session Cleanup',
      description: 'মেয়াদ শেষ হওয়া express-session এন্ট্রি (user_sessions টেবিল) মুছে ফেলে',
      defaultIntervalMs: HOUR,
      defaultEnabled: true,
      handler: async () => {
        const r = await pool.query(`DELETE FROM user_sessions WHERE expire < NOW()`);
        return `${r.rowCount}টা মেয়াদ-শেষ সেশন মোছা হয়েছে`;
      }
    },

    system_health_check: {
      label: 'System Health Check',
      description: 'DB/Redis/Queue/Email/Disk/Memory চেক করে; overall status "error" হলে Telegram-এ অ্যাডমিনকে সতর্ক করে',
      defaultIntervalMs: 15 * MIN,
      defaultEnabled: true,
      handler: async () => {
        const { runAllChecks } = require('./healthCheck');
        const result = await runAllChecks();
        if (result.overall === 'error') {
          const { notifyTelegram } = require('./telegramNotify');
          const failed = Object.entries(result.checks).filter(([, v]) => v.status === 'error').map(([k]) => k).join(', ');
          notifyTelegram(`🚨 <b>System Health: ERROR</b>\nসমস্যাযুক্ত সার্ভিস: ${failed}`).catch(() => {});
        }
        return `Overall: ${result.overall}`;
      }
    }
  };
}

const JOB_DEFINITIONS = buildJobDefinitions();
const intervalHandles = {};

async function ensureJobsSeeded() {
  for (const [key, def] of Object.entries(JOB_DEFINITIONS)) {
    await pool.query(
      `INSERT INTO cron_jobs (key, label, description, interval_ms, enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET label = $2, description = $3
       WHERE cron_jobs.label IS DISTINCT FROM $2 OR cron_jobs.description IS DISTINCT FROM $3`,
      [key, def.label, def.description, def.defaultIntervalMs, def.defaultEnabled]
    ).catch((e) => console.error(`cron seed (${key}) error:`, e.message));
  }
}

async function isJobEnabled(key) {
  try {
    const r = await pool.query('SELECT enabled FROM cron_jobs WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].enabled : JOB_DEFINITIONS[key]?.defaultEnabled ?? false;
  } catch (e) {
    return false; // DB পড়া না গেলে নিরাপদভাবে স্কিপ করাই ভালো
  }
}

async function runJob(key, { triggeredBy = 'schedule' } = {}) {
  const def = JOB_DEFINITIONS[key];
  if (!def) throw new Error(`অজানা cron job: ${key}`);

  const startedAt = new Date();
  let status = 'success';
  let message = '';

  try {
    message = (await def.handler()) || 'সম্পন্ন';
  } catch (err) {
    status = 'error';
    message = err.message;
    console.error(`cron job "${key}" ব্যর্থ:`, err.message);
  }

  const finishedAt = new Date();
  const durationMs = finishedAt - startedAt;
  const nextRunAt = new Date(finishedAt.getTime() + def.defaultIntervalMs);

  try {
    await pool.query(
      `INSERT INTO cron_job_logs (job_key, started_at, finished_at, duration_ms, status, message, triggered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [key, startedAt, finishedAt, durationMs, status, message, triggeredBy]
    );
    await pool.query(
      `UPDATE cron_jobs SET last_run_at=$2, last_finished_at=$3, last_status=$4, last_message=$5, next_run_at=$6, updated_at=NOW() WHERE key=$1`,
      [key, startedAt, finishedAt, status, message, nextRunAt]
    );
  } catch (e) {
    console.error(`cron job "${key}" লগ সেভ করতে ব্যর্থ:`, e.message);
  }

  return { status, message, durationMs };
}

/** সব Job-এর জন্য setInterval সেট করে; প্রতিবার চালানোর আগে DB থেকে enabled/disabled ফ্রেশ চেক করে,
 *  তাই সার্ভার রিস্টার্ট না করেই অ্যাডমিন প্যানেল থেকে toggle করলে কাজ করে। */
async function start() {
  await ensureJobsSeeded();

  Object.entries(JOB_DEFINITIONS).forEach(([key, def], index) => {
    // সব জব একসাথে না চালিয়ে সামান্য stagger করা হচ্ছে (সার্ভার বুটের সাথে সাথেই একগাদা DB query একসাথে না ছোঁড়ার জন্য)
    const staggerMs = index * 5000;
    setTimeout(() => {
      const handle = setInterval(async () => {
        if (await isJobEnabled(key)) {
          runJob(key, { triggeredBy: 'schedule' }).catch((e) => console.error(`cron "${key}" runtime error:`, e.message));
        }
      }, def.defaultIntervalMs);
      intervalHandles[key] = handle;
    }, staggerMs);
  });

  console.log(`✅ Scheduler চালু হয়েছে (${Object.keys(JOB_DEFINITIONS).length}টা job রেজিস্টার করা হয়েছে)`);
}

async function setEnabled(key, enabled) {
  if (!JOB_DEFINITIONS[key]) throw new Error(`অজানা cron job: ${key}`);
  await pool.query('UPDATE cron_jobs SET enabled=$2, updated_at=NOW() WHERE key=$1', [key, enabled]);
}

async function listJobs() {
  const r = await pool.query('SELECT * FROM cron_jobs ORDER BY key ASC');
  return r.rows.map((row) => ({ ...row, description: row.description || JOB_DEFINITIONS[row.key]?.description || '' }));
}

async function getJobLogs(key, limit = 30) {
  const r = await pool.query('SELECT * FROM cron_job_logs WHERE job_key = $1 ORDER BY started_at DESC LIMIT $2', [key, limit]);
  return r.rows;
}

module.exports = { JOB_DEFINITIONS, start, runJob, setEnabled, listJobs, getJobLogs, ensureJobsSeeded };
