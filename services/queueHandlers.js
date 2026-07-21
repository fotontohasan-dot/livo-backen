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

module.exports = {}; // require করলেই উপরের registerHandler কলগুলো চলে — কোনো এক্সপোর্ট লাগে না
