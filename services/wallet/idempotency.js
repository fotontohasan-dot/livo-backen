// services/wallet/idempotency.js
// ---------------------------------------------------------------------------
// প্রোভাইডার ট্রানজেকশনের ডুপ্লিকেট শনাক্তকরণ।
//
// কেন শুধু SELECT-চেক যথেষ্ট নয়: প্রোভাইডাররা টাইমআউট হলে একই কল আবার
// পাঠায়, প্রায়ই মিলিসেকেন্ডের ব্যবধানে সমান্তরালে। "আগে SELECT করে দেখি
// আছে কিনা, না থাকলে INSERT" — এই প্যাটার্নে দুটো রিকোয়েস্টই SELECT-এ শূন্য
// পেয়ে দুবার ব্যালেন্স বদলে ফেলতে পারে (classic check-then-act race)।
//
// তাই একমাত্র নির্ভরযোগ্য গার্ড ডাটাবেসের
//   UNIQUE (provider, provider_tx_id)
// কনস্ট্রেইন্ট। আমরা ইচ্ছাকৃতভাবে INSERT-টা আগে চালাই এবং 23505 (unique
// violation) কে "ডুপ্লিকেট" হিসেবে ধরি — চেক নয়, ব্যর্থতাই সংকেত।
// ---------------------------------------------------------------------------

const UNIQUE_VIOLATION = '23505';

/** এই এররটা কি আমাদের idempotency কনস্ট্রেইন্ট ভাঙার ফল? */
function isDuplicateError(err) {
  return !!err && err.code === UNIQUE_VIOLATION;
}

/**
 * আগের (প্রথমবারের) ফলাফল ফেরত আনে — ডুপ্লিকেট কলে ঠিক সেটাই আবার পাঠানো হয়,
 * নতুন করে কিছু হিসাব করা হয় না।
 * @param {import('pg').PoolClient|import('pg').Pool} db
 */
async function findExisting(db, provider, providerTxId) {
  const r = await db.query(
    `SELECT id, type, amount, currency, balance_before, balance_after, status, round_id, game_id, created_at
       FROM provider_transactions
      WHERE provider = $1 AND provider_tx_id = $2`,
    [provider, providerTxId]
  );
  return r.rows[0] || null;
}

/**
 * একটা round-এর নির্দিষ্ট ধরনের ট্রানজেকশন খোঁজে।
 * rollback-এর সময় "কোন bet ফেরত দিতে হবে" বের করতে ব্যবহৃত হয়।
 */
async function findByRound(db, provider, roundId, type) {
  const r = await db.query(
    `SELECT id, provider_tx_id, type, amount, status, user_id
       FROM provider_transactions
      WHERE provider = $1 AND round_id = $2 AND type = $3
      ORDER BY id ASC`,
    [provider, roundId, type]
  );
  return r.rows;
}

module.exports = { isDuplicateError, findExisting, findByRound, UNIQUE_VIOLATION };
