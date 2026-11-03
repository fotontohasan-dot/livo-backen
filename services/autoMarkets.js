// services/autoMarkets.js
// ---------------------------------------------------------------------------
// ম্যাচের জন্য মার্কেট (বিজয়ী, রান/উইকেট, গোল ইত্যাদি) স্বয়ংক্রিয়ভাবে তৈরি/বন্ধ করে,
// যাতে match-detail পেজ "Betting options coming soon" না দেখায়।
//
// নিয়ম:
//  - মার্কেটবিহীন, শেষ হয়নি এমন ম্যাচে মার্কেট বসে (idempotent — মার্কেট থাকলে কিছু করে না)।
//  - লাইভ ম্যাচে স্কোর আগেই জানা, তাই লাইন-ভিত্তিক মার্কেট (রান/উইকেট/গোল ওভার-আন্ডার)
//    বানানো হয় না — শুধু বিজয়ী মার্কেট। আপকামিং ম্যাচে পুরো সেট।
//  - ফুটবল ও টেস্ট ক্রিকেটে ড্র আছে, তাই ৩-ওয়ে (বিজয়ী/ড্র) মার্কেট।
//  - আগের সিঙ্কে বসা ফাঁকা-অডসের একক "Match Winner" মার্কেটে কোনো বাজি না থাকলে সেটা
//    নতুন সেট দিয়ে বদলানো হয়; বাজি থাকলে ছোঁয়া হয় না।
//  - শেষ হওয়া ম্যাচের খোলা মার্কেট 'closed' হয়।
//  - অডস স্থির ডিফল্ট (নিচে)। অ্যাডমিন /admin/markets/:matchId থেকে বদলাতে পারেন।
//  - সেটেলমেন্ট আগের মতোই অ্যাডমিন করেন (winning_runner = রানারের নাম, যেমন "Afghanistan")।
//  - AUTO_MARKETS=false → পুরো ফিচার বন্ধ; AUTO_MARKETS_LIVE=false → লাইভ ম্যাচে মার্কেট নয়।
// ---------------------------------------------------------------------------
const { pool } = require('../db');
const cache = require('./cache');
const cacheKeys = require('./cacheKeys');

const envOn = (name) => String(process.env[name] || 'true').toLowerCase() !== 'false';

function cricketFormat(title) {
  const t = String(title || '').toLowerCase();
  if (/t20|twenty20|the hundred/.test(t)) return 't20';
  if (/\bodi\b|one.?day/.test(t)) return 'odi';
  if (/test|first.?class|\bfc\b/.test(t)) return 'test';
  return 'unknown';
}

// রানারের কী-ই প্লেয়ারকে দেখানো হয় এবং সেটেলমেন্টে winning_runner হিসেবে লিখতে হয়।
function buildMarkets(match, isLive) {
  const a = match.team_a || 'Team A';
  const b = match.team_b || 'Team B';
  const sport = String(match.sport || '').toLowerCase();
  const out = [];

  if (sport === 'cricket') {
    const fmt = cricketFormat(match.title);
    if (fmt === 'test') {
      out.push({ name: 'Match Result', odds: { [a]: 2.6, Draw: 3.2, [b]: 2.6 } });
    } else {
      out.push({ name: 'Match Winner', odds: { [a]: 1.9, [b]: 1.9 } });
    }
    if (!isLive && (fmt === 't20' || fmt === 'odi')) {
      const runs = fmt === 'odi' ? 270.5 : 160.5;
      const wk = fmt === 'odi' ? 7.5 : 6.5;
      const bd = fmt === 'odi' ? 24.5 : 12.5;
      out.push({ name: `1st Innings Runs (Over/Under ${runs})`, odds: { [`Over ${runs}`]: 1.9, [`Under ${runs}`]: 1.9 } });
      out.push({ name: `1st Innings Wickets (Over/Under ${wk})`, odds: { [`Over ${wk}`]: 1.9, [`Under ${wk}`]: 1.9 } });
      out.push({ name: `Total Match Fours+Sixes (Over/Under ${bd})`, odds: { [`Over ${bd}`]: 1.9, [`Under ${bd}`]: 1.9 } });
    }
  } else if (sport === 'football') {
    out.push({ name: 'Match Result (1X2)', odds: { [a]: 2.7, Draw: 3.1, [b]: 2.7 } });
    if (!isLive) {
      out.push({ name: 'Total Goals (Over/Under 2.5)', odds: { 'Over 2.5': 1.9, 'Under 2.5': 1.9 } });
      out.push({ name: 'Both Teams To Score', odds: { Yes: 1.85, No: 1.95 } });
    }
  } else {
    out.push({ name: 'Match Winner', odds: { [a]: 1.9, [b]: 1.9 } });
  }
  return out;
}

async function insertMarkets(client, match, list) {
  for (const m of list) {
    await client.query(
      `INSERT INTO markets (match_id, type, name, odds, status) VALUES ($1, 'multi', $2, $3::jsonb, 'open')`,
      [match.id, m.name, JSON.stringify(m.odds)]
    );
  }
}

// একটা ম্যাচের জন্য মার্কেট নিশ্চিত করে। true = নতুন মার্কেট বসেছে।
async function seedMatch(match) {
  if (!match || match.status === 'finished') return false;
  const isLive = match.status === 'live';
  if (isLive && !envOn('AUTO_MARKETS_LIVE')) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // একই ম্যাচে একসাথে দুটো সিঙ্ক/রিকোয়েস্ট এলে ডুপ্লিকেট ঠেকাতে ম্যাচ-রো লক
    await client.query('SELECT id FROM matches WHERE id = $1 FOR UPDATE', [match.id]);
    const ex = await client.query('SELECT COUNT(*)::int AS n FROM markets WHERE match_id = $1', [match.id]);
    if (ex.rows[0].n > 0) { await client.query('ROLLBACK'); return false; }
    await insertMarkets(client, match, buildMarkets(match, isLive));
    await client.query('COMMIT');
    await cache.del(cacheKeys.matchDetail(match.id)).catch(() => {});
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function ensureDefaultMarkets(matchId, status) {
  if (!envOn('AUTO_MARKETS') || status === 'finished') return false;
  const r = await pool.query(
    'SELECT id, title, sport, team_a, team_b, status FROM matches WHERE id = $1', [matchId]
  );
  return seedMatch(r.rows[0]);
}

// শেষ হয়ে যাওয়া ম্যাচের খোলা মার্কেট বন্ধ করে। settled/অন্য স্ট্যাটাসে হাত দেয় না।
async function closeFinishedMatchMarkets() {
  const res = await pool.query(
    `UPDATE markets SET status = 'closed', updated_at = NOW()
     WHERE status = 'open'
       AND match_id IN (SELECT id FROM matches WHERE status = 'finished')
     RETURNING match_id`
  );
  for (const id of new Set(res.rows.map((x) => x.match_id))) {
    await cache.del(cacheKeys.matchDetail(id)).catch(() => {});
  }
  return res.rowCount;
}

// আগের সিঙ্কের ফাঁকা-অডসের একক "Match Winner" মার্কেটকে (বাজি নেই হলে) নতুন সেট দিয়ে বদলায়।
async function upgradeOldDefaults() {
  const res = await pool.query(
    `SELECT m.id, m.title, m.sport, m.team_a, m.team_b, m.status
     FROM matches m
     WHERE COALESCE(m.status,'upcoming') <> 'finished'
       AND (SELECT COUNT(*) FROM markets k WHERE k.match_id = m.id) = 1
       AND EXISTS (SELECT 1 FROM markets k WHERE k.match_id = m.id AND k.type = 'bookmaker'
                   AND k.name = 'Match Winner' AND k.odds = '{}'::jsonb AND k.status = 'open')
       AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.match_id = m.id)
     LIMIT 500`
  );
  let n = 0;
  for (const match of res.rows) {
    const isLive = match.status === 'live';
    if (isLive && !envOn('AUTO_MARKETS_LIVE')) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM matches WHERE id = $1 FOR UPDATE', [match.id]);
      const del = await client.query(
        `DELETE FROM markets WHERE match_id = $1 AND type = 'bookmaker' AND name = 'Match Winner'
           AND odds = '{}'::jsonb AND status = 'open'
           AND NOT EXISTS (SELECT 1 FROM bets WHERE market_id = markets.id)`,
        [match.id]
      );
      if (del.rowCount === 1) {
        await insertMarkets(client, match, buildMarkets(match, isLive));
        n += 1;
      }
      await client.query('COMMIT');
      await cache.del(cacheKeys.matchDetail(match.id)).catch(() => {});
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[autoMarkets] আপগ্রেড ব্যর্থ (match ${match.id}):`, err.message);
    } finally {
      client.release();
    }
  }
  return n;
}

// মার্কেটবিহীন সব সক্রিয় ম্যাচে একবারে মার্কেট তৈরি (ব্যাকফিল) + পুরনো ডিফল্ট আপগ্রেড।
async function backfillMissingMarkets() {
  if (!envOn('AUTO_MARKETS')) return 0;
  const res = await pool.query(
    `SELECT m.id, m.title, m.sport, m.team_a, m.team_b, m.status FROM matches m
     WHERE COALESCE(m.status,'upcoming') <> 'finished'
       AND NOT EXISTS (SELECT 1 FROM markets k WHERE k.match_id = m.id)
     LIMIT 500`
  );
  let n = 0;
  for (const match of res.rows) {
    try { if (await seedMatch(match)) n += 1; }
    catch (err) { console.error(`[autoMarkets] match ${match.id} ব্যর্থ:`, err.message); }
  }
  n += await upgradeOldDefaults();
  return n;
}

module.exports = { ensureDefaultMarkets, closeFinishedMatchMarkets, backfillMissingMarkets, buildMarkets, cricketFormat };
