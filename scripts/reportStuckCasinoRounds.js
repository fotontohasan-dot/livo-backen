#!/usr/bin/env node
// scripts/reportStuckCasinoRounds.js — আটকে থাকা ক্যাসিনো রাউন্ডের রিপোর্ট (শুধু-পড়া)।
// কিছু লেখে না, কোনো ব্যালেন্স বদলায় না (READ ONLY ট্রানজ্যাকশন — লেখার চেষ্টা করলেও DB নিজেই ফেরায়)।
// আউটপুট: ইউজার আইডি, প্রোভাইডার, রাউন্ড আইডি, স্টেক, কতক্ষণ আটকে। কোনো সিক্রেট/ব্যক্তিগত তথ্য নয়।
//   node scripts/reportStuckCasinoRounds.js            # টেবিল
//   node scripts/reportStuckCasinoRounds.js --json     # JSON
// থ্রেশহোল্ড: env STUCK_ROUND_HOURS (ডিফল্ট ৬)।  exit 0 = রিপোর্ট হয়েছে (আটকে থাকুক বা না) | exit 1 = চালানো যায়নি।
// আটকে থাকা পেলে exit 2 চাইলে: --fail-on-found
const svc = require('../services/stuckCasinoRounds');

async function run({ argv, env, out, pool }) {
  const known = new Set(['--json', '--fail-on-found', '--help', '-h']);
  const unknown = argv.filter((a) => !known.has(a));
  if (argv.includes('--help') || argv.includes('-h')) { out('ব্যবহার: node scripts/reportStuckCasinoRounds.js [--json] [--fail-on-found]  (থ্রেশহোল্ড: env STUCK_ROUND_HOURS, ডিফল্ট ৬)'); return 0; }
  if (unknown.length) { out(`অজানা অপশন (${unknown.length}টি) — শুধু --json, --fail-on-found চলবে।`); return 1; }
  if (!env.DATABASE_URL) { out('DATABASE_URL সেট নেই — থামানো হলো।'); return 1; }
  const hours = svc.thresholdHours(env);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const res = await svc.findStuckRounds(client, { hours, limit: 1000 });
    await client.query('ROLLBACK'); // কিছু লেখা হয়নি; শুধু ট্রানজ্যাকশন বন্ধ
    if (argv.includes('--json')) {
      out(JSON.stringify({ thresholdHours: res.hours, count: res.count, totalStake: res.totalStake, unmatchableBetsWithoutRoundId: res.unmatchable,
        rounds: res.rounds.map((r) => ({ userId: r.userId, provider: r.provider, roundId: r.roundId, stake: r.stake, stuckFor: svc.formatDuration(r.stuckSeconds) })) }));
    } else {
      out(`আটকে থাকা ক্যাসিনো রাউন্ড (> ${res.hours} ঘণ্টা, win/rollback নেই): ${res.count}টি, মোট স্টেক ${res.totalStake}`);
      if (res.unmatchable) out(`round_id ছাড়া bet (যাচাই করা যায় না, তালিকায় নেই): ${res.unmatchable}টি`);
      if (res.rounds.length) {
        out('user_id | provider | round_id | stake | stuck_for');
        for (const r of res.rounds) out(`${r.userId} | ${r.provider} | ${r.roundId} | ${r.stake} | ${svc.formatDuration(r.stuckSeconds)}`);
        if (res.count > res.rounds.length) out(`… আরও ${res.count - res.rounds.length}টি (তালিকা কাটা)`);
      }
    }
    return res.count > 0 && argv.includes('--fail-on-found') ? 2 : 0;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* উপেক্ষা */ }
    out(`ব্যর্থ (কোড: ${err && err.code ? err.code : 'unknown'})`);
    return 1;
  } finally { client.release(); }
}

module.exports = { run };

if (require.main === module) {
  require('dotenv').config();
  const { pool } = require('../db');
  run({ argv: process.argv.slice(2), env: process.env, out: (m) => console.log(m), pool })
    .then((c) => pool.end().catch(() => {}).then(() => process.exit(c)))
    .catch(() => { console.log('ব্যর্থ (অপ্রত্যাশিত ত্রুটি)।'); process.exit(1); });
}
