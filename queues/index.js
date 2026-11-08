// queues/index.js
// পুরো Background Queue System-এর একমাত্র entry point।
// app.js থেকে শুধু initQueueSystem() কল করলেই যথেষ্ট।

const { connectQueueRedis, closeQueueRedis, isQueueEnabled } = require('./connection');
const { closeQueues } = require('./definitions');
const { startWorkers, stopWorkers } = require('./workers');
const { startDeadLetterListeners, stopDeadLetterListeners } = require('./deadLetter');

// PROCESS_ROLE ভাগ: web শুধু producer (enqueue) হিসেবে Redis-এ সংযুক্ত হয়,
// worker consumer চালায়। `all` দুটোই করে (initQueueSystem — আগের আচরণ)।
async function initQueueProducers() {
  const connected = await connectQueueRedis();
  if (!connected) {
    console.warn('⚠️ Queue System চালু হয়নি (Redis অনুপলব্ধ) — সব Background Job সরাসরি (inline) মোডে চলবে।');
  }
  return connected;
}

async function startQueueConsumers() {
  const connected = await initQueueProducers();
  if (!connected) return false;
  startWorkers();
  startDeadLetterListeners();
  console.log('🚀 Background Queue System চালু হয়েছে (Email, Notification, Activity Log, API Log, Fraud Scan)');
  return true;
}

async function stopQueueConsumers() {
  await stopWorkers();
  await stopDeadLetterListeners();
}

async function initQueueSystem() {
  return startQueueConsumers();
}

// consumer বন্ধ + producer Queue instance ও shared Redis connection বন্ধ
async function shutdownQueueSystem() {
  await stopQueueConsumers();
  await closeQueues();
  await closeQueueRedis();
}

module.exports = {
  initQueueSystem,
  initQueueProducers,
  startQueueConsumers,
  stopQueueConsumers,
  shutdownQueueSystem,
  isQueueEnabled,
  ...require('./producers'),
  ...require('./health'),
  ...require('./deadLetter')
};
