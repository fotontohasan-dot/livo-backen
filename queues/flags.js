// queues/flags.js
// BULLMQ_ENABLED=false দিলে Redis-ভিত্তিক BullMQ পুরোপুরি বন্ধ থাকে (কোনো Worker/QueueEvents/Queue নেই)।
// তখন api-log ও activity-log সরাসরি Postgres-এ ব্যাচ করে লেখা হয় (services/logBatcher.js);
// email/notification/fraud-scan আগের মতোই Postgres কিউ (services/queue.js) বা inline চলে।
// ডিফল্ট: চালু (আগের আচরণ অপরিবর্তিত)। প্রতিবার env পড়া হয় যাতে টেস্টে বদলানো যায়।
function bullmqEnabled() {
  return String(process.env.BULLMQ_ENABLED === undefined ? 'true' : process.env.BULLMQ_ENABLED).toLowerCase() !== 'false';
}

// Upstash-এ খরচ কমাতে BullMQ টিউনিং (শুধু BULLMQ_ENABLED=true থাকলে প্রযোজ্য)। সেট না থাকলে BullMQ-র ডিফল্ট।
function workerTuning() {
  const o = {};
  const drain = parseInt(process.env.BULLMQ_DRAIN_DELAY_S || '', 10);
  const stalled = parseInt(process.env.BULLMQ_STALLED_INTERVAL_MS || '', 10);
  if (drain > 0) o.drainDelay = drain;
  if (stalled > 0) o.stalledInterval = stalled;
  return o;
}
function queueEventsTuning() {
  const b = parseInt(process.env.BULLMQ_EVENTS_BLOCKING_TIMEOUT_MS || '', 10);
  return b > 0 ? { blockingTimeout: b } : {};
}

module.exports = { bullmqEnabled, workerTuning, queueEventsTuning };
