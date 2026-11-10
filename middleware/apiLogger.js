const { enqueueApiLog } = require('../queues/producers');

/**
 * প্রতিটা API রিকোয়েস্ট api_usage_logs-এ লগ করে — কিন্তু রিকোয়েস্ট পাথে কোনো DB INSERT নেই।
 * লগ BullMQ "api-log" কিউতে (queues/processors/apiLog.js) পাঠানো হয়; INSERT করে worker।
 *
 * Bounded: একসাথে সর্বোচ্চ MAX_PENDING টা enqueue চলতে পারে। ওভারলোডে (Redis ধীর/ডাউন) অতিরিক্ত লগ
 * ফেলে দেওয়া হয় ও গোনা হয় (getApiLogStats().dropped) — রিকোয়েস্ট কখনো আটকায় না।
 * নোট: কিউ বন্ধ থাকলে (dev, Redis নেই) producer নিজেই inline লেখে — প্রোডাকশনে কিউ চালু থাকে।
 */
const MAX_PENDING = parseInt(process.env.API_LOG_MAX_PENDING || '500', 10);
// A1: সফল GET-গুলোর নমুনা (sampling) — ডিফল্ট ১ (সব লগ)। ট্র্যাফিক বেশি হলে API_LOG_SAMPLE_RATE=0.2 ইত্যাদি দিন;
// ব্যর্থ (≥400) ও non-GET রিকোয়েস্ট সবসময় লগ হয়।
const SAMPLE_RATE = Math.min(1, Math.max(0, Number(process.env.API_LOG_SAMPLE_RATE === undefined ? 1 : process.env.API_LOG_SAMPLE_RATE)));
const stats = { enqueued: 0, dropped: 0, failed: 0, sampledOut: 0 };
let pending = 0;
let lastDropWarnAt = 0;

function noteDrop() {
  stats.dropped++;
  const now = Date.now();
  if (now - lastDropWarnAt > 60000) { // সর্বোচ্চ মিনিটে একবার সতর্কবার্তা
    lastDropWarnAt = now;
    console.warn(`[api-log] overload: ${stats.dropped} log(s) dropped so far (pending=${pending}, cap=${MAX_PENDING})`);
  }
}

function apiUsageLogger(req, res, next) {
  const start = Date.now();

  const originalEnd = res.end;
  res.end = function (...args) {
    const payload = {
      apiKeyId: req.apiKey ? req.apiKey.id : null,
      userId: (req.session && req.session.user) ? req.session.user.id : (req.user ? req.user.id : null),
      ip: req.ip || req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress) || null,
      // কোয়েরি-স্ট্রিং বাদ: টোকেন/কোড থাকতে পারে (gateway.js-এর লগিংয়ের মতোই)
      endpoint: String(req.originalUrl || req.url || '').split('?')[0].slice(0, 500),
      method: req.method || 'GET',
      statusCode: res.statusCode || 200,
      responseTimeMs: Date.now() - start,
      userAgent: req.headers['user-agent'] || null
    };

    if (SAMPLE_RATE < 1 && payload.method === 'GET' && payload.statusCode < 400 && Math.random() >= SAMPLE_RATE) {
      stats.sampledOut++;
    } else if (pending >= MAX_PENDING) {
      noteDrop();
    } else {
      pending++;
      // setImmediate: রেসপন্স ফ্লাশ হওয়ার পরে; enqueue-এর কোনো ফল রিকোয়েস্টে ফেরে না
      setImmediate(() => {
        enqueueApiLog(payload)
          .then((r) => { if (r && r.dropped) { stats.dropped++; } else { stats.enqueued++; } })
          .catch((err) => { stats.failed++; console.error('API usage log enqueue error:', err.message); })
          .finally(() => { pending--; });
      });
    }

    return originalEnd.apply(this, args);
  };

  next();
}

function getApiLogStats() {
  return { ...stats, pending, maxPending: MAX_PENDING };
}

module.exports = { apiUsageLogger, getApiLogStats };
