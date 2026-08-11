/**
 * services/withdrawPin.js
 * ---------------------------------------------------------------------------
 * Enterprise Withdraw PIN নিরাপত্তা স্তর — services/twofactor.js এর প্যাটার্ন
 * অনুসরণ করে বানানো (bcrypt হ্যাশিং, বিদ্যমান dependency, db.js এর pool)।
 *
 * - PIN কখনো plain text এ রাখা হয় না, শুধু bcrypt হ্যাশ (users.withdraw_pin_hash)
 * - দুর্বল/অনুমানযোগ্য PIN (একই ডিজিট, ক্রমিক প্যাটার্ন) প্রত্যাখ্যান করা হয়
 * - ৫ বার ভুল ভেরিফিকেশনে ১৫ মিনিটের জন্য লক হয়ে যায়
 * - প্রতিটি ইভেন্ট withdraw_pin_logs টেবিলে অডিট লগ হিসেবে রেকর্ড হয়
 * ---------------------------------------------------------------------------
 */

const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const auditLog = require('./auditLog');

const PIN_LENGTH = 6;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // ১৫ মিনিট

const PIN_REGEX = /^\d{6}$/;

// ==================== দুর্বল PIN শনাক্তকরণ ====================
// প্রত্যাখ্যান করা হয়: একই ডিজিট ৬ বার (000000...999999) এবং
// ক্রমিক আরোহী/অবরোহী প্যাটার্ন (123456, 654321, 234567, 987654 ইত্যাদি — সব সম্ভাব্য শিফট)
function isWeakPin(pin) {
  if (typeof pin !== 'string' || !PIN_REGEX.test(pin)) return true;

  // সব ডিজিট একই
  if (/^(\d)\1{5}$/.test(pin)) return true;

  // ক্রমিক আরোহী/অবরোহী প্যাটার্ন
  const digits = pin.split('').map(Number);
  let ascending = true;
  let descending = true;
  for (let i = 1; i < digits.length; i++) {
    if (digits[i] !== digits[i - 1] + 1) ascending = false;
    if (digits[i] !== digits[i - 1] - 1) descending = false;
  }
  if (ascending || descending) return true;

  return false;
}

async function hashPin(pin) {
  return bcrypt.hash(pin, 10);
}

async function comparePin(pin, hash) {
  if (!hash || typeof pin !== 'string' || !PIN_REGEX.test(pin)) return false;
  return bcrypt.compare(pin, hash);
}

function isLocked(user) {
  return !!(user && user.withdraw_pin_locked_until && new Date(user.withdraw_pin_locked_until) > new Date());
}

function lockRemainingMs(user) {
  if (!isLocked(user)) return 0;
  return new Date(user.withdraw_pin_locked_until).getTime() - Date.now();
}

// ==================== অডিট লগ হেল্পার ====================
// Created / Changed / Reset / Failed Verification / Successful Verification / Admin Reset
async function logPinEvent(userId, actionType, opts = {}) {
  const { actorType = 'user', actorId = null, actorUsername = null, ip = null } = opts;
  try {
    const inserted = await pool.query(
      `INSERT INTO withdraw_pin_logs (user_id, action_type, actor_type, actor_id, actor_username, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, actionType, actorType, actorId, actorUsername, ip]
    );
    // পুরনো/legacy withdraw_pin_logs টেবিলে (উপরে) ইতিমধ্যে সঠিকভাবে রেকর্ড হয়েছে — এটা এখন
    // কেন্দ্রীয় audit_logs টেবিলেও (Admin প্যানেলের একীভূত Audit Log সার্চ/এক্সপোর্ট যা ব্যবহার করে)
    // মিরর করা হচ্ছে। আগে এখানে auditLog.logWithdrawPin() কল হতো যেটা কখনো এক্সপোর্টই করা ছিল না
    // (শুধু logEvent() আছে) — ফলে এই ইভেন্টগুলো কেন্দ্রীয় audit log-এ কখনো দেখা যেত না।
    await auditLog.logEvent({
      actorType, actorId, actorUsername,
      action: `withdraw_pin_${actionType}`.toLowerCase(),
      category: 'security',
      riskLevel: actionType === 'RESET' || actionType === 'ADMIN_RESET' ? 'medium' : 'low',
      details: { userId, actionType, legacyId: inserted.rows[0]?.id }
    });
  } catch (e) {
    console.error('withdraw pin audit log error:', e.message);
  }
}

// ==================== PIN তৈরি (প্রথমবার) ====================
async function createPin(userId, pin, ip) {
  const hash = await hashPin(pin);
  await pool.query(
    `UPDATE users SET withdraw_pin_hash=$1, withdraw_pin_created_at=NOW(), withdraw_pin_updated_at=NOW(),
      withdraw_pin_failed_attempts=0, withdraw_pin_locked_until=NULL WHERE id=$2`,
    [hash, userId]
  );
  await logPinEvent(userId, 'created', { ip });
}

// ==================== PIN আপডেট (change/reset — actionType দিয়ে আলাদা করা হয়) ====================
async function updatePin(userId, pin, ip, actionType = 'changed') {
  const hash = await hashPin(pin);
  await pool.query(
    `UPDATE users SET withdraw_pin_hash=$1, withdraw_pin_updated_at=NOW(),
      withdraw_pin_failed_attempts=0, withdraw_pin_locked_until=NULL WHERE id=$2`,
    [hash, userId]
  );
  await logPinEvent(userId, actionType, { ip });
}

// ==================== PIN ভেরিফিকেশন (লক-আউট লজিকসহ) ====================
// রিটার্ন: { success, notConfigured?, locked?, remainingMs?, attemptsLeft? }
async function verifyPin(userId, pin, ip) {
  const result = await pool.query(
    `SELECT withdraw_pin_hash, withdraw_pin_failed_attempts, withdraw_pin_locked_until
     FROM users WHERE id=$1`,
    [userId]
  );
  const user = result.rows[0];

  if (!user || !user.withdraw_pin_hash) {
    return { success: false, notConfigured: true };
  }

  if (isLocked(user)) {
    return { success: false, locked: true, remainingMs: lockRemainingMs(user) };
  }

  const match = await comparePin(pin, user.withdraw_pin_hash);

  if (match) {
    await pool.query(
      `UPDATE users SET withdraw_pin_failed_attempts=0, withdraw_pin_locked_until=NULL WHERE id=$1`,
      [userId]
    );
    await logPinEvent(userId, 'verify_success', { ip });
    return { success: true };
  }

  const attempts = (user.withdraw_pin_failed_attempts || 0) + 1;

  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
    await pool.query(
      `UPDATE users SET withdraw_pin_failed_attempts=$1, withdraw_pin_locked_until=$2 WHERE id=$3`,
      [attempts, lockedUntil, userId]
    );
    await logPinEvent(userId, 'verify_failed', { ip });
    await logPinEvent(userId, 'locked', { ip });
    return { success: false, locked: true, remainingMs: LOCK_DURATION_MS };
  }

  await pool.query(`UPDATE users SET withdraw_pin_failed_attempts=$1 WHERE id=$2`, [attempts, userId]);
  await logPinEvent(userId, 'verify_failed', { ip });
  return { success: false, attemptsLeft: MAX_FAILED_ATTEMPTS - attempts };
}

// ==================== অ্যাডমিন PIN রিসেট ====================
// অ্যাডমিন কখনোই আসল PIN দেখতে/সেট করতে পারে না — শুধু হ্যাশ ক্লিয়ার করে দেয়,
// এরপর ইউজারকে নতুন করে PIN তৈরি করতে হয়
async function adminResetPin(userId, adminId, adminUsername, ip) {
  await pool.query(
    `UPDATE users SET withdraw_pin_hash=NULL, withdraw_pin_updated_at=NOW(),
      withdraw_pin_failed_attempts=0, withdraw_pin_locked_until=NULL WHERE id=$1`,
    [userId]
  );
  await logPinEvent(userId, 'admin_reset', { actorType: 'admin', actorId: adminId, actorUsername: adminUsername, ip });
}

// ==================== বর্তমান PIN স্ট্যাটাস (Security পেজ ও Admin প্যানেলে ব্যবহৃত) ====================
async function getPinStatus(userId) {
  const result = await pool.query(
    `SELECT withdraw_pin_hash, withdraw_pin_created_at, withdraw_pin_updated_at,
            withdraw_pin_failed_attempts, withdraw_pin_locked_until
     FROM users WHERE id=$1`,
    [userId]
  );
  const user = result.rows[0] || {};
  return {
    configured: !!user.withdraw_pin_hash,
    createdAt: user.withdraw_pin_created_at || null,
    updatedAt: user.withdraw_pin_updated_at || null,
    locked: isLocked(user),
    remainingMs: lockRemainingMs(user)
  };
}

module.exports = {
  PIN_LENGTH,
  MAX_FAILED_ATTEMPTS,
  LOCK_DURATION_MS,
  isWeakPin,
  createPin,
  updatePin,
  verifyPin,
  adminResetPin,
  getPinStatus,
  logPinEvent,
  isLocked
};
