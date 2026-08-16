// services/matchUpdater.js
// ---------------------------------------------------------------------------
// কোর ম্যাচ সিঙ্ক। এখানে কোনো প্রোভাইডার-নির্দিষ্ট JSON পার্সিং নেই — সব অ্যাডাপ্টার
// একই normalized আকারে ডেটা দেয় (services/providers/normalizedMatch.js দ্রষ্টব্য),
// আর এই ফাইল সেটাকে matches টেবিলে idempotent ভাবে লেখে।
//
// আগের সমস্যা: `INSERT ... ON CONFLICT DO NOTHING` চালানো হতো, কিন্তু matches টেবিলে
// কোনো UNIQUE কনস্ট্রেইন্টই ছিল না — তাই কনফ্লিক্ট কখনো ঘটত না এবং প্রতি ১৫ মিনিটের
// প্রতিটা পোলে একই ম্যাচের নতুন ডুপ্লিকেট রো তৈরি হতো। এখন (provider, external_id)
// এর উপর partial unique index আছে এবং এখানে সত্যিকারের UPSERT ব্যবহার করা হয়।
// ---------------------------------------------------------------------------

const { pool } = require('../db');
const { getEnabledProviders, getSyncIntervalMs } = require('./providers');

/**
 * একটা normalized ম্যাচ সেভ করে। নতুন হলে INSERT, আগে থেকে থাকলে UPDATE।
 * ON CONFLICT টার্গেট হিসেবে ঠিক সেই partial index-এর predicate দেওয়া হয়েছে,
 * তাই একই সাথে দুটো সিঙ্ক চললেও একটাই রো থাকে (concurrent-safe)।
 *
 * গুরুত্বপূর্ণ: id কখনো বদলায় না, তাই markets.match_id / bets.match_id এর
 * ফরেন কী রেফারেন্স অক্ষত থাকে — বেট, সেটলমেন্ট ও হিস্ট্রি অপরিবর্তিত।
 */
async function upsertMatch(m) {
  const res = await pool.query(
    `INSERT INTO matches
       (title, sport, team_a, team_b, status, score_a, score_b, overs, league,
        start_time, provider, external_id, provider_metadata, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
     ON CONFLICT (provider, external_id)
       WHERE provider IS NOT NULL AND external_id IS NOT NULL
     DO UPDATE SET
       title      = COALESCE(EXCLUDED.title, matches.title),
       team_a     = COALESCE(EXCLUDED.team_a, matches.team_a),
       team_b     = COALESCE(EXCLUDED.team_b, matches.team_b),
       status     = EXCLUDED.status,
       score_a    = COALESCE(EXCLUDED.score_a, matches.score_a),
       score_b    = COALESCE(EXCLUDED.score_b, matches.score_b),
       overs      = COALESCE(EXCLUDED.overs, matches.overs),
       league     = COALESCE(EXCLUDED.league, matches.league),
       start_time = COALESCE(EXCLUDED.start_time, matches.start_time),
       provider_metadata = COALESCE(EXCLUDED.provider_metadata, matches.provider_metadata),
       synced_at  = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      m.title, m.sport, m.teamA, m.teamB, m.status, m.scoreA, m.scoreB, m.overs,
      m.league, m.startTime, m.provider, m.externalId,
      m.metadata ? JSON.stringify(m.metadata) : null
    ]
  );
  return res.rows[0];
}

/**
 * সব সক্রিয় প্রোভাইডার থেকে একবার সিঙ্ক করে। কখনো throw করে না —
 * একটা প্রোভাইডার ব্যর্থ হলে বাকিগুলো চলতে থাকে এবং মূল অ্যাপ ক্র্যাশ করে না।
 */
async function syncOnce() {
  const providers = getEnabledProviders();
  if (providers.length === 0) {
    console.warn('⚠️ কোনো স্পোর্টস প্রোভাইডার কনফিগার করা নেই — ম্যাচ সিঙ্ক স্কিপ করা হলো');
    return { inserted: 0, updated: 0, failed: 0, providers: [] };
  }

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  const summary = [];

  for (const provider of providers) {
    let matches = [];
    try {
      matches = await provider.fetchMatches();
    } catch (err) {
      // অ্যাডাপ্টার নিজেই ধরার কথা; এটা শেষ রক্ষাকবচ
      console.error(`[provider:${provider.name}] fetch ব্যর্থ:`, err.message);
      failed += 1;
      summary.push({ provider: provider.name, error: true, count: 0 });
      continue;
    }

    let pInserted = 0;
    let pUpdated = 0;
    for (const m of matches) {
      try {
        const row = await upsertMatch(m);
        if (row && row.inserted) pInserted += 1;
        else pUpdated += 1;
      } catch (err) {
        // একটা খারাপ রেকর্ডে পুরো সিঙ্ক থামবে না
        failed += 1;
        console.error(`[provider:${provider.name}] upsert ব্যর্থ (${m.externalId}):`, err.message);
      }
    }

    inserted += pInserted;
    updated += pUpdated;
    summary.push({ provider: provider.name, inserted: pInserted, updated: pUpdated, count: matches.length });
    console.log(`✅ ${provider.name} synced: ${matches.length} matches (${pInserted} new, ${pUpdated} updated)`);
  }

  return { inserted, updated, failed, providers: summary };
}

/**
 * পুরনো (legacy) ডুপ্লিকেট শনাক্তকরণ — শুধুমাত্র রিপোর্ট, কোনো পরিবর্তন করে না।
 *
 * partial unique index শুধু provider+external_id থাকা রোতে কাজ করে, তাই নতুন
 * ডুপ্লিকেট আর তৈরি হয় না। কিন্তু এই ফিক্সের আগে তৈরি হওয়া রোগুলোতে ওই কলাম দুটো
 * NULL এবং সেখানে ডুপ্লিকেট থেকে যেতে পারে। সেগুলো স্বয়ংক্রিয়ভাবে মুছে ফেলা হয় না —
 * কারণ যেকোনো রোতে bets/markets ঝুলে থাকতে পারে এবং ঐতিহাসিক রেকর্ড নষ্ট করা যাবে না।
 * এই ফাংশন শুধু দেখায় কোথায় ডুপ্লিকেট আছে, যাতে অ্যাডমিন হাতে সিদ্ধান্ত নিতে পারেন।
 */
async function findLegacyDuplicateMatches(limit = 100) {
  const res = await pool.query(
    `SELECT sport, team_a, team_b, COUNT(*)::int AS copies,
            MIN(id) AS canonical_id, ARRAY_AGG(id ORDER BY id) AS match_ids
     FROM matches
     WHERE provider IS NULL OR external_id IS NULL
     GROUP BY sport, team_a, team_b
     HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/**
 * অ্যাপ বুট হওয়ার সময় ডাকা হয় (app.js)। একবার সিঙ্ক করে, তারপর নির্দিষ্ট
 * ইন্টারভালে পুনরাবৃত্তি করে। ইন্টারভাল কনফিগারযোগ্য, ডিফল্ট আগের মতোই ১৫ মিনিট।
 */
let syncHandle = null;
const syncMatches = async () => {
  console.log('🔄 Syncing real matches...');
  await syncOnce();

  if (syncHandle) return; // একাধিক পোলিং লুপ চালু হওয়া ঠেকানো
  syncHandle = setInterval(() => {
    syncOnce().catch((err) => console.error('Match sync error:', err.message));
  }, getSyncIntervalMs());
  if (syncHandle.unref) syncHandle.unref();
};

module.exports = { syncMatches, syncOnce, upsertMatch, findLegacyDuplicateMatches };
