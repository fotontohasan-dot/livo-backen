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
async function enqueueApiLog(payload, opts = {}) {
  const job = await addJob(QUEUE_NAMES.API_LOG, 'log', payload, { ...opts, attempts: 2 }).catch((err) => {
    console.error('⚠️ enqueueApiLog ব্যর্থ, সরাসরি DB-তে লেখা হচ্ছে:', err.message);
    return null;
  });
  if (job) return { queued: true, jobId: job.id };

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
  enqueueFraudScan
};
