// services/scheduler.js
// ---------------------------------------------------------------------------
// কেন্দ্রীয় Cron/Scheduler সিস্টেম। কোনো নতুন npm dependency ছাড়াই (setInterval-ভিত্তিক)
// প্রতিটা Job-এর enable/disable, last-run, next-run, execution history DB-তে
// (cron_jobs, cron_job_logs) রাখা হয়, যাতে অ্যাডমিন প্যানেল থেকে ম্যানেজ করা যায় এবং
// সার্ভার রিস্টার্ট করলেও অবস্থা হারিয়ে না যায়।
//
// প্রোডাকশন-রেডি ফিচার:
//  - প্রতিটা Job ব্যর্থ হলে স্বয়ংক্রিয়ভাবে রিট্রাই হয় (exponential backoff), শেষ পর্যন্ত
//    ব্যর্থ হলে error হিসেবে লগ হয় — একটা Job ব্যর্থ হলেও বাকি Job-গুলো চলতে থাকে।
//  - প্রতিটা রানের Duration, Status, Attempt সংখ্যা ও Error message cron_job_logs-এ যায়।
//  - অ্যাডমিন প্যানেল থেকে Enable/Disable/Run Now — সার্ভার রিস্টার্ট ছাড়াই কাজ করে
//    (প্রতিবার চালানোর আগে DB থেকে enabled ফ্ল্যাগ ফ্রেশ পড়া হয়)।
//  - app.js-এর server.listen() কলব্যাকে start() কল হয়, তাই সার্ভার রিস্টার্টের পর
//    স্বয়ংক্রিয়ভাবে আবার চালু হয়ে যায় — আলাদা কোনো ম্যানুয়াল স্টেপ লাগে না।
// ---------------------------------------------------------------------------

const { pool } = require('../db');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== Job সংজ্ঞা ====================
// handler() থ্রো করলেও runJob() নিজে থেকে ধরে, রিট্রাই করে, লগ করে — বাকি সিস্টেমে প্রভাব ফেলে না।
// এখানে শুধু বর্তমান কোডবেসে সত্যিকারভাবে বিদ্যমান মডিউল/টেবিলের ওপর নির্ভরশীল Job রাখা হয়েছে।
// note: ডেইলি ব্যাকআপ ইতিমধ্যে services/backup.js-এর scheduleDailyBackup() দিয়ে স্বতন্ত্রভাবে
// শিডিউল করা আছে (app.js-এ কল করা হয়) — এখানে আলাদা কোনো ব্যাকআপ Job রাখা হয়নি, যাতে
// দ্বৈত (duplicate) ব্যাকআপ শিডিউল তৈরি না হয়।
function buildJobDefinitions() {
  return {
    daily_cleanup: {
      label: 'Daily Cleanup',
      description: 'পুরনো (৩০ দিনের বেশি) পড়া নোটিফিকেশন ও রিভোকড ডিভাইস সেশন মুছে ফেলে',
      defaultIntervalMs: DAY,
      defaultEnabled: true,
      maxRetries: 1,
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
      maxRetries: 1,
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
      maxRetries: 1,
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

    fraud_scan: {
      label: 'Fraud Scan',
      description: 'গত ২৪ ঘণ্টায় সক্রিয় (বেট/ডিপোজিট) ইউজারদের ব্যাচ Fraud Heuristic স্ক্যান কিউতে পাঠায়',
      defaultIntervalMs: 6 * HOUR,
      defaultEnabled: true,
      maxRetries: 2,
      handler: async () => {
        // নোট: পুরনো BullMQ কিউ (services/queue/queues.js -> queueFraudScan) ২৮ জুলাই
        // সরানো হয়েছে। বর্তমান সক্রিয় কিউ (services/queue.js)-এর fraud_scan হ্যান্ডলার
        // (services/queueHandlers.js) শুধু event-ভিত্তিক kind (registration/login/
        // failed_login/transaction) নেয় — এই cron-এর "সব সাম্প্রতিক সক্রিয় ইউজারের
        // পর্যায়ক্রমিক জেনেরিক স্ক্যান" আচরণের কোনো সরাসরি সমতুল্য এখন নেই। ভুল kind
        // দিয়ে জোর করে enqueue করলে প্রতিটা জব ব্যর্থ (dead-letter) হয়ে জমবে, তাই
        // সিদ্ধান্ত না হওয়া পর্যন্ত এই টাস্কটা নিষ্ক্রিয় রাখা হলো।
        return 'স্কিপ করা হয়েছে: এই জেনেরিক periodic fraud scan-এর জন্য বর্তমান fraud_scan হ্যান্ডলারে (event-ভিত্তিক kind প্রয়োজন) কোনো সমতুল্য নেই — পুনর্লিখন দরকার';
      }
    },

    queue_cleanup: {
      label: 'Queue Cleanup',
      description: 'job_queue-এর পুরনো completed (২৪ ঘণ্টা+) রো ও পুরনো dead-letter (৭ দিন+) জব মুছে ফেলে',
      defaultIntervalMs: HOUR,
      defaultEnabled: true,
      maxRetries: 1,
      handler: async () => {
        // নোট: পুরনো BullMQ-নির্ভর ভার্সন ২৮ জুলাই সরানো হয়েছে। বর্তমান সক্রিয় কিউ
        // (services/queue.js, Postgres job_queue টেবিল) অনুযায়ী নতুন করে লেখা হলো।
        const { purgeAllDeadLetter } = require('./queue');
        const completed = await pool.query(
          `DELETE FROM job_queue WHERE status = 'completed' AND completed_at < NOW() - INTERVAL '24 hours'`
        );
        const deadLettered = await purgeAllDeadLetter(7);
        const cleaned = completed.rowCount + deadLettered;
        return `job_queue থেকে ${completed.rowCount}টা পুরনো completed জব ও ${deadLettered}টা পুরনো dead-letter জব মুছে মোট ${cleaned}টা মোছা হয়েছে`;
      }
    },

    cache_health_check: {
      label: 'Cache Health Check',
      description: 'Redis সংযোগ ও স্ট্যাটাস যাচাই করে (মূলত একটা হেলথ-রিপোর্ট, TTL-ভিত্তিক key expiry Redis নিজেই সামলায়)',
      defaultIntervalMs: HOUR,
      defaultEnabled: true,
      maxRetries: 1,
      handler: async () => {
        const cache = require('./cache');
        const status = cache.getStatus();
        if (!status.enabled) return 'Redis কনফিগার করা নেই (ঐচ্ছিক, DB fallback দিয়ে চলছে)';
        if (!status.connected) return `Redis সংযুক্ত নয়: ${status.lastError || 'অজানা কারণ'}`;
        return 'Redis সংযুক্ত ও সুস্থ';
      }
    },

    session_cleanup: {
      label: 'Session Cleanup',
      description: 'মেয়াদ শেষ হওয়া express-session এন্ট্রি (user_sessions টেবিল) মুছে ফেলে',
      defaultIntervalMs: HOUR,
      defaultEnabled: true,
      maxRetries: 1,
      handler: async () => {
        const r = await pool.query(`DELETE FROM user_sessions WHERE expire < NOW()`);
        return `${r.rowCount}টা মেয়াদ-শেষ সেশন মোছা হয়েছে`;
      }
    },

    system_health_check: {
      label: 'System Health Check',
      description: 'DB/Redis/Queue/Email চেক করে; overall status "error" হলে Telegram-এ অ্যাডমিনকে সতর্ক করে',
      defaultIntervalMs: 15 * MIN,
      defaultEnabled: true,
      maxRetries: 1,
      handler: async () => {
        const { runAllChecks } = require('./healthCheck');
        const result = await runAllChecks();
        if (result.overall === 'error') {
          try {
            const { notifyTelegram } = require('./telegramNotify');
            const failed = Object.entries(result.checks || {})
              .filter(([, v]) => v.status === 'error')
              .map(([k]) => k).join(', ');
            await notifyTelegram(`🚨 <b>System Health: ERROR</b>\nসমস্যাযুক্ত সার্ভিস: ${failed}`, { category: 'system' });
          } catch (e) { /* টেলিগ্রাম না পাঠাতে পারলেও হেলথ চেক নিজে ব্যর্থ ধরা হবে না */ }
        }
        return `Overall: ${result.overall}`;
      }
    }
  };
}

const JOB_DEFINITIONS = buildJobDefinitions();
const intervalHandles = {};
let started = false;

async function ensureJobsSeeded() {
  for (const [key, def] of Object.entries(JOB_DEFINITIONS)) {
    await pool.query(
      `INSERT INTO cron_jobs (key, label, description, interval_ms, enabled, max_retries)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key) DO UPDATE SET label = $2, description = $3
       WHERE cron_jobs.label IS DISTINCT FROM $2 OR cron_jobs.description IS DISTINCT FROM $3`,
      [key, def.label, def.description, def.defaultIntervalMs, def.defaultEnabled, def.maxRetries || 1]
    ).catch((e) => console.error(`cron seed (${key}) error:`, e.message));
  }

  // ==================== Dead Job ক্লিনআপ ====================
  // DB-তে এমন কোনো cron_jobs রেকর্ড থাকলে যেটার key বর্তমান JOB_DEFINITIONS-এ নেই
  // (পুরনো/মুছে ফেলা job), সেগুলো "dead" — এদের মুছে ফেলা হয় না (হিস্ট্রি হারানোর ঝুঁকি
  // এড়াতে), তবে অ্যাডমিন প্যানেলে আলাদাভাবে "Dead" ট্যাগ দেখানোর জন্য চিহ্নিত করা হয়।
  try {
    const keys = Object.keys(JOB_DEFINITIONS);
    const r = await pool.query(
      `SELECT key FROM cron_jobs WHERE NOT (key = ANY($1::text[]))`,
      [keys]
    );
    if (r.rows.length > 0) {
      console.warn(`⚠️ Dead cron job(s) পাওয়া গেছে (কোডে সংজ্ঞায়িত নেই, অ্যাডমিন প্যানেলে "Dead" দেখাবে): ${r.rows.map(x => x.key).join(', ')}`);
    }
  } catch (e) {
    console.error('dead job check error:', e.message);
  }
}

async function isJobEnabled(key) {
  try {
    const r = await pool.query('SELECT enabled FROM cron_jobs WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].enabled : (JOB_DEFINITIONS[key]?.defaultEnabled ?? false);
  } catch (e) {
    return false; // DB পড়া না গেলে নিরাপদভাবে স্কিপ করাই ভালো
  }
}

/** একটা Job রান করে — ব্যর্থ হলে maxRetries অনুযায়ী exponential backoff দিয়ে রিট্রাই করে।
 *  প্রতিটা ফাইনাল ফলাফল (সব রিট্রাই শেষে) cron_job_logs-এ attempts সহ লগ হয়। */
async function runJob(key, { triggeredBy = 'schedule' } = {}) {
  const def = JOB_DEFINITIONS[key];
  if (!def) throw new Error(`অজানা cron job: ${key}`);

  const maxAttempts = Math.max(1, (def.maxRetries || 0) + 1);
  const startedAt = new Date();
  let status = 'success';
  let message = '';
  let attempts = 0;
  let lastErr = null;

  for (attempts = 1; attempts <= maxAttempts; attempts++) {
    try {
      message = (await def.handler()) || 'সম্পন্ন';
      status = 'success';
      lastErr = null;
      break;
    } catch (err) {
      status = 'error';
      lastErr = err;
      message = err.message;
      console.error(`cron job "${key}" ব্যর্থ (attempt ${attempts}/${maxAttempts}):`, err.message);
      if (attempts < maxAttempts) {
        // Exponential backoff: 2s, 4s, 8s ... (সর্বোচ্চ ৩০ সেকেন্ড)
        const backoffMs = Math.min(30 * SEC, 2 * SEC * Math.pow(2, attempts - 1));
        await sleep(backoffMs);
      }
    }
  }

  if (status === 'error') {
    message = `(${attempts}/${maxAttempts} বার চেষ্টার পরও ব্যর্থ) ${message}`;
  }

  const finishedAt = new Date();
  const durationMs = finishedAt - startedAt;
  const nextRunAt = new Date(finishedAt.getTime() + def.defaultIntervalMs);

  try {
    await pool.query(
      `INSERT INTO cron_job_logs (job_key, started_at, finished_at, duration_ms, status, attempts, message, triggered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [key, startedAt, finishedAt, durationMs, status, attempts, message, triggeredBy]
    );
    await pool.query(
      `UPDATE cron_jobs SET last_run_at=$2, last_finished_at=$3, last_status=$4, last_message=$5, last_attempts=$6, next_run_at=$7, updated_at=NOW() WHERE key=$1`,
      [key, startedAt, finishedAt, status, message, attempts, nextRunAt]
    );
  } catch (e) {
    console.error(`cron job "${key}" লগ সেভ করতে ব্যর্থ:`, e.message);
  }

  return { status, message, durationMs, attempts };
}

/** সব Job-এর জন্য setInterval সেট করে; প্রতিবার চালানোর আগে DB থেকে enabled/disabled ফ্রেশ
 *  চেক করে, তাই সার্ভার রিস্টার্ট না করেই অ্যাডমিন প্যানেল থেকে toggle করলে কাজ করে।
 *  এই ফাংশনটাই app.js-এর server.listen() কলব্যাকে কল হয়, ফলে সার্ভার রিস্টার্ট হলে
 *  স্বয়ংক্রিয়ভাবে আবার শিডিউল রেজিস্টার হয়ে যায়। */
async function start() {
  if (started) {
    console.log('ℹ️ Scheduler আগে থেকেই চালু আছে, দ্বিতীয়বার শুরু করা হলো না (duplicate scheduler প্রতিরোধ)।');
    return;
  }
  started = true;

  await ensureJobsSeeded();

  Object.entries(JOB_DEFINITIONS).forEach(([key, def], index) => {
    // সব জব একসাথে না চালিয়ে সামান্য stagger করা হচ্ছে
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

/** টেস্ট/গ্রেসফুল-শাটডাউনের জন্য — সব ইন্টারভাল বন্ধ করে দেয়। */
function stop() {
  Object.values(intervalHandles).forEach((h) => clearInterval(h));
  for (const k of Object.keys(intervalHandles)) delete intervalHandles[k];
  started = false;
  console.log('🛑 Scheduler বন্ধ করা হয়েছে।');
}

async function setEnabled(key, enabled) {
  if (!JOB_DEFINITIONS[key]) throw new Error(`অজানা cron job: ${key}`);
  await pool.query('UPDATE cron_jobs SET enabled=$2, updated_at=NOW() WHERE key=$1', [key, enabled]);
}

async function listJobs() {
  const r = await pool.query('SELECT * FROM cron_jobs ORDER BY key ASC');
  return r.rows.map((row) => ({
    ...row,
    description: row.description || JOB_DEFINITIONS[row.key]?.description || '',
    isDead: !JOB_DEFINITIONS[row.key] // কোডে আর সংজ্ঞায়িত নেই এমন dead job চিহ্নিতকরণ
  }));
}

async function getJobLogs(key, limit = 30) {
  const r = await pool.query('SELECT * FROM cron_job_logs WHERE job_key = $1 ORDER BY started_at DESC LIMIT $2', [key, limit]);
  return r.rows;
}

async function getRecentLogs(limit = 100) {
  const r = await pool.query('SELECT * FROM cron_job_logs ORDER BY started_at DESC LIMIT $1', [limit]);
  return r.rows;
}

module.exports = {
  JOB_DEFINITIONS, start, stop, runJob, setEnabled, listJobs, getJobLogs, getRecentLogs, ensureJobsSeeded, isJobEnabled
};
