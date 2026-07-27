// worker.js
// ==================== ব্যাকগ্রাউন্ড জব-কিউ ওয়ার্কার (আলাদা কন্টেইনার/প্রসেস) ====================
// app.js নিজেই ইন-প্রসেস কিউ ওয়ার্কার চালাতে পারে (QUEUE_ENABLED=true থাকলে), কিন্তু
// Docker Compose সেটআপে "queue" নামে আলাদা কন্টেইনারে এই ফাইলটা চালানো হয় যাতে
// ওয়েব সার্ভার ও ব্যাকগ্রাউন্ড জব প্রসেসিং একে অপরকে প্রভাবিত না করে (আলাদা স্কেলিং, আলাদা ক্র্যাশ-ডোমেইন)।
//
// এই ফাইলে কোনো Express/HTTP সার্ভার নেই — শুধু DB কানেকশন, জব-হ্যান্ডলার রেজিস্ট্রেশন,
// আর কিউ ওয়ার্কার লুপ। Docker HEALTHCHECK-এর জন্য একটা ছোট্ট HTTP এন্ডপয়েন্ট চালু রাখা হয়েছে
// (শুধু liveness জানানোর জন্য, অ্যাপ্লিকেশন ট্রাফিক সার্ভ করে না)।

require('dotenv').config();
const http = require('http');

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [worker] Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ [worker] Uncaught Exception:', err && err.stack ? err.stack : err);
});

const { connectDB } = require('./db');
const queue = require('./services/queue');

const HEALTH_PORT = process.env.WORKER_HEALTH_PORT || 3001;

async function start() {
  console.log('🚀 [worker] শুরু হচ্ছে ব্যাকগ্রাউন্ড জব-কিউ ওয়ার্কার...');

  await connectDB();

  // হ্যান্ডলার রেজিস্টার করে (matchUpdater, notification, email ইত্যাদি জব-টাইপের জন্য)
  require('./services/queueHandlers');
  queue.startWorker();

  // হালকা health-check সার্ভার — শুধু Docker HEALTHCHECK-এর জন্য, অ্যাপ ট্রাফিকের জন্য না
  http.createServer((req, res) => {
    if (req.url === '/health') {
      const status = queue.getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...status }));
      return;
    }
    res.writeHead(404);
    res.end();
  }).listen(HEALTH_PORT, () => {
    console.log(`✅ [worker] health check সার্ভার চালু হয়েছে পোর্ট ${HEALTH_PORT}-এ`);
  });
}

start().catch((err) => {
  console.error('❌ [worker] শুরু করতে ব্যর্থ:', err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`🛑 [worker] ${signal} পেয়েছে, বন্ধ হচ্ছে...`);
  queue.stopWorker();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
