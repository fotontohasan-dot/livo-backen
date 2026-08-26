// services/userDeletion.js
// ---------------------------------------------------------------------------
// অ্যাডমিন ইউজার ডিলিশনের নিরাপদ বাস্তবায়ন।
//
// সমস্যা: users টেবিলের দিকে ২৯টা ফরেন কী RESTRICT (NO ACTION) — payment_requests,
// bets, referral_commissions, kyc_requests, loyalty_ledger ইত্যাদি। ফলে যেকোনো
// আর্থিক/অডিট রেকর্ডওয়ালা ইউজারের `DELETE FROM users` ব্যর্থ হয়, আর অ্যাডমিন শুধু
// "ডিলিট করতে সমস্যা!" দেখতেন — কী ঘটল বা কী করণীয়, কিছুই জানতেন না।
//
// সমাধান: FK দুর্বল করা হয়নি (আর্থিক ইতিহাস সুরক্ষিতই থাকে)। বদলে দুই-স্তরের আচরণ —
//
//   ১. সুরক্ষিত রেকর্ড না থাকলে → সত্যিকারের হার্ড ডিলিট (আগের আচরণ অক্ষত)।
//   ২. সুরক্ষিত রেকর্ড থাকলে   → অ্যাকাউন্ট অ্যানোনিমাইজ + নিষ্ক্রিয়:
//        • ব্যক্তিগত তথ্য (username/email/phone) প্লেসহোল্ডারে বদলে যায়, ফলে PII থাকে না
//          এবং ইউনিক আইডেন্টিফায়ারগুলো মুক্ত হয় (ব্যক্তি চাইলে আবার রেজিস্টার করতে পারেন);
//        • পাসওয়ার্ড এমন মানে সেট হয় যা কোনো bcrypt তুলনায় মিলবে না — লগইন অসম্ভব;
//        • is_banned = true → Phase 01-এর isAuth এনফোর্সমেন্ট সাথে সাথে কার্যকর;
//        • deleted_at সেট হয় → অ্যাকাউন্টটা "মুছে ফেলা" হিসেবে চিহ্নিত;
//        • সব সক্রিয় সেশন বাতিল (device_sessions + আসল session store);
//        • payment_requests, bets, coin_transactions — কোনো আর্থিক সারি স্পর্শ করা হয় না।
//
// সিদ্ধান্তটা ২৯টা টেবিল হাতে গুনে নয়, ট্রানজেকশনের ভেতরে সত্যিকারের DELETE চেষ্টা করে
// নেওয়া হয়। ব্যর্থ হলে (SQLSTATE 23503) rollback করে অ্যানোনিমাইজ করা হয়। এতে ভবিষ্যতে
// নতুন FK যোগ হলেও এই কোড আপনাআপনি সঠিক থাকে — কোনো তালিকা মেইনটেইন করতে হয় না।
// ---------------------------------------------------------------------------

const { pool } = require('../db');
const cache = require('./cache');
const cacheKeys = require('./cacheKeys');
const { revokeAllOtherSessions } = require('./deviceTracking');

const FK_VIOLATION = '23503';

// bcrypt hash-এর বৈধ ফরম্যাট নয়, তাই কোনো পাসওয়ার্ডের সাথেই ম্যাচ করবে না
const UNUSABLE_PASSWORD = '!deleted-account-no-login-possible!';

/**
 * ইউজারের সব সক্রিয় সেশন বাতিল করে (device_sessions + session store)।
 * currentSid হিসেবে খালি স্ট্রিং দেওয়া হয় যাতে কোনো সেশনই বাদ না পড়ে।
 */
async function revokeAllSessions(userId, actorLabel) {
  try {
    return await revokeAllOtherSessions(userId, '', actorLabel || 'ADMIN');
  } catch (err) {
    console.error('revokeAllSessions error:', err.message);
    return 0;
  }
}

/**
 * অ্যাকাউন্ট অ্যানোনিমাইজ ও নিষ্ক্রিয় করে। কোনো আর্থিক/অডিট সারি মোছে না।
 */
async function anonymizeUser(userId) {
  const result = await pool.query(
    `UPDATE users
        SET username   = 'deleted_user_' || id,
            email      = NULL,
            phone      = NULL,
            password   = $2,
            is_banned  = true,
            deleted_at = COALESCE(deleted_at, NOW())
      WHERE id = $1
      RETURNING id, username, deleted_at`,
    [userId, UNUSABLE_PASSWORD]
  );
  return result.rows[0] || null;
}

/**
 * ইউজার মোছার চেষ্টা করে; সুরক্ষিত রেকর্ড থাকলে অ্যানোনিমাইজ করে।
 *
 * @returns {Promise<{mode:'deleted'|'deactivated'|'not_found', username?:string, sessionsRevoked?:number}>}
 */
async function deleteOrDeactivateUser(userId, actorLabel) {
  const existing = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
  if (!existing.rows[0]) return { mode: 'not_found' };
  const username = existing.rows[0].username;

  // ডিলিট সফল হোক বা না হোক, সেশনগুলো দুই ক্ষেত্রেই বাতিল হওয়া উচিত
  const sessionsRevoked = await revokeAllSessions(userId, actorLabel);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
    await cache.del(cacheKeys.userActiveStatus(userId)).catch(() => {});
    return { mode: 'deleted', username, sessionsRevoked };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    if (err.code !== FK_VIOLATION) throw err; // অপ্রত্যাশিত ত্রুটি লুকানো হবে না

    // সুরক্ষিত রেকর্ড আছে — আর্থিক ইতিহাস অক্ষত রেখে অ্যাকাউন্ট নিষ্ক্রিয় করা হয়
    const anonymized = await anonymizeUser(userId);
    await cache.del(cacheKeys.userActiveStatus(userId)).catch(() => {});
    return {
      mode: 'deactivated',
      username,
      anonymizedAs: anonymized ? anonymized.username : null,
      sessionsRevoked,
      blockedBy: err.constraint || null
    };
  } finally {
    client.release();
  }
}

module.exports = { deleteOrDeactivateUser, anonymizeUser, revokeAllSessions, UNUSABLE_PASSWORD };
