// services/transactionId.js
// ডিপোজিটের ট্রানজেকশন আইডি (TrxID) — normalize, ফরম্যাট যাচাই এবং ডাটাবেজ-ভিত্তিক
// ইউনিকনেস চেক এক জায়গায়।
//
// আগের সমস্যা:
//   • ইউনিকনেস শুধু (method, transaction_id) জোড়ায় দেখা হতো — অর্থাৎ bkash-এ ব্যবহৃত
//     একই TrxID nagad/rocket/bank-এ আবার জমা দেওয়া যেত।
//   • তুলনা ছিল হুবহু স্ট্রিং মিলিয়ে — "abc123", "ABC123", "ABC123 " তিনটেই আলাদা ধরা হতো।
//   • চেকটা fail-open ছিল (কোয়েরি ব্যর্থ হলে লগ করে এগিয়ে যেত) এবং চেক ও INSERT
//     আলাদা হওয়ায় একসাথে দুটো রিকোয়েস্ট দুটোই পাস করতে পারত।
//
// এখন:
//   • তুলনা মেথড-নিরপেক্ষ এবং case/whitespace-অসংবেদনশীল (UPPER(BTRIM(...))).
//   • চেকটা INSERT-এর ট্রানজেকশনের ভেতরে, TrxID-ভিত্তিক advisory লক নিয়ে।
//   • ডাটাবেজ-স্তরের partial unique index (migrations.js) শেষ প্রতিরক্ষা; তার ব্যর্থতা
//     (SQLSTATE 23505) এখানকার isUniqueViolation() দিয়ে "ডুপ্লিকেট" হিসেবে ধরা হয়।

const MIN_LEN = 4;
const MAX_LEN = 100;
// অক্ষর/সংখ্যা দিয়ে শুরু; ভেতরে _ - . : / অনুমোদিত (ব্যাংক রেফারেন্স ও ক্রিপ্টো হ্যাশ কভার করতে)।
const PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]*$/;

// ডাটাবেজ ইনডেক্সের এক্সপ্রেশনের সাথে হুবহু মিলতে হবে (migrations.js)।
const KEY_SQL = 'UPPER(BTRIM(transaction_id))';

// কাঁচা ইনপুট → { ok: true, value, key } বা { ok: false, reason }
// value = ট্রিম করা মূল লেখা (যেভাবে সংরক্ষিত হবে), key = তুলনার জন্য বড়হাতের রূপ।
function normalizeTransactionId(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'missing' };
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'missing' };
  if (value.length < MIN_LEN || value.length > MAX_LEN || !PATTERN.test(value)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, value, key: value.toUpperCase() };
}

// একই TrxID নিয়ে অন্য কোনো ডিপোজিট আছে কিনা (যেকোনো মেথডে)।
//   ১. অন্য ইউজারের ডিপোজিট — status যাই হোক, সবসময় ডুপ্লিকেট।
//   ২. নিজের ডিপোজিট — rejected ছাড়া সব ডুপ্লিকেট (টাইপো করে reject হওয়া আইডি
//      শুদ্ধ করে আবার দেওয়া যাবে)।
// db = pool বা transaction client। ফেরত: মিললে { id, method, user_id, status }, নাহলে null।
async function findDuplicate(db, key, userId) {
  const res = await db.query(
    `SELECT id, method, user_id, status
       FROM payment_requests
      WHERE type = 'deposit'
        AND transaction_id IS NOT NULL
        AND ${KEY_SQL} = $1
        AND (user_id <> $2 OR status <> 'rejected')
      LIMIT 1`,
    [key, userId]
  );
  return res.rows[0] || null;
}

// একই TrxID-র দুটো একসাথে আসা রিকোয়েস্ট সিরিয়ালাইজ করে। ট্রানজেকশনের শেষে লক নিজে ছাড়ে।
// ট্রানজেকশনের ভেতরে (BEGIN-এর পরে) ডাকতে হবে।
async function lockKey(client, key) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['deposit_trx:' + key]);
}

// ডাটাবেজের unique index ভাঙলে (advisory লক এড়িয়ে গেলেও) এটা true।
function isUniqueViolation(err) {
  return !!err && err.code === '23505';
}

module.exports = {
  MIN_LEN,
  MAX_LEN,
  KEY_SQL,
  normalizeTransactionId,
  findDuplicate,
  lockKey,
  isUniqueViolation
};
