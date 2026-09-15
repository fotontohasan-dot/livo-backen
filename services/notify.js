// services/notify.js
// ---------------------------------------------------------------------------
// কেন্দ্রীয় নোটিফিকেশন হেল্পার। বিদ্যমান architecture অনুসরণ করে বানানো:
//   - services/socket.js-এর মতোই lazy `io` reference (initNotifyIo দিয়ে সেট হয়)
//   - notifications টেবিল (আগে থেকেই আছে, migrations.js) — অফলাইন ইউজারের জন্য
//     DB-তে সংরক্ষিত থাকে, পরে লগইন করলে history/unread count-এ দেখা যায়
//   - অনলাইন থাকলে io.to(`user:${id}`) রুমে সরাসরি রিয়েল-টাইম push হয় (এই রুমে
//     services/socket.js ইতিমধ্যেই session-authenticated ইউজারকে জয়েন করায়)
//
// type: 'deposit' | 'withdraw' | 'bet' | 'security' | 'announcement' | 'system' | 'info' | 'success' | 'error'
// ---------------------------------------------------------------------------
const { pool } = require('../db');

let io = null;
function initNotifyIo(socketIoInstance) {
  io = socketIoInstance;
}

// ইতিমধ্যে DB-তে ইনসার্ট হয়ে যাওয়া একটা নোটিফিকেশন রো-কে রিয়েল-টাইম emit করা
// (যেমন creditApprovedDeposit-এর মতো ট্রানজেকশনের ভেতরে ইনসার্ট হওয়া রো, COMMIT-এর পর emit করতে হয়)
function emitToUser(userId, notificationRow) {
  if (!io || !userId || !notificationRow) return;
  try {
    io.to(`user:${userId}`).emit('notification', {
      id: notificationRow.id,
      title: notificationRow.title,
      message: notificationRow.message,
      type: notificationRow.type,
      is_read: !!notificationRow.is_read,
      created_at: notificationRow.created_at,
    });
  } catch (err) {
    console.error('notify emitToUser error:', err.message);
  }
}

// নতুন নোটিফিকেশন — DB-তে সেভ + (ইউজার অনলাইন থাকলে) রিয়েল-টাইম push, দুটোই একসাথে
// category: 'reward' | 'mission' | 'message' | 'general' — মেম্বার সেন্টারের কোন আইকনের
// ব্যাজে এই নোটিফিকেশনটা গণনা হবে তা নির্ধারণ করে (দেখুন getBadgeCounts)।
async function notifyUser(userId, { title, message, type = 'info', category = 'general' } = {}) {
  if (!userId) return null;
  try {
    const result = await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, category) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, title || '', message || '', type, category]
    );
    const row = result.rows[0];
    emitToUser(userId, row);
    emitBadgeUpdate(userId);
    return row;
  } catch (err) {
    console.error('notifyUser error:', err.message);
    return null;
  }
}

// ===== রিয়েল-টাইম ব্যাজ সিস্টেম =====
// মেম্বার সেন্টারের 'রিওয়ার্ড সেন্টার', 'মিশন' ও 'ইনটারনাল মেসেজ' আইকনের আনরিড সংখ্যা +
// প্রোফাইল আইকনের মাস্টার ব্যাজ (সবগুলোর যোগফল)। notifications টেবিলের category কলাম দিয়ে
// reward/mission গণনা হয়; ইনটারনাল মেসেজ chat_messages টেবিলের admin→user আনরিড রো থেকে।
async function getBadgeCounts(userId) {
  if (!userId) return { reward: 0, mission: 0, message: 0, total: 0 };
  try {
    const [notifRes, msgRes] = await Promise.all([
      pool.query(
        `SELECT category, COUNT(*)::int AS count
         FROM notifications
         WHERE user_id = $1 AND is_read = false AND category IN ('reward','mission')
         GROUP BY category`,
        [userId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM chat_messages
         WHERE receiver_id = $1 AND is_admin = true AND is_read = false`,
        [userId]
      ),
    ]);

    const counts = { reward: 0, mission: 0 };
    for (const row of notifRes.rows) {
      if (row.category === 'reward') counts.reward = row.count;
      if (row.category === 'mission') counts.mission = row.count;
    }
    const messageCount = msgRes.rows[0] ? msgRes.rows[0].count : 0;

    return {
      reward: counts.reward,
      mission: counts.mission,
      message: messageCount,
      total: counts.reward + counts.mission + messageCount,
    };
  } catch (err) {
    console.error('getBadgeCounts error:', err.message);
    return { reward: 0, mission: 0, message: 0, total: 0 };
  }
}

// আনরিড সংখ্যা পুনরায় গণনা করে সেই ইউজারের রুমে push করে — নোটিফিকেশন তৈরি হওয়া,
// অ্যাডমিনের মেসেজ পাঠানো, বা কোনো কিছু "read" হিসেবে চিহ্নিত হওয়ার পরে ডাকা হয়,
// যাতে সব ট্যাব/ডিভাইসে ব্যাজ সাথে সাথে সিঙ্ক থাকে।
async function emitBadgeUpdate(userId) {
  if (!io || !userId) return;
  try {
    const counts = await getBadgeCounts(userId);
    io.to(`user:${userId}`).emit('badges:update', counts);
  } catch (err) {
    console.error('emitBadgeUpdate error:', err.message);
  }
}

// অ্যাডমিন ব্রডকাস্ট — সব ইউজারের জন্য একসাথে (DB-তে প্রতিটা ইউজারের জন্য একটা করে রো,
// অফলাইন ইউজাররাও পরে লগইন করলে দেখতে পাবে; অনলাইন সবাইকে সাথে সাথে push)
async function broadcastToAllUsers({ title, message, type = 'announcement', category = 'message' } = {}) {
  try {
    const result = await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, category)
       SELECT id, $1, $2, $3, $4 FROM users
       RETURNING user_id, id, title, message, type, is_read, created_at`,
      [title || '', message || '', type, category]
    );
    if (io) {
      try {
        io.emit('notification', {
          id: null, // ব্রডকাস্ট — নির্দিষ্ট একটা id নয়, ক্লায়েন্ট নতুন করে count/history রিফ্রেশ করবে
          title,
          message,
          type,
          category,
          is_read: false,
          created_at: new Date(),
          broadcast: true,
        });
        // ব্রডকাস্ট সব অনলাইন ইউজারের কাছে যায় — প্রতিটার জন্য আলাদা করে DB থেকে গুনে
        // পাঠানো ব্যয়বহুল, তাই ক্লায়েন্টকে শুধু ইঙ্গিত দেওয়া হচ্ছে যে ব্যাজ রিফ্রেশ করতে হবে
        // (client badges:refresh ইভেন্ট শুনে /notifications/badges থেকে প্রকৃত সংখ্যা আনবে)।
        io.emit('badges:refresh', { category });
      } catch (err) {
        console.error('broadcast emit error:', err.message);
      }
    }
    return result.rowCount;
  } catch (err) {
    console.error('broadcastToAllUsers error:', err.message);
    return 0;
  }
}

// অ্যাডমিন প্যানেলে রিয়েল-টাইম নোটিফিকেশন — services/socket.js-এর emitAdminAlert-এর
// পরিপূরক (deposit/withdraw/chat আগে থেকেই কভার করা, security/system/announcement যোগ)
function notifyAdmins(type, { title, message } = {}) {
  if (!io) return;
  try {
    io.to('admins').emit('admin_alert', { type, title: title || '', message: message || '', createdAt: new Date() });
  } catch (err) {
    console.error('notifyAdmins error:', err.message);
  }
}

module.exports = { initNotifyIo, notifyUser, emitToUser, broadcastToAllUsers, notifyAdmins, getBadgeCounts, emitBadgeUpdate };
