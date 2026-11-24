// services/referralReview.js
// অ্যাডমিন রিভিউ: pending_review (held) রেফারেল বোনাসের approve / reject।
// • সারি-লক (SELECT ... FOR UPDATE) — দ্বিগুণ approve / approve-পরে reject একবারই কার্যকর।
// • approve: বিদ্যমান createBonus (টার্নওভার ৫x, কনফিগযোগ্য) + কয়েন/লেজার, একই transaction-এ।
// • reject: কারণ বাধ্যতামূলক; ব্যালেন্স/লেজার/bonuses অপরিবর্তিত।
// ডিপোজিট/ওয়ালেট/সেটেলমেন্ট/গেটওয়ে লজিক এখানে স্পর্শ করা হয়নি।
const { pool } = require('../db');
const { PublicError } = require('../utils/safeError');
const rr = require('./referralRewards');

const MAX_NOTE = 500;

function normNote(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
}

async function amountFor(client, reward) {
  const dep = (await client.query(
    `SELECT amount, status FROM payment_requests WHERE id = $1`, [reward.qualifying_deposit_id]
  )).rows[0];
  if (!dep || dep.status !== 'approved') throw new PublicError('যোগ্য ডিপোজিট পাওয়া যায়নি');
  // ইঞ্জিনের মতোই ডিপোজিট-অঙ্ক-ভিত্তিক ধাপ (referral_bonus_bands)
  const hit = rr.bonusForDeposit(dep.amount, await rr.getBands());
  if (!hit || !(Number(hit.amount) > 0)) throw new PublicError('বোনাস ধাপ নির্ধারণ করা যায়নি');
  return { tier: hit.tier, amount: hit.amount };
}

// decision: 'approve' | 'reject'. ফলাফল: { ok, result: 'approved'|'rejected'|'already_processed'|'not_found', ... }
async function reviewHeldReward({ rewardId, adminId, decision, reason }) {
  const id = Number(rewardId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, result: 'not_found' };
  if (decision !== 'approve' && decision !== 'reject') throw new PublicError('অবৈধ সিদ্ধান্ত');
  const note = normNote(reason);
  if (decision === 'reject' && !note) throw new PublicError('বাতিলের কারণ দেওয়া বাধ্যতামূলক');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query(`SELECT * FROM referral_rewards WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); return { ok: false, result: 'not_found' }; }
    if (cur.status !== 'pending_review') {
      await client.query('ROLLBACK');
      return { ok: false, result: 'already_processed', status: cur.status };
    }

    if (decision === 'reject') {
      await client.query(
        `UPDATE referral_rewards SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), review_note = $3 WHERE id = $1`,
        [id, adminId, note]
      );
      await client.query('COMMIT');
      return { ok: true, result: 'rejected', oldStatus: 'pending_review', newStatus: 'rejected', reason: note,
        referrerId: cur.referrer_id, referredId: cur.referred_user_id, amount: 0 };
    }

    // approve — ইঞ্জিনের মতোই রেফারারের advisory লক (টিয়ার রেস নেই)
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`referral_rewards:${cur.referrer_id}`]);
    const { tier, amount } = await amountFor(client, cur);
    await client.query(
      `UPDATE referral_rewards SET status = 'paid', tier = $2, amount = $3, paid_at = NOW(),
              reviewed_by = $4, reviewed_at = NOW(), review_note = $5 WHERE id = $1`,
      [id, tier, amount, adminId, note || null]
    );
    // ক্রেডিট-লেজার লেখা শুধু V2 ইঞ্জিন ফাইলে থাকে (কোড-প্রমাণ টেস্টের নিয়ম) — একই transaction-এর client দিয়ে।
    await rr.payoutApprovedHeld(client, cur, amount);
    await client.query('COMMIT');
    return { ok: true, result: 'approved', oldStatus: 'pending_review', newStatus: 'paid', reason: note || null,
      referrerId: cur.referrer_id, referredId: cur.referred_user_id, amount, tier };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { reviewHeldReward };
