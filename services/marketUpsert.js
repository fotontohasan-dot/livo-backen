// services/marketUpsert.js
// ---------------------------------------------------------------------------
// markets-এ (match_id, type, name) ধরে "থাকলে আপডেট, না থাকলে তৈরি"।
//
// কেন ON CONFLICT নয়: আগের কোড `ON CONFLICT (match_id, type, name)` ব্যবহার করত, কিন্তু
// markets টেবিলে ওই তিন কলামের কোনো ইউনিক ইনডেক্স/কনস্ট্রেইন্ট কখনো তৈরি হয়নি
// (migrations.js শুধু PRIMARY KEY বানায়)। ফলে প্রতিটা অ্যাডমিন "মার্কেট সেভ" Postgres
// এরর (42P10) দিত, রুট সেটা ধরে redirect করত (HTTP 302 — সফল দেখায়), আর কোনো মার্কেটই
// তৈরি হতো না। ম্যাচ-পেজ তাই সবসময় "Betting options coming soon" দেখাত।
//
// এই হেল্পার ইনডেক্স আছে কি না তার ওপর নির্ভর করে না। সেটেল হওয়া সারি কখনো বদলায় না
// (জানা ফলাফলে আবার খুলে বাজি নেওয়ার পথ বন্ধ রাখতে — routes/admin.js-এর settle/toggle গার্ডের সাথে সঙ্গতিপূর্ণ)।
//
// db: pg Pool বা Client (query মেথড থাকলেই চলে); ট্রানজেকশনের ভেতরে কলারই BEGIN/COMMIT করে।
// status: স্ট্রিং হলে বসে; null হলে বিদ্যমান সারির status অপরিবর্তিত, নতুন সারিতে insertStatus।
// রিটার্ন: 'created' | 'updated' | 'skipped_settled'
// ---------------------------------------------------------------------------

async function upsertMarket(db, { matchId, type, name, odds, status = null, insertStatus = 'open' }) {
  const oddsJson = JSON.stringify(odds);

  const upd = await db.query(
    `UPDATE markets
        SET odds = $4::jsonb,
            status = COALESCE($5, status),
            updated_at = NOW()
      WHERE match_id = $1 AND type = $2 AND name = $3 AND status IS DISTINCT FROM 'settled'`,
    [matchId, type, name, oddsJson, status]
  );
  if (upd.rowCount > 0) return 'updated';

  const settled = await db.query(
    `SELECT 1 FROM markets WHERE match_id = $1 AND type = $2 AND name = $3 AND status = 'settled' LIMIT 1`,
    [matchId, type, name]
  );
  if (settled.rowCount > 0) return 'skipped_settled';

  await db.query(
    `INSERT INTO markets (match_id, type, name, odds, status) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [matchId, type, name, oddsJson, status || insertStatus]
  );
  return 'created';
}

module.exports = { upsertMarket };
