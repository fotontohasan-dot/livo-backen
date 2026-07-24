// queues/workers.js
const { Worker } = require('bullmq');
const { connection } = require('./connection');
const { QUEUE_NAMES } = require('./definitions');

const { processEmailJob } = require('./processors/email');
const { processNotificationJob } = require('./processors/notification');
const { processActivityLogJob } = require('./processors/activityLog');
const { processApiLogJob } = require('./processors/apiLog');
const { processFraudScanJob } = require('./processors/fraudScan');

const WORKER_CONFIG = [
  { name: QUEUE_NAMES.EMAIL, processor: processEmailJob, concurrency: 5 },
  { name: QUEUE_NAMES.NOTIFICATION, processor: processNotificationJob, concurrency: 5 },
  { name: QUEUE_NAMES.ACTIVITY_LOG, processor: processActivityLogJob, concurrency: 10 },
  { name: QUEUE_NAMES.API_LOG, processor: processApiLogJob, concurrency: 10 },
  { name: QUEUE_NAMES.FRAUD_SCAN, processor: processFraudScanJob, concurrency: 3 }
];

let workers = [];

function startWorkers() {
  if (!connection) return [];
  workers = WORKER_CONFIG.map(({ name, processor, concurrency }) => {
    const worker = new Worker(name, processor, { connection, concurrency });

    worker.on('completed', (job) => {
      console.log(`✅ [Queue:${name}] job #${job.id} (${job.name}) সম্পন্ন হয়েছে`);
    });

    worker.on('failed', (job, err) => {
      const attemptsMade = job ? job.attemptsMade : '?';
      const maxAttempts = job ? job.opts.attempts : '?';
      console.error(`❌ [Queue:${name}] job #${job ? job.id : '?'} ব্যর্থ (attempt ${attemptsMade}/${maxAttempts}):`, err.message);
      try {
        const { logEvent } = require('../services/auditLog');
        logEvent({
          actorType: 'system', actorUsername: 'SYSTEM',
          action: 'QUEUE_JOB_FAILED', category: 'queue', status: 'failure',
          riskLevel: (job && job.opts && attemptsMade >= job.opts.attempts) ? 'high' : 'medium',
          details: { queue: name, jobId: job ? job.id : null, jobName: job ? job.name : null, attemptsMade, maxAttempts, error: err.message }
        }).catch(() => {});
      } catch (e) {
        console.error('[auditLog] queue failed-job logging error (non-blocking):', e.message);
      }
    });

    worker.on('error', (err) => {
      console.error(`⚠️ [Queue:${name}] worker error:`, err.message);
    });

    return worker;
  });
  return workers;
}

async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close()));
}

module.exports = { startWorkers, stopWorkers };
