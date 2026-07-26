// services/queue/queues.js
// সব Named Queue তৈরি এবং Job-এ যোগ করার helper functions।
// Redis না থাকলে fallback: job সরাসরি synchronously execute হয় অথবা skip হয়।

const { Queue } = require('bullmq');
const { getConnection, isAvailable } = require('./connection');

// ==================== Queue নাম ও ডিফল্ট অপশন ====================
const QUEUE_DEFS = {
  email:        { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
  notification: { attempts: 3, backoff: { type: 'exponential', delay: 3000 } },
  activityLog:  { attempts: 2, backoff: { type: 'fixed', delay: 2000 } },
  apiLog:       { attempts: 2, backoff: { type: 'fixed', delay: 2000 } },
  fraudScan:    { attempts: 2, backoff: { type: 'fixed', delay: 5000 } },
  background:   { attempts: 3, backoff: { type: 'exponential', delay: 8000 } },
};

const queues = {};

function getQueue(name) {
  if (!isAvailable()) return null;
  if (!queues[name]) {
    queues[name] = new Queue(name, {
      connection: getConnection(),
      defaultJobOptions: {
        ...QUEUE_DEFS[name],
        removeOnComplete: { count: 500 },
        removeOnFail:     { count: 200 },
      }
    });
  }
  return queues[name];
}

// ==================== Generic Enqueue ====================
async function enqueue(queueName, jobName, data = {}, opts = {}) {
  try {
    const q = getQueue(queueName);
    if (!q) return null; // Redis ছাড়া silently skip
    return await q.add(jobName, data, opts);
  } catch (err) {
    console.error(`[queue] enqueue ${queueName}/${jobName} failed:`, err.message);
    return null;
  }
}

// ==================== Typed Helpers ====================

/** Email পাঠানোর job Queue-এ যোগ করো */
async function queueEmail(type, payload, opts = {}) {
  return enqueue('email', type, payload, opts);
}

/** Web Push / Socket notification Queue-এ যোগ করো */
async function queueNotification(type, payload, opts = {}) {
  return enqueue('notification', type, payload, opts);
}

/** Activity Log DB insert Queue-এ দাও (non-blocking write) */
async function queueActivityLog(adminId, adminUsername, actionType, details, ip = null) {
  return enqueue('activityLog', 'insert', { adminId, adminUsername, actionType, details, ip });
}

/** API request/response log Queue-এ দাও */
async function queueApiLog(logData) {
  return enqueue('apiLog', 'insert', logData);
}

/** Fraud/Duplicate scan job Queue-এ দাও */
async function queueFraudScan(userId, context = {}) {
  return enqueue('fraudScan', 'evaluate', { userId, context });
}

/** যেকোনো background job */
async function queueBackground(jobName, data = {}, opts = {}) {
  return enqueue('background', jobName, data, opts);
}

/** সব Queue-এর নাম লিস্ট */
function getQueueNames() { return Object.keys(QUEUE_DEFS); }

module.exports = {
  getQueue,
  enqueue,
  queueEmail,
  queueNotification,
  queueActivityLog,
  queueApiLog,
  queueFraudScan,
  queueBackground,
  getQueueNames,
};
