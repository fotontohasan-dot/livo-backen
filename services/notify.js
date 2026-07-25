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
async function notifyUser(userId, { title, message, type = 'info' } = {}) {
  if (!userId) return null;
  try {
    const result = await pool.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1,$2,$3,$4) RETURNING *`,
      [userId, title || '', message || '', type]
    );
    const row = result.rows[0];
    emitToUser(userId, row);
    return row;
  } catch (err) {
    console.error('notifyUser error:', err.message);
    return null;
  }
}

// অ্যাডমিন ব্রডকাস্ট — সব ইউজারের জন্য একসাথে (DB-তে প্রতিটা ইউজারের জন্য একটা করে রো,
// অফলাইন ইউজাররাও পরে লগইন করলে দেখতে পাবে; অনলাইন সবাইকে সাথে সাথে push)
async function broadcastToAllUsers({ title, message, type = 'announcement' } = {}) {
  try {
    const result = await pool.query(
      `INSERT INTO notifications (user_id, title, message, type)
       SELECT id, $1, $2, $3 FROM users
       RETURNING user_id, id, title, message, type, is_read, created_at`,
      [title || '', message || '', type]
    );
    if (io) {
      try {
        io.emit('notification', {
          id: null, // ব্রডকাস্ট — নির্দিষ্ট একটা id নয়, ক্লায়েন্ট নতুন করে count/history রিফ্রেশ করবে
          title,
          message,
          type,
          is_read: false,
          created_at: new Date(),
          broadcast: true,
        });
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

module.exports = { initNotifyIo, notifyUser, emitToUser, broadcastToAllUsers, notifyAdmins };
