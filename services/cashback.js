// services/cashback.js
// দৈনিক ক্যাশব্যাক — প্রতিদিন ইউজারের নিট লোকসানের একটা শতাংশ পরদিন ফেরত।
// নিট লোকসান = মোট বাজি - মোট জয়। লোকসান হলেই ক্যাশব্যাক, লাভ হলে কিছু না।

const { pool } = require('../db');

const CASHBACK_RATE = 0.05;   // নিট লোকসানের ৫%
const MIN_CASHBACK = 10;      // সর্বনিম্ন ক্লেইম ১০ কয়েন

function today() {
  return new Date().toISOString().slice(0, 10);
}

// বাজি ধরলে total_bet বাড়াও
async function addBet(userId, amount) {
  if (!amount || amount <= 0) return;
  try {
    await pool.query(
      `INSERT INTO daily_losses (user_id, loss_date, total_bet)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, loss_date)
       DO UPDATE SET total_bet = daily_losses.total_bet + $3`,
      [userId, today(), amount]
    );
  } catch (e) {
    console.error('cashback addBet error:', e.message);
  }
}

// জিতলে total_win বাড়াও
async function addWin(userId, amount) {
  if (!amount || amount <= 0) return;
  try {
    await pool.query(
      `INSERT INTO daily_losses (user_id, loss_date, total_win)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, loss_date)
       DO UPDATE SET total_win = daily_losses.total_win + $3`,
      [userId, today(), amount]
    );
  } catch (e) {
    console.error('cashback addWin error:', e.message);
  }
}

// গতকালের ক্যাশব্যাক অবস্থা দেখা
// ফেরত: { available, amount, claimed, netLoss }
async function getCashbackStatus(userId) {
  // গতকালের তারিখ
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);

  const r = await pool.query(
    `SELECT * FROM daily_losses WHERE user_id = $1 AND loss_date = $2`,
    [userId, yesterday]
  );
  const row = r.rows[0];

  if (!row) {
    return { available: false, amount: 0, claimed: false, netLoss: 0, yesterday };
  }

  const netLoss = Number(row.total_bet) - Number(row.total_win);
  let amount = 0;
  if (netLoss > 0) {
    amount = Math.floor(netLoss * CASHBACK_RATE);
  }

  return {
    available: amount >= MIN_CASHBACK && !row.cashback_claimed,
    amount,
    claimed: row.cashback_claimed,
    netLoss: netLoss > 0 ? netLoss : 0,
    yesterday
  };
}

// ক্যাশব্যাক ক্লেইম (গতকালের লোকসানের উপর)
async function claimCashback(userId) {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `SELECT * FROM daily_losses WHERE user_id = $1 AND loss_date = $2 FOR UPDATE`,
      [userId, yesterday]
    );
    const row = r.rows[0];

    if (!row) {
      await client.query('ROLLBACK');
      return { success: false, message: 'গতকাল কোনো খেলা নেই।' };
    }
    if (row.cashback_claimed) {
      await client.query('ROLLBACK');
      return { success: false, message: 'গতকালের ক্যাশব্যাক আগেই নেওয়া হয়েছে।' };
    }

    const netLoss = Number(row.total_bet) - Number(row.total_win);
    if (netLoss <= 0) {
      await client.query('ROLLBACK');
      return { success: false, message: 'গতকাল কোনো লোকসান হয়নি, ক্যাশব্যাক নেই।' };
    }

    const amount = Math.floor(netLoss * CASHBACK_RATE);
    if (amount < MIN_CASHBACK) {
      await client.query('ROLLBACK');
      return { success: false, message: `সর্বনিম্ন ক্যাশব্যাক ${MIN_CASHBACK} কয়েন।` };
    }

    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [amount, userId]);
    await client.query(`UPDATE daily_losses SET cashback_claimed = true WHERE id = $1`, [row.id]);
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'cashback', 'দৈনিক ক্যাশব্যাক')`,
      [userId, amount]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, 'ক্যাশব্যাক!', $2, 'success')`,
      [userId, `আপনি ${amount} কয়েন ক্যাশব্যাক পেয়েছেন!`]
    );

    await client.query('COMMIT');
    return { success: true, amount, message: `${amount} কয়েন ক্যাশব্যাক পেয়েছেন!` };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimCashback error:', e.message);
    return { success: false, message: 'সার্ভার ত্রুটি।' };
  } finally {
    client.release();
  }
}

module.exports = { addBet, addWin, getCashbackStatus, claimCashback, CASHBACK_RATE, MIN_CASHBACK };
