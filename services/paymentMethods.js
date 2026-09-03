// services/paymentMethods.js
// ---------------------------------------------------------------------------
// অ্যাডমিন-নিয়ন্ত্রিত ডিপোজিট অ্যাকাউন্ট (payment_methods) — একটাই সত্যের উৎস।
//
// আগে routes/payment.js-এ চারটা নম্বর হার্ডকোড করা ছিল (DEPOSIT_NUMBERS) এবং
// প্রতি রিকোয়েস্টে রোটেট হতো। নম্বর বদলাতে হলে কোড ডিপ্লয় করা লাগত, আর কোন
// মেথডের জন্য কোন নম্বর সেটাও আলাদা করা যেত না।
//
// গুরুত্বপূর্ণ সীমা: এই মডিউল শুধু **ইউজারকে কোন নম্বর দেখানো হবে** সেটা
// নিয়ন্ত্রণ করে। ওয়ালেট/লেজার/ডিপোজিট অনুমোদনের কোনো যুক্তি এখানে নেই এবং
// এখান থেকে কোনো ব্যালেন্স পরিবর্তন হয় না।
// ---------------------------------------------------------------------------

const { pool } = require('../db');
const cache = require('./cache');
const { PublicError } = require('../utils/safeError');

// routes/payment.js-এর ডিপোজিট ফর্ম যে মেথডগুলো গ্রহণ করে, ঠিক সেগুলোই।
// নতুন মেথড যোগ করতে হলে শুধু এই তালিকা (ও লেবেল ম্যাপ) বাড়ালেই চলবে।
const METHOD_KEYS = ['bkash', 'nagad', 'rocket', 'upay', 'bank', 'crypto'];

// মোবাইল ওয়ালেট = বাংলাদেশি ১১ ডিজিটের নম্বর। বাকিগুলো (bank/crypto)
// অ্যাকাউন্ট/অ্যাড্রেস স্ট্রিং, তাই আলাদা নিয়ম।
const MOBILE_METHODS = new Set(['bkash', 'nagad', 'rocket', 'upay']);

const STATUSES = ['active', 'inactive'];

const ACTIVE_CACHE_KEY = 'payment_methods:active';
const ACTIVE_CACHE_TTL = 30; // সেকেন্ড — mutation-এ সঙ্গে সঙ্গে invalidate হয়

function isValidMethod(method) {
  return METHOD_KEYS.includes(method);
}

/**
 * অ্যাকাউন্ট নম্বর normalize + validate।
 * whitespace/ড্যাশ ছেঁটে ফেলা হয়, তারপর মেথড অনুযায়ী অক্ষর ও দৈর্ঘ্য যাচাই।
 * অবৈধ হলে PublicError — caller সরাসরি ইউজারকে দেখাতে পারে।
 */
function normalizeAccountNumber(method, raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  if (!trimmed) throw new PublicError('অ্যাকাউন্ট নম্বর দিন।');

  if (MOBILE_METHODS.has(method)) {
    // ইউজার প্রায়ই "+880 1712-345678" ধরনের ফরম্যাটে লেখেন — সেটাকে
    // canonical 01XXXXXXXXX-এ আনা হয়, যাতে duplicate সনাক্ত করা যায়।
    let digits = trimmed.replace(/[\s\-().]/g, '');
    if (/^\+?880\d{10}$/.test(digits)) digits = '0' + digits.replace(/^\+?880/, '');
    if (!/^01[3-9]\d{8}$/.test(digits)) throw new PublicError('সঠিক ১১ ডিজিটের নম্বর দিন (01XXXXXXXXX)।');
    return digits;
  }

  const compact = trimmed.replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9 :._-]{6,64}$/.test(compact)) throw new PublicError('অ্যাকাউন্ট নম্বরে অবৈধ অক্ষর আছে।');
  return compact;
}

// লগ/অডিটে পুরো নম্বর রাখা হয় না — শুধু শেষ ৩ ডিজিট।
function maskAccountNumber(value) {
  const s = String(value || '');
  if (s.length <= 3) return '***';
  return '*'.repeat(Math.max(3, s.length - 3)) + s.slice(-3);
}

function invalidateActiveCache() {
  return cache.del(ACTIVE_CACHE_KEY).catch(() => {});
}

// ==================== পড়া ====================

/**
 * ইউজার ডিপোজিট পেজের জন্য — শুধু active, ডিলিট-না-হওয়া সারি।
 * sensitive কলাম (created_by/updated_by) কখনো বাইরে যায় না।
 */
async function listActivePublic() {
  return cache.getOrSet(ACTIVE_CACHE_KEY, ACTIVE_CACHE_TTL, async () => {
    const r = await pool.query(
      `SELECT id, method, account_number, account_name
       FROM payment_methods
       WHERE status = 'active' AND deleted_at IS NULL
       ORDER BY method ASC, id ASC`
    );
    return r.rows.map(row => ({
      id: row.id,
      method: row.method,
      accountNumber: row.account_number,
      accountName: row.account_name || null
    }));
  });
}

/** অ্যাডমিন তালিকা — ঐচ্ছিক method/status ফিল্টারসহ। */
async function listForAdmin({ method, status } = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (method && isValidMethod(method)) { params.push(method); where.push(`method = $${params.length}`); }
  if (status && STATUSES.includes(status)) { params.push(status); where.push(`status = $${params.length}`); }
  const r = await pool.query(
    `SELECT id, method, account_number, account_name, status, created_at, updated_at
     FROM payment_methods WHERE ${where.join(' AND ')}
     ORDER BY method ASC, id ASC`,
    params
  );
  return r.rows;
}

async function getById(id) {
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
  const r = await pool.query(
    'SELECT * FROM payment_methods WHERE id = $1 AND deleted_at IS NULL',
    [numericId]
  );
  return r.rows[0] || null;
}

// ==================== লেখা ====================
// সব ফাংশন explicit allowlist নেয় — req.body সরাসরি কখনো পাস করা হয় না,
// তাই created_by/updated_by/status/internal কলাম mass-assignment করা যায় না।

async function create({ method, accountNumber, accountName, status }, adminId) {
  if (!isValidMethod(method)) throw new PublicError('অবৈধ পেমেন্ট মেথড।');
  const normalized = normalizeAccountNumber(method, accountNumber);
  const finalStatus = STATUSES.includes(status) ? status : 'active';
  const name = accountName ? String(accountName).trim().slice(0, 60) : null;

  try {
    const r = await pool.query(
      `INSERT INTO payment_methods (method, account_number, account_name, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
      [method, normalized, name, finalStatus, adminId || null]
    );
    await invalidateActiveCache();
    return r.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new PublicError('এই মেথডে এই নম্বরটি ইতিমধ্যে আছে।');
    throw err;
  }
}

async function update(id, { method, accountNumber, accountName, status }, adminId) {
  const existing = await getById(id);
  if (!existing) throw new PublicError('পেমেন্ট মেথড পাওয়া যায়নি।');

  const nextMethod = method === undefined ? existing.method : method;
  if (!isValidMethod(nextMethod)) throw new PublicError('অবৈধ পেমেন্ট মেথড।');

  const nextAccount = accountNumber === undefined
    ? existing.account_number
    : normalizeAccountNumber(nextMethod, accountNumber);

  const nextStatus = status === undefined ? existing.status : status;
  if (!STATUSES.includes(nextStatus)) throw new PublicError('অবৈধ স্ট্যাটাস।');

  const nextName = accountName === undefined
    ? existing.account_name
    : (accountName ? String(accountName).trim().slice(0, 60) : null);

  try {
    const r = await pool.query(
      `UPDATE payment_methods
       SET method = $1, account_number = $2, account_name = $3, status = $4,
           updated_by = $5, updated_at = NOW()
       WHERE id = $6 AND deleted_at IS NULL RETURNING *`,
      [nextMethod, nextAccount, nextName, nextStatus, adminId || null, existing.id]
    );
    await invalidateActiveCache();
    return { before: existing, after: r.rows[0] };
  } catch (err) {
    if (err.code === '23505') throw new PublicError('এই মেথডে এই নম্বরটি ইতিমধ্যে আছে।');
    throw err;
  }
}

async function setStatus(id, status, adminId) {
  if (!STATUSES.includes(status)) throw new PublicError('অবৈধ স্ট্যাটাস।');
  return update(id, { status }, adminId);
}

/**
 * সফট ডিলিট।
 *
 * payment_requests-এ এই টেবিলের কোনো foreign key নেই — ঐতিহাসিক ডিপোজিট
 * নিজের method/account_number নিজের সারিতেই ধরে রাখে, তাই hard delete
 * করলেও আর্থিক ইতিহাস ভাঙত না। তবু soft delete বেছে নেওয়া হয়েছে: অডিট
 * ট্রেইলে record ID-টা অর্থবহ থাকে এবং ভুল করে মুছে ফেলা সারি পুনরুদ্ধারযোগ্য।
 */
async function remove(id, adminId) {
  const existing = await getById(id);
  if (!existing) throw new PublicError('পেমেন্ট মেথড পাওয়া যায়নি।');
  await pool.query(
    `UPDATE payment_methods
     SET deleted_at = NOW(), status = 'inactive', updated_by = $1, updated_at = NOW()
     WHERE id = $2`,
    [adminId || null, existing.id]
  );
  await invalidateActiveCache();
  return existing;
}

module.exports = {
  METHOD_KEYS,
  MOBILE_METHODS,
  STATUSES,
  ACTIVE_CACHE_KEY,
  isValidMethod,
  normalizeAccountNumber,
  maskAccountNumber,
  invalidateActiveCache,
  listActivePublic,
  listForAdmin,
  getById,
  create,
  update,
  setStatus,
  remove
};
