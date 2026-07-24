// queues/processors/notification.js
const { pool } = require('../../db');
const { sendPushToAdmins } = require('../../services/push');
const { notifyTelegram } = require('../../services/telegramNotify');

async function processNotificationJob(job) {
  const { data, name } = job;

  // ইন-অ্যাপ নোটিফিকেশন (notifications টেবিল) + Telegram — নির্দিষ্ট userIds টার্গেট করা হলে
  if (Array.isArray(data.userIds) && data.userIds.length) {
    for (const uid of data.userIds) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'info')`,
        [uid, data.title, data.message]
      );
    }
    if (data.telegramText) await notifyTelegram(data.telegramText);
  }

  // ব্রাউজার/মোবাইল Web Push — সব সাবস্ক্রাইবড অ্যাডমিনকে
  await sendPushToAdmins(name, data.title, data.message);
}

module.exports = { processNotificationJob };
