// services/autoMarkets.js
// ---------------------------------------------------------------------------
// ম্যাচের জন্য ডিফল্ট মার্কেট স্বয়ংক্রিয়ভাবে তৈরি/বন্ধ করে।
//
// আগে: প্রতি ম্যাচে শুধু একটা "Match Winner" (bookmaker) মার্কেট তৈরি হতো, ফলে ম্যাচ পেজ
// প্রায় ফাঁকা দেখাত।
//
// এখন: "Match Winner" ছাড়াও services/marketTemplates.js-এর তালিকা অনুযায়ী ক্রিকেটে
// Over/Under, Odd/Even, Yes/No এবং ফুটবলে 1X2, Double Chance, Total Goals, BTTS ইত্যাদি
// তৈরি হয়। প্রতিটা মার্কেট নাম ধরে idempotent — আগে থেকে থাকলে কিছু বদলায় না, অর্থাৎ
// অ্যাডমিনের বদলানো অডস বা বন্ধ করা মার্কেট রিসেট হয় না।
// শেষ হওয়া ম্যাচের খোলা মার্কেট বন্ধ করা হয়, যাতে ফলাফল জানার পর বাজি ধরা না যায়।
//
// "Match Winner"-এর odds ফাঁকা রাখা হয় — services/oddsResolver.js তখন সার্ভার-ডিফল্ট
// (1.85 / 2.10) ব্যবহার করে। সেটেলমেন্ট আগের মতোই অ্যাডমিন থেকে হয়।
// ---------------------------------------------------------------------------
const { pool } = require('../db');
const { templatesFor } = require('./marketTemplates');

async function insertTemplates(client, match) {
  let created = 0;

  // Match Winner সবসময় থাকবে (আগের আচরণ অপরিবর্তিত)
  const mw = await client.query(
    `INSERT INTO markets (match_id, type, name, odds, status)
     SELECT $1, 'bookmaker', 'Match Winner', '{}'::jsonb, 'open'
     WHERE NOT EXISTS (SELECT 1 FROM markets WHERE match_id = $1 AND name = 'Match Winner')`,
    [match.id]
  );
  created += mw.rowCount;

  for (const t of templatesFor(match)) {
    const r = await client.query(
      `INSERT INTO markets (match_id, type, name, odds, status)
       SELECT $1, $2, $3, $4::jsonb, 'open'
       WHERE NOT EXISTS (SELECT 1 FROM markets WHERE match_id = $1 AND name = $3)`,
      [match.id, t.type, t.name, JSON.stringify(t.odds)]
    );
    created += r.rowCount;
  }
  return created;
}

async function ensureDefaultMarkets(matchId, status) {
  if (status === 'finished') return false;
  const m = await pool.query(
    `SELECT id, sport, team_a, team_b, league, title FROM matches WHERE id = $1`,
    [matchId]
  );
  if (!m.rows[0]) return false;
  const created = await insertTemplates(pool, m.rows[0]);
  return created > 0;
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

// যেসব লাইভ/আপকামিং ম্যাচে এখনো শুধু Match Winner (বা কিছুই) আছে, সেগুলোতে বাকি মার্কেট তৈরি করে।
// একবারে সর্বোচ্চ ২০০টা ম্যাচ — পরের সিঙ্কে বাকিগুলো হবে।
async function backfillMissingMarkets() {
  const ms = await pool.query(
    `SELECT m.id, m.sport, m.team_a, m.team_b, m.league, m.title
       FROM matches m
      WHERE COALESCE(m.status, 'upcoming') <> 'finished'
        AND NOT EXISTS (SELECT 1 FROM markets k WHERE k.match_id = m.id AND k.type <> 'bookmaker')
      ORDER BY m.id DESC
      LIMIT 200`
  );
  let created = 0;
  for (const row of ms.rows) {
    try {
      created += await insertTemplates(pool, row);
    } catch (e) {
      console.error(`[markets] backfill ব্যর্থ (match ${row.id}):`, e.message);
    }
  }
  return created;
}

module.exports = { ensureDefaultMarkets, closeFinishedMatchMarkets, backfillMissingMarkets };
