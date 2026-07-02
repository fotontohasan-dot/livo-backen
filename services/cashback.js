// services/cashback.js
// দৈনিক ক্যাশব্যাক — ক্যাটাগরি ভিত্তিক (sports/casino/live)।
// নিট লোকসান = মোট বাজি - মোট জয়। লোকসান হলেই ক্যাশব্যাক, লাভ হলে কিছু না।

const { pool } = require('../db');

const CASHBACK_RATE = 0.05;   // নিট লোকসানের ৫%
const MIN_CASHBACK = 10;      // সর্বনিম্ন ক্লেইম ১০ কয়েন
const CATEGORIES = ['sports', 'casino', 'live'];
const CATEGORY_LABEL = { sports: 'স্পোর্টস', casino: 'ক্যাসিনো', live: 'লাইভ ডিলার' };

function today() {
  return new Date().toISOString().slice(0, 10);
}

// বাজি ধরলে total_bet বাড়াও (category: sports/casino/live)
async function addBet(userId, amount, category = 'sports') {
  if (!amount || amount <= 0) return;
  if (!CATEGORIES.includes(category)) category = 'sports';
  try {
    await pool.query(
      `INSERT INTO daily_losses (user_id, loss_date, category, total_bet)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, loss_date, category)
       DO UPDATE SET total_bet = daily_losses.total_bet + $4`,
      [userId, today(), category, amount]
    );
  } catch (e) {
    console.error('cashback addBet error:', e.message);
  }
}

// জিতলে total_win বাড়াও
async function addWin(userId, amount, category = 'sports') {
  if (!amount || amount <= 0) return;
  if (!CATEGORIES.includes(category)) category = 'sports';
  try {
    await pool.query(
      `INSERT INTO daily_losses (user_id, loss_date, category, total_win)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, loss_date, category)
       DO UPDATE SET total_win = daily_losses.total_win + $4`,
      [userId, today(), category, amount]
    );
  } catch (e) {
    console.error('cashback addWin error:', e.message);
  }
}

// গতকালের প্রতিটা ক্যাটাগরির ক্যাশব্যাক অবস্থা
async function getCashbackStatus(userId) {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);

  const r = await pool.query(
    `SELECT * FROM daily_losses WHERE user_id = $1 AND loss_date = $2`,
    [userId, yesterday]
  );

  const byCategory = {};
  for (const cat of CATEGORIES) {
    const row = r.rows.find(x => x.category === cat);
    if (!row) {
      byCategory[cat] = { label: CATEGORY_LABEL[cat], available: false, amount: 0, claimed: false, netLoss: 0 };
      continue;
    }
    const netLoss = Number(row.total_bet) - Number(row.total_win);
    const amount = netLoss > 0 ? Math.floor(netLoss * CASHBACK_RATE) : 0;
    byCategory[cat] = {
      label: CATEGORY_LABEL[cat],
      available: amount >= MIN_CASHBACK && !row.cashback_claimed,
      amount,
      claimed: row.cashback_claimed,
      netLoss: netLoss > 0 ? netLoss : 0
    };
  }

  const weekly = await getPeriodSummary(userId, 7);
  const monthly = await getPeriodSummary(userId, 30);

  return { yesterday, byCategory, weekly, monthly };
}

// গত N দিনের ক্যাশব্যাক সামারি (মোট বাজি, মোট জয়, মোট ক্যাশব্যাক পাওয়া)
async function getPeriodSummary(userId, days) {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(total_bet), 0) AS total_bet,
       COALESCE(SUM(total_win), 0) AS total_win,
       COALESCE(SUM(CASE WHEN cashback_claimed THEN GREATEST(total_bet - total_win, 0) * $3 ELSE 0 END), 0) AS cashback_earned
     FROM daily_losses
     WHERE user_id = $1 AND loss_date >= (CURRENT_DATE - $2::int)`,
    [userId, days, CASHBACK_RATE]
  );
  const row = r.rows[0] || {};
  return {
    totalBet: Number(row.total_bet || 0),
    totalWin: Number(row.total_win || 0),
    cashbackEarned: Math.floor(Number(row.cashback_earned || 0))
  };
}

// ক্যাশব্যাক ক্লেইম (নির্দিষ্ট ক্যাটাগরির গতকালের লোকসানের উপর)
async function claimCashback(userId, category = 'sports') {
  if (!CATEGORIES.includes(category)) category = 'sports';
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `SELECT * FROM daily_losses WHERE user_id = $1 AND loss_date = $2 AND category = $3 FOR UPDATE`,
      [userId, yesterday, category]
    );
    const row = r.rows[0];

    if (!row) {
      await client.query('ROLLBACK');
      return { success: false, message: `গতকাল ${CATEGORY_LABEL[category]}-এ কোনো খেলা নেই।` };
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
       VALUES ($1, $2, 'cashback', $3)`,
      [userId, amount, `${CATEGORY_LABEL[category]} ক্যাশব্যাক`]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type)
       VALUES ($1, 'ক্যাশব্যাক!', $2, 'success')`,
      [userId, `আপনি ${CATEGORY_LABEL[category]} থেকে ${amount} কয়েন ক্যাশব্যাক পেয়েছেন!`]
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

module.exports = { addBet, addWin, getCashbackStatus, claimCashback, getPeriodSummary, CASHBACK_RATE, MIN_CASHBACK, CATEGORIES };
