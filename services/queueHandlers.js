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
    case 'new_device':
      await emailService.sendNewDeviceAlert(to, {
        username: payload.username,
        deviceName: payload.deviceName,
        ip: payload.ip,
        location: payload.location,
        time: payload.time
      });
      break;
    default:
      throw new Error(`অজানা email job kind: "${kind}"`);
  }
});

// ==================== NOTIFICATION (in-app notifications টেবিলে ইনসার্ট + Telegram) ====================
// আগে userIds-এর জন্য একটা লুপে আলাদা আলাদা INSERT চলত। জব ব্যর্থ হলে (queue.js পুরো জবটাই
// রিট্রাই করে, সর্বোচ্চ ৩ বার) লুপের মাঝপথে-ব্যর্থ হওয়া অংশ retry-তে আবার ইনসার্ট হতো —
// আগেই সফলভাবে insert হওয়া userId-গুলোর জন্য ডুপ্লিকেট নোটিফিকেশন রো তৈরি হতো। এখন একটাই
// atomic multi-row INSERT (UNNEST), তাই আংশিক-সম্পন্ন অবস্থা সম্ভবই না — হয় সবগুলো insert
// হয়, নাহলে একটাও না। Telegram পাঠানো ব্যর্থ হলেও (ইনসার্ট ইতিমধ্যে সফল হয়ে থাকলে) পুরো জব
// রিট্রাই করা হয় না — শুধু লগ হয়, নাহলে retry-তে আগের ইনসার্টগুলো আবার ডুপ্লিকেট হতো।
queue.registerHandler('notification', async (payload) => {
  const { userIds, title, message, telegramText, telegramCategory } = payload;
  if (Array.isArray(userIds) && userIds.length) {
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type)
       SELECT uid, $2, $3, 'info' FROM UNNEST($1::int[]) AS uid`,
      [userIds, title, message]
    );
  }
  if (telegramText) {
    await notifyTelegram(telegramText, { category: telegramCategory }).catch(e => console.error('notification job telegram error:', e.message));
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
