// queues/health.js
const { QUEUE_NAMES, getQueue } = require('./definitions');
const { isQueueEnabled } = require('./connection');

// প্রতিটা Queue-এর waiting/active/completed/failed/delayed count এবং overall health
async function getQueueHealthStats() {
  const enabled = isQueueEnabled();
  const stats = [];

  for (const name of Object.values(QUEUE_NAMES)) {
    const queue = getQueue(name);
    if (!queue || !enabled) {
      stats.push({ name, enabled: false, counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 } });
      continue;
    }
    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
      const isPaused = await queue.isPaused();
      stats.push({ name, enabled: true, paused: isPaused, counts });
    } catch (err) {
      stats.push({ name, enabled: true, error: err.message, counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 } });
    }
  }

  return { redisConnected: enabled, queues: stats };
}

async function getRecentJobs(queueName, state = 'failed', limit = 20) {
  const queue = getQueue(queueName);
  if (!queue) return [];
  const methodMap = {
    waiting: 'getWaiting',
    active: 'getActive',
    completed: 'getCompleted',
    failed: 'getFailed',
    delayed: 'getDelayed'
  };
  const method = methodMap[state] || 'getFailed';
  const jobs = await queue[method](0, limit - 1);
  return jobs.map((j) => ({
    id: j.id,
    name: j.name,
    data: j.data,
    attemptsMade: j.attemptsMade,
    timestamp: j.timestamp,
    failedReason: j.failedReason || null
  }));
}

module.exports = { getQueueHealthStats, getRecentJobs };
