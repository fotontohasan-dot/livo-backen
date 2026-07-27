// queues/index.js
// পুরো Background Queue System-এর একমাত্র entry point।
// app.js থেকে শুধু initQueueSystem() কল করলেই যথেষ্ট।

const { connectQueueRedis, isQueueEnabled } = require('./connection');
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

async function shutdownQueueSystem() {
  await stopWorkers();
  await stopDeadLetterListeners();
}

module.exports = {
  initQueueSystem,
  shutdownQueueSystem,
  isQueueEnabled,
  ...require('./producers'),
  ...require('./health'),
  ...require('./deadLetter')
};
