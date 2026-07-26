// services/queue/monitor.js
// Queue Stats, Health, Dead Letter Queue এবং Job বিস্তারিত।

const { getQueue, getQueueNames } = require('./queues');
const { isAvailable } = require('./connection');

/**
 * সব Queue-এর stats এক সাথে আনো।
 * Redis না থাকলে empty stats দেয়।
 */
async function getAllStats() {
  if (!isAvailable()) {
    return getQueueNames().map(name => ({
      name, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: false, available: false
    }));
  }

  const results = await Promise.allSettled(
    getQueueNames().map(async (name) => {
      const q = getQueue(name);
      if (!q) return { name, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: false, available: false };
      const [counts, isPaused] = await Promise.all([q.getJobCounts(), q.isPaused()]);
      return {
        name,
        waiting:   counts.waiting   || 0,
        active:    counts.active    || 0,
        completed: counts.completed || 0,
        failed:    counts.failed    || 0,
        delayed:   counts.delayed   || 0,
        paused:    isPaused,
        available: true,
      };
    })
  );

  return results.map(r => r.status === 'fulfilled' ? r.value : { name: '?', waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: false, available: false });
}

/**
 * Dead Letter Queue — সর্বশেষ failed jobs (সব queue মিলিয়ে)
 */
async function getDeadLetterJobs(limit = 50) {
  if (!isAvailable()) return [];
  const allFailed = [];

  for (const name of getQueueNames()) {
    const q = getQueue(name);
    if (!q) continue;
    try {
      const jobs = await q.getFailed(0, limit - 1);
      for (const job of jobs) {
        allFailed.push({
          id:          job.id,
          queue:       name,
          name:        job.name,
          data:        job.data,
          failedReason: job.failedReason,
          attemptsMade: job.attemptsMade,
          timestamp:   job.timestamp,
          finishedOn:  job.finishedOn,
        });
      }
    } catch (e) {}
  }

  return allFailed.sort((a, b) => (b.finishedOn || 0) - (a.finishedOn || 0)).slice(0, limit);
}

/**
 * একটি নির্দিষ্ট Queue-এর jobs (waiting/active/completed/failed)
 */
async function getQueueJobs(queueName, status = 'failed', start = 0, end = 24) {
  if (!isAvailable()) return [];
  const q = getQueue(queueName);
  if (!q) return [];

  try {
    switch (status) {
      case 'waiting':   return await q.getWaiting(start, end);
      case 'active':    return await q.getActive(start, end);
      case 'completed': return await q.getCompleted(start, end);
      case 'failed':    return await q.getFailed(start, end);
      case 'delayed':   return await q.getDelayed(start, end);
      default:          return [];
    }
  } catch (e) { return []; }
}

/**
 * একটি failed job retry করো
 */
async function retryJob(queueName, jobId) {
  if (!isAvailable()) return false;
  const q = getQueue(queueName);
  if (!q) return false;
  try {
    const job = await q.getJob(jobId);
    if (job) { await job.retry(); return true; }
    return false;
  } catch (e) { return false; }
}

/**
 * একটি job মুছে দাও
 */
async function removeJob(queueName, jobId) {
  if (!isAvailable()) return false;
  const q = getQueue(queueName);
  if (!q) return false;
  try {
    const job = await q.getJob(jobId);
    if (job) { await job.remove(); return true; }
    return false;
  } catch (e) { return false; }
}

/**
 * Queue pause / resume
 */
async function pauseQueue(queueName)  {
  const q = getQueue(queueName);
  if (q) await q.pause();
}
async function resumeQueue(queueName) {
  const q = getQueue(queueName);
  if (q) await q.resume();
}

/**
 * একটি Queue-এর সব failed job drain করো (dead letter clean)
 */
async function drainFailed(queueName) {
  if (!isAvailable()) return 0;
  const q = getQueue(queueName);
  if (!q) return 0;
  try {
    const jobs = await q.getFailed(0, 999);
    for (const j of jobs) await j.remove().catch(() => {});
    return jobs.length;
  } catch (e) { return 0; }
}

/**
 * সামগ্রিক health summary
 */
async function getHealthSummary() {
  const stats = await getAllStats();
  const totalFailed  = stats.reduce((s, q) => s + q.failed,  0);
  const totalWaiting = stats.reduce((s, q) => s + q.waiting, 0);
  const totalActive  = stats.reduce((s, q) => s + q.active,  0);
  return {
    redisConnected: isAvailable(),
    totalQueues:    stats.length,
    totalFailed,
    totalWaiting,
    totalActive,
    healthy:        isAvailable() && totalFailed === 0,
    queues:         stats,
  };
}

module.exports = {
  getAllStats,
  getDeadLetterJobs,
  getQueueJobs,
  retryJob,
  removeJob,
  pauseQueue,
  resumeQueue,
  drainFailed,
  getHealthSummary,
};
