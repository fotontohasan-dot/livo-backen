// services/tournamentSettlement.js
// ---------------------------------------------------------------------------
// টুর্নামেন্ট সেটেলমেন্ট — বিজয়ী নির্ধারণ, পুরস্কার বিতরণ ও বাতিলে ফেরত।
//
// কেন এই ফাইল:
//   routes/tournaments.js-এ টুর্নামেন্ট তৈরি ও জয়েন করার পুরো লজিক ছিল (entry fee
//   কাটা সহ), কিন্তু জীবনচক্রের বাকিটা কোথাও ছিল না — কে জিতল সেটা বের করা,
//   prize_pool বিলি করা, বাতিল হলে entry fee ফেরত দেওয়া, কিছুই না। অ্যাডমিন
//   /admin/tournaments/:id/status দিয়ে যেকোনো স্ট্রিং status বসিয়ে দিতে পারত;
//   'completed' দিলে কারও কিছু হতো না, 'cancelled' দিলে ইউজারের কাটা entry fee
//   চিরতরে হারিয়ে যেত।
//
// আর্থিক নিয়ম যা এখানে বলবৎ করা হয়েছে:
//   • Idempotent — settled_at/refunded_at সেট হয়ে গেলে দ্বিতীয় কল কোনো টাকা নড়ায় না।
//   • Atomic — একটাই ট্রানজেকশন; কোনো অংশ ব্যর্থ হলে পুরোটা রোলব্যাক।
//   • Race-safe — tournaments সারিতে FOR UPDATE, তারপরও UPDATE ... WHERE
//     settled_at IS NULL দ্বিতীয় স্তরের প্রহরী।
//   • Ledger-সঙ্গত — users.coins-এর প্রতিটা পরিবর্তনের সাথে coin_transactions
//     এন্ট্রি, যাতে financialLedgerIntegrity-র ইনভেরিয়েন্ট (balance ==
//     starting_balance + SUM(coin_transactions.amount)) ভাঙে না।
// ---------------------------------------------------------------------------

const { pool } = require('../db');

// স্লট-ভিত্তিক পুরস্কার ভাগ — ১ম ৫০%, ২য় ৩০%, ৩য় ২০%।
const DEFAULT_DISTRIBUTION = [0.5, 0.3, 0.2];

/**
 * পয়েন্ট থেকে র‍্যাঙ্ক ও পুরস্কার হিসাব — বিশুদ্ধ ফাংশন, কোনো DB ছোঁয় না
 * (এজন্যই আলাদা করে ইউনিট-টেস্ট করা যায়)।
 *
 * নিয়ম:
 *   • points > 0 না হলে কেউ পুরস্কারের যোগ্য নয়। কোনো স্কোর রেকর্ড না হয়ে থাকলে
 *     (সবার points = 0) কোনো টাকাই বিলি হয় না — শূন্য ডেটার ওপর ভিত্তি করে
 *     prize pool সমানভাবে বিলি করে দেওয়া আর্থিকভাবে বিপজ্জনক।
 *   • সমান পয়েন্ট = সমান র‍্যাঙ্ক (১, ১, ৩)। টাই গ্রুপ যতগুলো স্লট দখল করে
 *     সেগুলোর মোট শেয়ার সমানভাবে ভাগ হয়।
 *   • যোগ্য অংশগ্রহণকারী distribution-এর স্লটের চেয়ে কম হলে শেয়ারগুলো
 *     normalize হয় (একজনই থাকলে সে ১০০% পায়) — prize pool-এর অংশ
 *     অনিচ্ছাকৃতভাবে আটকে থাকে না।
 *   • পূর্ণসংখ্যায় ভাগ; ভগ্নাংশজনিত অবশিষ্ট largest-remainder পদ্ধতিতে বিলি,
 *     তাই বিতরিত মোট ঠিক prize_pool-এর সমান হয়।
 */
function computePrizeSplit(participants, prizePool, distribution = DEFAULT_DISTRIBUTION) {
  const total = Math.max(0, Math.floor(Number(prizePool) || 0));

  const eligible = (participants || [])
    .map(p => ({ userId: Number(p.user_id), points: Number(p.points) || 0 }))
    .filter(p => Number.isInteger(p.userId) && p.points > 0)
    .sort((a, b) => (b.points - a.points) || (a.userId - b.userId));

  if (eligible.length === 0 || total === 0) {
    return { awards: [], distributed: 0, undistributed: total, eligibleCount: eligible.length };
  }

  const slots = Math.min(eligible.length, distribution.length);
  const normSum = distribution.slice(0, slots).reduce((a, b) => a + b, 0);
  const shares = distribution.slice(0, slots).map(x => x / normSum);

  // competition ranking + টাই গ্রুপে শেয়ার সমান ভাগ
  const raw = new Array(eligible.length).fill(0);
  const ranks = new Array(eligible.length).fill(0);
  let i = 0;
  while (i < eligible.length) {
    let j = i;
    while (j + 1 < eligible.length && eligible[j + 1].points === eligible[i].points) j++;
    let groupShare = 0;
    for (let k = i; k <= j; k++) if (k < slots) groupShare += shares[k];
    const per = groupShare / (j - i + 1);
    for (let k = i; k <= j; k++) { raw[k] = per * total; ranks[k] = i + 1; }
    i = j + 1;
  }

  const amounts = raw.map(x => Math.floor(x));
  let remainder = total - amounts.reduce((a, b) => a + b, 0);
  const byFraction = raw
    .map((x, idx) => ({ idx, frac: x - Math.floor(x), raw: x }))
    .filter(e => e.raw > 0)
    .sort((a, b) => (b.frac - a.frac) || (a.idx - b.idx));
  let n = 0;
  while (remainder > 0 && byFraction.length > 0) {
    amounts[byFraction[n % byFraction.length].idx] += 1;
    remainder--; n++;
  }

  const awards = eligible.map((p, idx) => ({
    userId: p.userId, points: p.points, rank: ranks[idx], amount: amounts[idx]
  }));
  const distributed = amounts.reduce((a, b) => a + b, 0);
  return { awards, distributed, undistributed: total - distributed, eligibleCount: eligible.length };
}

/**
 * টুর্নামেন্ট settle — বিজয়ী নির্ধারণ ও পুরস্কার বিতরণ, তারপর status='completed'.
 * একই টুর্নামেন্টে দ্বিতীয়বার কল করলে কোনো টাকা নড়ে না ({ alreadySettled: true })।
 */
async function settleTournament(tournamentId, options = {}) {
  const distribution = options.distribution || DEFAULT_DISTRIBUTION;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tRes = await client.query('SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [tournamentId]);
    const tournament = tRes.rows[0];
    if (!tournament) {
      await client.query('ROLLBACK');
      return { success: false, reason: 'not_found' };
    }
    if (tournament.refunded_at) {
      await client.query('ROLLBACK');
      return { success: false, reason: 'already_cancelled' };
    }
    if (tournament.settled_at) {
      await client.query('ROLLBACK');
      return { success: true, alreadySettled: true, distributed: 0, awards: [] };
    }

    const parts = await client.query(
      `SELECT user_id, points FROM tournament_participants
       WHERE tournament_id = $1 ORDER BY points DESC, user_id ASC`,
      [tournamentId]
    );

    const { awards, distributed, undistributed, eligibleCount } =
      computePrizeSplit(parts.rows, tournament.prize_pool, distribution);

    for (const a of awards) {
      if (a.amount > 0) {
        await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [a.amount, a.userId]);
        await client.query(
          `INSERT INTO coin_transactions (user_id, amount, type, description)
           VALUES ($1, $2, 'tournament_prize', $3)`,
          [a.userId, a.amount, `টুর্নামেন্ট #${tournamentId} পুরস্কার (র‍্যাঙ্ক ${a.rank})`]
        );
        await client.query(
          `INSERT INTO notifications (user_id, title, message, type)
           VALUES ($1, $2, $3, 'success')`,
          [a.userId, 'টুর্নামেন্ট পুরস্কার',
            `${tournament.name || 'টুর্নামেন্ট'} — আপনার র‍্যাঙ্ক ${a.rank}, পুরস্কার ${a.amount} কয়েন।`]
        );
      }
      await client.query(
        `UPDATE tournament_participants SET final_rank = $1, prize_awarded = $2
         WHERE tournament_id = $3 AND user_id = $4`,
        [a.rank, a.amount, tournamentId, a.userId]
      );
    }

    // দ্বিতীয় স্তরের প্রহরী — FOR UPDATE লক থাকা সত্ত্বেও শর্তসাপেক্ষ UPDATE,
    // যাতে অন্য কোনো পথে ইতিমধ্যে settle হয়ে গেলে এই ট্রানজেকশন নিজেই বাতিল হয়।
    const upd = await client.query(
      `UPDATE tournaments SET status = 'completed', settled_at = NOW()
       WHERE id = $1 AND settled_at IS NULL`,
      [tournamentId]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, reason: 'concurrent_settlement' };
    }

    await client.query('COMMIT');
    return { success: true, alreadySettled: false, awards, distributed, undistributed, eligibleCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('settleTournament error:', err.message);
    return { success: false, reason: 'error', error: err.message };
  } finally {
    client.release();
  }
}

/**
 * টুর্নামেন্ট বাতিল — প্রত্যেক অংশগ্রহণকারীর প্রকৃত entry fee ফেরত, status='cancelled'.
 * settle হয়ে যাওয়া টুর্নামেন্ট বাতিল করা যায় না (পুরস্কার বিলি হয়ে গেছে, ফেরত
 * দিলে একই টাকা দুবার বেরোবে)। দ্বিতীয়বার কল করলে কোনো টাকা নড়ে না।
 */
async function cancelTournament(tournamentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const tRes = await client.query('SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [tournamentId]);
    const tournament = tRes.rows[0];
    if (!tournament) {
      await client.query('ROLLBACK');
      return { success: false, reason: 'not_found' };
    }
    if (tournament.settled_at) {
      await client.query('ROLLBACK');
      return { success: false, reason: 'already_settled' };
    }
    if (tournament.refunded_at) {
      await client.query('ROLLBACK');
      return { success: true, alreadyRefunded: true, refunded: 0, refundCount: 0 };
    }

    const parts = await client.query(
      `SELECT user_id, COALESCE(entry_fee_paid, $2) AS fee
       FROM tournament_participants WHERE tournament_id = $1 ORDER BY user_id ASC`,
      [tournamentId, Number(tournament.entry_fee) || 0]
    );

    let refunded = 0, refundCount = 0;
    for (const p of parts.rows) {
      const fee = Math.max(0, Math.round(Number(p.fee) || 0));
      if (fee === 0) continue;
      await client.query('UPDATE users SET coins = coins + $1 WHERE id = $2', [fee, p.user_id]);
      await client.query(
        `INSERT INTO coin_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'tournament_refund', $3)`,
        [p.user_id, fee, `টুর্নামেন্ট #${tournamentId} বাতিল — এন্ট্রি ফি ফেরত`]
      );
      await client.query(
        `UPDATE tournament_participants SET refunded_amount = $1
         WHERE tournament_id = $2 AND user_id = $3`,
        [fee, tournamentId, p.user_id]
      );
      await client.query(
        `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, 'info')`,
        [p.user_id, 'টুর্নামেন্ট বাতিল',
          `${tournament.name || 'টুর্নামেন্ট'} বাতিল হয়েছে — ${fee} কয়েন এন্ট্রি ফি ফেরত দেওয়া হয়েছে।`]
      );
      refunded += fee; refundCount++;
    }

    const upd = await client.query(
      `UPDATE tournaments SET status = 'cancelled', refunded_at = NOW()
       WHERE id = $1 AND refunded_at IS NULL AND settled_at IS NULL`,
      [tournamentId]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return { success: false, reason: 'concurrent_cancellation' };
    }

    await client.query('COMMIT');
    return { success: true, alreadyRefunded: false, refunded, refundCount };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('cancelTournament error:', err.message);
    return { success: false, reason: 'error', error: err.message };
  } finally {
    client.release();
  }
}

module.exports = { computePrizeSplit, settleTournament, cancelTournament, DEFAULT_DISTRIBUTION };
