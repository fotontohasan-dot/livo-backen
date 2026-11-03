// services/autoMarkets.js
// ---------------------------------------------------------------------------
// ম্যাচের জন্য ডিফল্ট মার্কেট স্বয়ংক্রিয়ভাবে তৈরি/বন্ধ করে।
//
// সমস্যা: matchUpdater ম্যাচ সিঙ্ক করত কিন্তু কোথাও `markets` টেবিলে রো তৈরি হতো না
// (শুধু অ্যাডমিন হাতে বানালে হতো)। তাই match-detail পেজে markets খালি থাকত এবং
// "Betting options coming soon" দেখাত।
//
// এখন: যে ম্যাচ শেষ হয়নি তার জন্য একটা "Match Winner" (bookmaker) মার্কেট
// নিশ্চিত করা হয় (idempotent — আগে থেকে থাকলে কিছু করে না)। শেষ হওয়া ম্যাচের
// খোলা মার্কেট বন্ধ করা হয়, যাতে ফলাফল জানার পর বাজি ধরা না যায়।
//
// অডস: odds ফাঁকা রাখা হয় — services/oddsResolver.js তখন সার্ভার-ডিফল্ট
// (1.85 / 2.10) ব্যবহার করে। অ্যাডমিন চাইলে /admin/markets/:matchId থেকে বদলাতে পারেন।
// সেটেলমেন্ট আগের মতোই অ্যাডমিন থেকে হয়।
// ---------------------------------------------------------------------------
const { pool } = require('../db');

async function ensureDefaultMarkets(matchId, status) {
  if (status === 'finished') return false;
  const res = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, status)
     SELECT $1, 'bookmaker', 'Match Winner', '{}'::jsonb, 'open'
     WHERE NOT EXISTS (SELECT 1 FROM markets WHERE match_id = $1)`,
    [matchId]
  );
  return res.rowCount > 0;
}

// শেষ হয়ে যাওয়া ম্যাচের খোলা মার্কেট বন্ধ করে। settled/অন্য স্ট্যাটাসে হাত দেয় না।
async function closeFinishedMatchMarkets() {
  const res = await pool.query(
    `UPDATE markets SET status = 'closed', updated_at = NOW()
     WHERE status = 'open'
       AND match_id IN (SELECT id FROM matches WHERE status = 'finished')`
  );
  return res.rowCount;
}

// আগে সিঙ্ক হওয়া যেসব লাইভ/আপকামিং ম্যাচে কোনো মার্কেট নেই, সবগুলোর জন্য একবারে তৈরি করে।
async function backfillMissingMarkets() {
  const res = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, status)
     SELECT m.id, 'bookmaker', 'Match Winner', '{}'::jsonb, 'open'
     FROM matches m
     WHERE COALESCE(m.status, 'upcoming') <> 'finished'
       AND NOT EXISTS (SELECT 1 FROM markets k WHERE k.match_id = m.id)`
  );
  return res.rowCount;
}

module.exports = { ensureDefaultMarkets, closeFinishedMatchMarkets, backfillMissingMarkets };
