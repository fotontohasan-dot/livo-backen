// queues/index.js
// পুরো Background Queue System-এর একমাত্র entry point।
// app.js থেকে শুধু initQueueSystem() কল করলেই যথেষ্ট।

const { connectQueueRedis, closeQueueRedis, isQueueEnabled } = require('./connection');
const { queues } = require('./definitions');
const { startWorkers, stopWorkers } = require('./workers');
const { startDeadLetterListeners, stopDeadLetterListeners } = require('./deadLetter');

async function initQueueSystem() {
  const connected = await connectQueueRedis();
  if (!connected) {
    console.warn('⚠️ Queue System চালু হয়নি (Redis অনুপলব্ধ) — সব Background Job সরাসরি (inline) মোডে চলবে।');
    return false;
  }
  startWorkers();
  startDeadLetterListeners();
  console.log('🚀 Background Queue System চালু হয়েছে (Email, Notification, Activity Log, API Log, Fraud Scan)');
  return true;
}

// PROCESS_ROLE=web — শুধু PRODUCER দিক: Redis-এ সংযোগ হয় যাতে add() কাজ করে,
// কিন্তু কোনো Worker/QueueEvents consumer চালু হয় না।
async function initQueueProducers() {
  const connected = await connectQueueRedis();
  if (!connected) {
    console.warn('⚠️ Queue producers চালু হয়নি (Redis অনুপলব্ধ) — জব inline মোডে চলবে।');
    return false;
  }
  console.log('📤 Queue producers প্রস্তুত (consumer এই প্রসেসে চালু নেই)');
  return true;
}

let queueShutdownPromise = null;
// consumer থামায় → Queue handle বন্ধ → Redis কানেকশন বন্ধ। একাধিকবার ডাকলে একবারই চলে।
function shutdownQueueSystem() {
  if (!queueShutdownPromise) {
    queueShutdownPromise = (async () => {
      await stopWorkers().catch((e) => console.error('[queues] stopWorkers:', e.message));
      await stopDeadLetterListeners().catch((e) => console.error('[queues] stopDeadLetterListeners:', e.message));
      await Promise.all(Object.values(queues).map((q) => q.close().catch(() => {})));
      await closeQueueRedis();
    })();
  }
  return queueShutdownPromise;
}

module.exports = {
  initQueueSystem,
  initQueueProducers,
  shutdownQueueSystem,
  isQueueEnabled,
  ...require('./producers'),
  ...require('./health'),
  ...require('./deadLetter')
};
