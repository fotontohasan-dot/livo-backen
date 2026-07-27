// queues/definitions.js
// সব Queue-এর সংজ্ঞা একটাই জায়গায় — নতুন কোনো Background Job লাগলে এখানে যোগ করলেই হবে।

const { Queue } = require('bullmq');
const { connection, isQueueEnabled } = require('./connection');

const QUEUE_NAMES = {
  EMAIL: 'email',
  NOTIFICATION: 'notification',
  ACTIVITY_LOG: 'activity-log',
  API_LOG: 'api-log',
  FRAUD_SCAN: 'fraud-scan'
};

// ডিফল্ট Job অপশন — Retry + Backoff + পুরনো কমপ্লিটেড জব অটো-ক্লিনআপ।
// removeOnFail: false রাখা হয়েছে যাতে সব রিট্রাই শেষ হয়ে যাওয়া (dead) জবগুলো
// deadLetter.js হ্যান্ডলার নিজে Postgres-এ সরিয়ে নেওয়ার আগ পর্যন্ত Redis-এ থেকে যায়।
const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 3000 },
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 2000, age: 7 * 24 * 3600 }
};

const queues = {};

if (isQueueEnabled() || connection) {
  // connection object তৈরি থাকলেও (এখনও connect না হলেও) BullMQ নিজে lazy কানেক্ট করে নেয়,
  // তাই connection থাকলেই Queue instance বানানো নিরাপদ।
  Object.values(QUEUE_NAMES).forEach((name) => {
    queues[name] = new Queue(name, { connection, defaultJobOptions });
  });
}

function getQueue(name) {
  return queues[name] || null;
}

module.exports = { QUEUE_NAMES, defaultJobOptions, queues, getQueue };
