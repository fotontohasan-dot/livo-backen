// services/auditLog.js
// একমাত্র জায়গা যেখানে অ্যাডমিন/সিস্টেম অ্যাকশন admin_logs টেবিলে লেখা হয়।
// আগে এই একই লজিক routes/admin.js এবং services/fraudDetection.js — দুই জায়গায় ডুপ্লিকেট ছিল।
// এখন থেকে সবাই এখান থেকে ইম্পোর্ট করে (fraudDetection.js ব্যাকওয়ার্ড কম্প্যাটিবিলিটির জন্য re-export করে)।

const { pool } = require('../db');
const queue = require('./queue');

async function logAdminAction(adminId, adminUsername, actionType, details, ip = null) {
  const jobId = await queue.enqueue('audit_log', { adminId, adminUsername, actionType, details, ip });
  if (jobId) return; // কিউতে জমা হয়ে গেছে, ওয়ার্কার এটা প্রসেস করবে

  // কিউ এনকিউ ব্যর্থ হলে (যেমন DB সাময়িক আনরিচেবল) — সরাসরি লিখে ফেলা হচ্ছে যাতে অডিট লগ কখনো হারিয়ে না যায়
  try {
    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action_type, details, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminId, adminUsername, actionType, details, ip]
    );
  } catch (err) {
    console.error('Admin Log Error (queue + direct write both failed):', err.message);
  }
}

module.exports = { logAdminAction };
