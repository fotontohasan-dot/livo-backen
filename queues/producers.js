// queues/producers.js
// বাকি অ্যাপ থেকে জব যোগ করার জন্য একমাত্র entry point।
// Redis/Queue বন্ধ থাকলে (dev/অফলাইন), প্রতিটা ফাংশন নিজে থেকে সরাসরি (inline)
// কাজটা চালিয়ে দেয় — এতে বিদ্যমান ফিচার কখনো ভেঙে যায় না (Backward Compatible)।

const { QUEUE_NAMES, getQueue } = require('./definitions');
const { isQueueEnabled } = require('./connection');

async function addJob(queueName, jobName, data, opts = {}) {
  const queue = getQueue(queueName);
  if (queue && isQueueEnabled()) {
    return queue.add(jobName, data, opts);
  }
  return null; // caller নিজে fallback চালাবে
}

// ==================== EMAIL ====================
async function enqueueEmail(type, payload, opts = {}) {
  const job = await addJob(QUEUE_NAMES.EMAIL, type, payload, opts).catch((err) => {
    console.error('⚠️ enqueueEmail ব্যর্থ, সরাসরি পাঠানো হচ্ছে:', err.message);
    return null;
  });
  if (job) return { queued: true, jobId: job.id };

  const { processEmailJob } = require('./processors/email');
  await processEmailJob({ name: type, data: payload });
  return { queued: false, jobId: null };
}

// ==================== NOTIFICATION (Web Push + Socket alert) ====================
async function enqueueNotification(type, payload, opts = {}) {
  const job = await addJob(QUEUE_NAMES.NOTIFICATION, type, payload, opts).catch((err) => {
    console.error('⚠️ enqueueNotification ব্যর্থ, সরাসরি পাঠানো হচ্ছে:', err.message);
    return null;
  });
  if (job) return { queued: true, jobId: job.id };

  const { processNotificationJob } = require('./processors/notification');
  await processNotificationJob({ name: type, data: payload }).catch(() => {});
  return { queued: false, jobId: null };
}

// ==================== ACTIVITY LOG ====================
async function enqueueActivityLog(payload, opts = {}) {
  const job = await addJob(QUEUE_NAMES.ACTIVITY_LOG, 'log', payload, opts).catch((err) => {
    console.error('⚠️ enqueueActivityLog ব্যর্থ, সরাসরি DB-তে লেখা হচ্ছে:', err.message);
    return null;
  });
  if (job) return { queued: true, jobId: job.id };

  const { processActivityLogJob } = require('./processors/activityLog');
  await processActivityLogJob({ data: payload }).catch(() => {});
  return { queued: false, jobId: null };
}

// ==================== API LOG ====================
// A1: noeviction Redis-এ (সেশন + কিউ) এই কিউ যেন কখনো জায়গা না খেয়ে ফেলে — তাই সীমা *Redis-এর দিকে* প্রয়োগ হয়,
// শুধু in-process নয়:
//   • গভীরতা (waiting+delayed) Redis থেকে ≈১ সেকেন্ডে একবার পড়া হয় (BullMQ getJobCounts) — সব web ইনস্ট্যান্স ও worker মিলিয়ে।
//     সীমা (API_LOG_MAX_QUEUE_DEPTH, ডিফল্ট ৫০০০) ছাড়ালে নতুন লগ ফেলে দেওয়া ও গোনা হয়।
//   • সম্পন্ন/ব্যর্থ জব গণনা-সীমাসহ মুছে ফেলা (removeOnComplete/removeOnFail count) — সাধারণ ডিফল্টের (১০০০/২০০০) চেয়ে ছোট।
//   • Redis ব্যর্থ হলে আর "সরাসরি DB INSERT" নয় (আগে প্রতি রিকোয়েস্টে হতো) — লগ ফেলে দেওয়া হয়। শুধু কিউ আদৌ
//     কনফিগার করা না থাকলে (dev) inline লেখা হয়।
const API_LOG_MAX_DEPTH = parseInt(process.env.API_LOG_MAX_QUEUE_DEPTH || '5000', 10);
const API_LOG_KEEP_COMPLETED = parseInt(process.env.API_LOG_KEEP_COMPLETED || '100', 10);
const API_LOG_KEEP_FAILED = parseInt(process.env.API_LOG_KEEP_FAILED || '200', 10);
const apiLogGuard = { depth: 0, checkedAt: 0, checking: false, droppedDepth: 0, droppedRedisError: 0, enqueued: 0 };

function refreshApiLogDepth(queue) {
  if (apiLogGuard.checking || Date.now() - apiLogGuard.checkedAt < 1000) return;
  apiLogGuard.checking = true;
  queue.getJobCounts('waiting', 'delayed')
    .then((c) => { apiLogGuard.depth = (c.waiting || 0) + (c.delayed || 0); apiLogGuard.checkedAt = Date.now(); })
    .catch(() => { apiLogGuard.checkedAt = Date.now(); })
    .finally(() => { apiLogGuard.checking = false; });
}

function getApiLogQueueStats() {
  return { ...apiLogGuard, maxDepth: API_LOG_MAX_DEPTH };
}

async function enqueueApiLog(payload, opts = {}) {
  const queue = getQueue(QUEUE_NAMES.API_LOG);
  if (queue && isQueueEnabled()) {
    refreshApiLogDepth(queue); // await নেই — শেষ জানা গভীরতা দিয়েই সিদ্ধান্ত
    if (apiLogGuard.depth >= API_LOG_MAX_DEPTH) {
      apiLogGuard.droppedDepth++;
      return { queued: false, dropped: 'queue_depth', jobId: null };
    }
    try {
      const job = await queue.add('log', payload, {
        ...opts,
        attempts: 2,
        removeOnComplete: { count: API_LOG_KEEP_COMPLETED },
        removeOnFail: { count: API_LOG_KEEP_FAILED, age: 24 * 3600 }
      });
      apiLogGuard.enqueued++;
      return { queued: true, jobId: job.id };
    } catch (err) {
      apiLogGuard.droppedRedisError++;
      return { queued: false, dropped: 'redis_error', jobId: null };
    }
  }

  // কিউ কনফিগার করা নেই (dev/অফলাইন) — আগের মতো inline
  const { processApiLogJob } = require('./processors/apiLog');
  await processApiLogJob({ data: payload }).catch(() => {});
  return { queued: false, jobId: null };
}

// ==================== FRAUD SCAN ====================
async function enqueueFraudScan(payload, opts = {}) {
  const job = await addJob(QUEUE_NAMES.FRAUD_SCAN, 'scan', payload, opts).catch((err) => {
    console.error('⚠️ enqueueFraudScan ব্যর্থ, সরাসরি স্ক্যান চালানো হচ্ছে:', err.message);
    return null;
  });
  if (job) return { queued: true, jobId: job.id };

  const { runFraudScan } = require('./processors/fraudScan');
  await runFraudScan(payload).catch((err) => console.error('Fraud scan (fallback) error:', err.message));
  return { queued: false, jobId: null };
}

module.exports = {
  enqueueEmail,
  enqueueNotification,
  enqueueActivityLog,
  enqueueApiLog,
  getApiLogQueueStats,
  enqueueFraudScan
};
