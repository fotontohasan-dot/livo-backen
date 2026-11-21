// services/depositReversal.js
// অ্যাডমিন-হাতে approved ডিপোজিট রিভার্স (permission: deposit_reverse)। স্বয়ংক্রিয় নয়।
// • একই transaction, সারি-লক: payment_requests → users (অনুমোদন-পথের লক-ক্রমের মতোই)।
// • একবারই: স্ট্যাটাস approved→reversed; দ্বিতীয় চেষ্টা already_reversed (কিছুই বদলায় না) + deposit_reversals.deposit_id UNIQUE।
// • ব্যালেন্স কখনো ঋণাত্মক নয়: যা আছে তা কেটে বাকিটা deposit_reversals.due_amount-এ "বকেয়া" (due_status='open')।
//   requireFull=true হলে কম ব্যালেন্সে রিভার্সাল অস্বীকৃত (insufficient_balance), কিছুই বদলায় না।
// • ওই ডিপোজিটের deposit_bonus: active হলে forfeited + কাটা; ক্লেইম/সম্পন্ন হলে স্ট্যাটাস অপরিবর্তিত রেখে কাটা (bonus_forfeit-ধাঁচে, ঋণাত্মক নয়)।
// • ইউজারের প্রথম approved ডিপোজিট হলে first_deposit ফ্রি বেট: active → cancelled; used → reversed + কাটা।
// • রেফারেল পেআউট স্বয়ংক্রিয় কাটা হয় না — শুধু তালিকা ফেরত যায় (অ্যাডমিন দেখে সিদ্ধান্ত নেবে)।
// বেটিং/সেটেলমেন্ট/গেটওয়ে/ডিপোজিট-অনুমোদন কোড এখানে স্পর্শ করা হয়নি।
const { pool } = require('../db');

const MAX_REASON = 500;
const toC = (v) => Math.round((Number(v) || 0) * 100); // সেন্ট-পূর্ণসংখ্যা — ভাসমান ভুল এড়াতে
const fromC = (c) => c / 100;
const normReason = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);

// result: 'reversed' | 'already_reversed' | 'not_approved' | 'not_found' | 'insufficient_balance' | 'reason_required'
async function reverseDeposit({ depositId, adminId, reason, requireFull = false }) {
  const id = Number(depositId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, result: 'not_found' };
  const note = normReason(reason);
  if (!note) return { ok: false, result: 'reason_required' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dep = (await client.query('SELECT * FROM payment_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!dep || dep.type !== 'deposit') { await client.query('ROLLBACK'); return { ok: false, result: 'not_found' }; }
    if (dep.status === 'reversed') { await client.query('ROLLBACK'); return { ok: false, result: 'already_reversed', status: dep.status }; }
    if (dep.status !== 'approved') { await client.query('ROLLBACK'); return { ok: false, result: 'not_approved', status: dep.status }; }

    const userId = dep.user_id;
    const balBefore = toC((await client.query('SELECT coins FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0]?.coins);
    const depC = toC(dep.amount);

    // ---- ডিপোজিট বোনাস (কোডে bonuses-এ deposit-আইডি নেই; coin_transactions-এর "(#id)" বর্ণনা + সময়ের নৈকট্যে মেলানো) ----
    let bonusC = 0;
    const cancelledBonusIds = [];
    const bonusTx = (await client.query(
      `SELECT amount, created_at FROM coin_transactions
        WHERE user_id = $1 AND type = 'deposit_bonus' AND description = $2 ORDER BY id LIMIT 1`,
      [userId, `ডিপোজিট বোনাস (#${id})`]
    )).rows[0];
    if (bonusTx) {
      const given = toC(bonusTx.amount);
      // ১) নতুন সারি: deposit_id দিয়ে সরাসরি। ২) পুরোনো সারি (deposit_id NULL): পরিমাণ + সময়ের নৈকট্য।
      let b = (await client.query(
        `SELECT id, status FROM bonuses WHERE user_id = $1 AND bonus_type = 'deposit' AND deposit_id = $2 ORDER BY id LIMIT 1 FOR UPDATE`,
        [userId, id]
      )).rows[0];
      if (!b) {
        b = (await client.query(
          `SELECT id, status FROM bonuses
            WHERE user_id = $1 AND bonus_type = 'deposit' AND deposit_id IS NULL AND bonus_amount = $2
            ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamp))) ASC, id ASC LIMIT 1 FOR UPDATE`,
          [userId, Math.round(given / 100), bonusTx.created_at]
        )).rows[0];
      }
      if (b && b.status === 'forfeited') {
        bonusC = 0; // আগেই বাতিল (ও তখনই কাটা) — দ্বিগুণ কাটা নয়
      } else {
        bonusC = given;
        if (b && b.status === 'active') {
          await client.query(`UPDATE bonuses SET status = 'forfeited', updated_at = NOW() WHERE id = $1`, [b.id]);
          cancelledBonusIds.push(b.id);
        }
      }
    }

    // ---- first_deposit ফ্রি বেট (শুধু ইউজারের প্রথম approved ডিপোজিট হলে) ----
    let freeC = 0;
    const cancelledFreeBetIds = [];
    const earlier = (await client.query(
      `SELECT 1 FROM payment_requests WHERE user_id = $1 AND type = 'deposit' AND status IN ('approved','reversed') AND id < $2 LIMIT 1`,
      [userId, id]
    )).rows[0];
    if (!earlier) {
      const fb = (await client.query(
        `SELECT id, amount, status, used_at FROM free_bets WHERE user_id = $1 AND reason = 'first_deposit' FOR UPDATE`, [userId]
      )).rows[0];
      if (fb && fb.status === 'active') {
        await client.query(`UPDATE free_bets SET status = 'cancelled' WHERE id = $1`, [fb.id]);
        cancelledFreeBetIds.push(fb.id);
      } else if (fb && fb.status === 'used') {
        freeC = toC(fb.amount);
        await client.query(`UPDATE free_bets SET status = 'reversed' WHERE id = $1`, [fb.id]);
        cancelledFreeBetIds.push(fb.id);
        const fbb = (await client.query(
          `SELECT id FROM bonuses WHERE user_id = $1 AND bonus_type = 'deposit' AND deposit_id IS NULL AND bonus_amount = $2 AND status = 'active'
            ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamp))) ASC, id ASC LIMIT 1 FOR UPDATE`,
          [userId, Math.round(freeC / 100), fb.used_at]
        )).rows[0];
        if (fbb) {
          await client.query(`UPDATE bonuses SET status = 'forfeited', updated_at = NOW() WHERE id = $1`, [fbb.id]);
          cancelledBonusIds.push(fbb.id);
        }
      }
    }

    // ---- কাটার হিসাব: ঋণাত্মক নয় ----
    const bonusPartC = bonusC + freeC;
    const dedBonusC = Math.min(bonusPartC, balBefore);
    const dedDepC = Math.min(depC, balBefore - dedBonusC);
    const dueC = depC + bonusPartC - dedBonusC - dedDepC;
    if (requireFull && dueC > 0) {
      await client.query('ROLLBACK');
      return { ok: false, result: 'insufficient_balance', balance: fromC(balBefore), needed: fromC(depC + bonusPartC) };
    }
    const totalDedC = dedBonusC + dedDepC;
    if (totalDedC > 0) {
      const upd = await client.query(
        `UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins`, [fromC(totalDedC), userId]
      );
      if (upd.rowCount !== 1) throw new Error('balance guard failed'); // লক-সহ এখানে পৌঁছানোর কথা নয় — নিরাপত্তা-জাল
    }
    if (dedBonusC > 0) {
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'bonus_forfeit', $3)`,
        [userId, -fromC(dedBonusC), `ডিপোজিট রিভার্সালে বোনাস বাতিল (#${id})`]
      );
    }
    if (dedDepC > 0) {
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'deposit_reversal', $3)`,
        [userId, -fromC(dedDepC), `ডিপোজিট রিভার্স (#${id})`]
      );
    }
    await client.query(
      `UPDATE users SET total_deposited = GREATEST(0, COALESCE(total_deposited, 0) - $1) WHERE id = $2`, [dep.amount, userId]
    );
    await client.query(`UPDATE payment_requests SET status = 'reversed', updated_at = NOW() WHERE id = $1 AND status = 'approved'`, [id]);

    // ---- রেফারেল পেআউট: শুধু তালিকা (স্বয়ংক্রিয় কাটা নয়) ----
    const referralPayouts = (await client.query(
      `SELECT id AS reward_id, referrer_id, referred_user_id, status, amount, tier
         FROM referral_rewards WHERE qualifying_deposit_id = $1 AND status IN ('paid','pending_review') ORDER BY id`, [id]
    )).rows.map((r) => ({ ...r, amount: Number(r.amount) }));

    const balAfterC = balBefore - totalDedC;
    await client.query(
      `INSERT INTO deposit_reversals
         (deposit_id, user_id, admin_id, reason, deposit_amount, deducted_deposit, deducted_bonus, due_amount, due_status,
          balance_before, balance_after, old_status, new_status, cancelled_bonus_ids, cancelled_free_bet_ids, referral_payouts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'approved','reversed',$12,$13,$14)`,
      [id, userId, adminId, note, dep.amount, fromC(dedDepC), fromC(dedBonusC), fromC(dueC), dueC > 0 ? 'open' : 'none',
        fromC(balBefore), fromC(balAfterC), JSON.stringify(cancelledBonusIds), JSON.stringify(cancelledFreeBetIds), JSON.stringify(referralPayouts)]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'ডিপোজিট রিভার্স', $2, 'error')`,
      [userId, `আপনার ${Number(dep.amount)} টাকার ডিপোজিট (#${id}) রিভার্স করা হয়েছে।`]
    );
    await client.query('COMMIT');

    return {
      ok: true, result: 'reversed', depositId: id, userId, reason: note,
      oldStatus: 'approved', newStatus: 'reversed',
      depositAmount: Number(dep.amount), deductedDeposit: fromC(dedDepC), deductedBonus: fromC(dedBonusC),
      dueAmount: fromC(dueC), balanceBefore: fromC(balBefore), balanceAfter: fromC(balAfterC),
      cancelledBonusIds, cancelledFreeBetIds, referralPayouts
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { reverseDeposit, normReason };
