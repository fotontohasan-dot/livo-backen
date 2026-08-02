// services/queueHandlers.js
// প্রতিটা জব টাইপের জন্য প্রকৃত কাজ করার হ্যান্ডলার এখানে রেজিস্টার করা হয়।
// app.js বুট হওয়ার সময় একবার require('./services/queueHandlers') করলেই সব হ্যান্ডলার রেজিস্টার হয়ে যায়।

const { pool } = require('../db');
const queue = require('./queue');
const emailService = require('./email');
const { notifyTelegram } = require('./telegramNotify');

// ==================== EMAIL (OTP, ভেরিফিকেশন, পাসওয়ার্ড রিসেট — সব একই 'email' টাইপে, payload.kind দিয়ে আলাদা) ====================
queue.registerHandler('email', async (payload) => {
  const { kind, to } = payload;
  if (!to) throw new Error('email job payload-এ "to" নেই');

  switch (kind) {
    case 'otp':
      await emailService.sendOTP(to, payload.otp);
      break;
    case 'password_reset':
      await emailService.sendPasswordReset(to, payload.resetUrl);
      break;
    case 'verification':
      await emailService.sendVerificationEmail(to, payload.verifyUrl);
      break;
    default:
      throw new Error(`অজানা email job kind: "${kind}"`);
  }
});

// ==================== NOTIFICATION (in-app notifications টেবিলে ইনসার্ট + Telegram) ====================
queue.registerHandler('notification', async (payload) => {
  const { userIds, title, message, telegramText } = payload;
  if (Array.isArray(userIds) && userIds.length) {
    for (const uid of userIds) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'info')`,
        [uid, title, message]
      );
    }
  }
  if (telegramText) {
    await notifyTelegram(telegramText);
  }
});

// ==================== AUDIT LOG (admin_logs টেবিলে ইনসার্ট) ====================
queue.registerHandler('audit_log', async (payload) => {
  const { adminId, adminUsername, actionType, details, ip } = payload;
  await pool.query(
    `INSERT INTO admin_logs (admin_id, admin_username, action_type, details, ip_address) VALUES ($1,$2,$3,$4,$5)`,
    [adminId || null, adminUsername || 'SYSTEM', actionType, details, ip || null]
  );
});

// ==================== API LOG (api_usage_logs টেবিলে ইনসার্ট) ====================
queue.registerHandler('api_log', async (payload) => {
  const { apiKeyId, userId, ip, endpoint, method, statusCode, responseTimeMs, userAgent } = payload;
  await pool.query(
    `INSERT INTO api_usage_logs
     (api_key_id, user_id, ip, endpoint, method, status_code, response_time_ms, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [apiKeyId || null, userId || null, ip || null, (endpoint || '').slice(0, 500), method || 'GET', statusCode || 200, responseTimeMs || 0, userAgent || null]
  );
});

// ==================== FRAUD SCAN (রেজিস্ট্রেশন/লগইন/ট্রানজ্যাকশন-এর ফ্রড ইভালুয়েশন ব্যাকগ্রাউন্ডে চালায়) ====================
queue.registerHandler('fraud_scan', async (payload) => {
  const fraudDetection = require('./fraudDetection'); // circular-require এড়াতে lazy require
  const { kind } = payload;
  switch (kind) {
    case 'registration':
      await fraudDetection.evaluateRegistration(payload.userId, payload.args);
      break;
    case 'login':
      await fraudDetection.evaluateLogin(payload.userId, payload.args);
      break;
    case 'failed_login':
      await fraudDetection.evaluateFailedLogin(payload.identifier, payload.userId, payload.ip, payload.userAgent);
      break;
    case 'transaction':
      await fraudDetection.evaluateTransaction(payload.userId, payload.txType, payload.args);
      break;
    default:
      throw new Error(`অজানা fraud_scan job kind: "${kind}"`);
  }
});

module.exports = {}; // require করলেই উপরের registerHandler কলগুলো চলে — কোনো এক্সপোর্ট লাগে না
