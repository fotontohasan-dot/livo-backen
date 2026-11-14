// services/stuckCasinoRounds.js
// ---------------------------------------------------------------------------
// আটকে থাকা ক্যাসিনো রাউন্ড শনাক্তকারী — শুধু-পড়া। কোনো লেখা নেই, কোনো ব্যালেন্স বদলায় না, কোনো স্বয়ংক্রিয় রিফান্ড নেই।
//
// "আটকে" = provider_transactions-এ একটা রাউন্ডের (provider, round_id) bet ডেবিট হয়েছে (type='bet', status='completed')
// কিন্তু একই রাউন্ডে কোনো 'win' বা 'rollback' সারি নেই, এবং রাউন্ডের শেষ bet N ঘণ্টার বেশি পুরনো
// (N = env STUCK_ROUND_HOURS, ডিফল্ট ৬)।
//   • wallet.rollback মূল bet-কে status='rolled_back' করে এবং type='rollback' সারি যোগ করে → ওই রাউন্ড আটকে নয়।
//   • win(০) ও win(>০) দুটোই type='win' → রাউন্ড শেষ ধরা হয়।
//   • ডেমো রাউন্ড বাদ: game_sessions.mode='demo' (কলব্যাকের raw_payload-এর session_token/token দিয়ে মেলানো; মান কখনো ছাপা হয় না)।
//     সেশন মেলাতে না পারলে আসল ধরা হয় (সতর্ক দিক)।
//   • round_id ছাড়া bet রাউন্ডে গোনা যায় না → আলাদা সংখ্যা (unmatchable) হিসেবে দেখানো হয়, তালিকায় নয়।
// ফেরত তথ্যে: ইউজার আইডি, প্রোভাইডার, রাউন্ড আইডি, স্টেক, কতক্ষণ আটকে — কোনো নাম/ফোন/টোকেন/raw_payload নয়।
// ---------------------------------------------------------------------------

const DEFAULT_HOURS = 6;

function thresholdHours(env = process.env) {
  const n = Number(env.STUCK_ROUND_HOURS);
  return Number.isFinite(n) && n > 0 && n <= 24 * 365 ? n : DEFAULT_HOURS;
}

const BASE_CTE = `
  WITH bets AS (
    SELECT pt.provider, pt.round_id, pt.user_id,
           SUM(pt.amount) AS stake,
           MAX(pt.created_at) AS last_bet_at,
           BOOL_OR(gs.mode = 'demo') AS is_demo
      FROM provider_transactions pt
      LEFT JOIN game_sessions gs
        ON gs.session_token = COALESCE(pt.raw_payload->>'session_token', pt.raw_payload->>'token')
     WHERE pt.type = 'bet' AND pt.status = 'completed' AND pt.round_id IS NOT NULL
     GROUP BY pt.provider, pt.round_id, pt.user_id
  ), stuck AS (
    SELECT b.* FROM bets b
     WHERE COALESCE(b.is_demo, false) = false
       AND b.last_bet_at < NOW() - make_interval(secs => $1::float8 * 3600)
       AND NOT EXISTS (
         SELECT 1 FROM provider_transactions o
          WHERE o.provider = b.provider AND o.round_id = b.round_id AND o.type IN ('win', 'rollback'))
  )`;

/** কোনো read-only ট্রানজ্যাকশনে (db = pg client/pool) চালানোর জন্য। */
async function findStuckRounds(db, { hours = DEFAULT_HOURS, limit = 200 } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 200, 5000));
  const [list, cnt, unm] = await Promise.all([
    db.query(`${BASE_CTE}
      SELECT user_id, provider, round_id, stake::float8 AS stake,
             EXTRACT(EPOCH FROM (NOW() - last_bet_at))::bigint AS stuck_seconds
        FROM stuck ORDER BY last_bet_at ASC LIMIT ${lim}`, [hours]),
    db.query(`${BASE_CTE} SELECT COUNT(*)::int AS n, COALESCE(SUM(stake),0)::float8 AS total_stake FROM stuck`, [hours]),
    db.query(`SELECT COUNT(*)::int AS n FROM provider_transactions
               WHERE type='bet' AND status='completed' AND round_id IS NULL
                 AND created_at < NOW() - make_interval(secs => $1::float8 * 3600)`, [hours]),
  ]);
  return {
    hours,
    count: cnt.rows[0].n,
    totalStake: cnt.rows[0].total_stake,
    unmatchable: unm.rows[0].n,
    rounds: list.rows.map((r) => ({
      userId: r.user_id, provider: r.provider, roundId: r.round_id, stake: r.stake, stuckSeconds: Number(r.stuck_seconds),
    })),
  };
}

/** শুধু সংখ্যা (মেট্রিকের জন্য); ব্যর্থ হলে null — "০" নয়, যাতে ব্যর্থতা চুপচাপ সবুজ না দেখায়। */
async function countStuckRounds(db, { hours = thresholdHours() } = {}) {
  try {
    const r = await db.query(`${BASE_CTE} SELECT COUNT(*)::int AS n FROM stuck`, [hours]);
    return r.rows[0].n;
  } catch (_) { return null; }
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

module.exports = { DEFAULT_HOURS, thresholdHours, findStuckRounds, countStuckRounds, formatDuration };
