// services/periodicReward.js
// সাপ্তাহিক ক্যাশব্যাক + মাসিক রিওয়ার্ড।
// সাপ্তাহিক: গত ৭ দিনের নিট লস (bet - win) এর ১০%, সর্বোচ্চ ৫০০০০, সপ্তাহে একবার।
// মাসিক: গত ক্যালেন্ডার মাসের sports turnover টয়ার বোনাস, মাসে একবার।

const { pool } = require('../db');
const { t } = require('../utils/i18n');

const WEEKLY_RATE = 0.10;
const WEEKLY_MAX = 50000;
const WEEKLY_MIN = 50; // সর্বনিম ক্লেইম

// মাসিক টিয়ার (গত মাসের মোট বাজি → বোনাস)
const MONTHLY_TIERS = [
  { min: 50000, bonus: 500 },
  { min: 200000, bonus: 2500 },
  { min: 500000, bonus: 7000 },
  { min: 1000000, bonus: 15000 }
];

// সপ্তাহের শনাক্তকার (যেমন 2026-W08) — ক্লেইম ডুপ্লিকেট আটকাতে
function weekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// গত মাসের কী (যেমন 2026-05)
function lastMonthKey(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
}

// ==================== সাপ্তাহিক ক্যাশব্যাক ====================
async function getWeeklyStatus(userId) {
  // গত ৭ দিনের নিট লস
  const r = await pool.query(
    `SELECT COALESCE(SUM(total_bet),0) AS bet, COALESCE(SUM(total_win),0) AS win
     FROM daily_losses
     WHERE user_id = $1 AND loss_date >= CURRENT_DATE - INTERVAL '7 days'`,
    [userId]
  );
  const netLoss = Number(r.rows[0].bet) - Number(r.rows[0].win);
  let amount = netLoss > 0 ? Math.floor(netLoss * WEEKLY_RATE) : 0;
  if (amount > WEEKLY_MAX) amount = WEEKLY_MAX;

  const wk = weekKey();
  const claimed = await pool.query(
    `SELECT id FROM periodic_claims WHERE user_id = $1 AND claim_type = 'weekly' AND period_key = $2`,
    [userId, wk]
  );

  return {
    netLoss: netLoss > 0 ? netLoss : 0,
    amount,
    available: amount >= WEEKLY_MIN && claimed.rows.length === 0,
    claimed: claimed.rows.length > 0,
    weekKey: wk
  };
}

async function claimWeekly(userId, lang = 'bn') {
  const status = await getWeeklyStatus(userId);
  if (status.claimed) return { success: false, message: t(lang, 'weekly_cashback_already_claimed') };
  if (!status.available) return { success: false, message: t(lang, 'weekly_cashback_below_min').replace('{value}', WEEKLY_MIN) };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // রি-চেক ও লক
    const dup = await client.query(
      `SELECT id FROM periodic_claims WHERE user_id = $1 AND claim_type = 'weekly' AND period_key = $2 FOR UPDATE`,
      [userId, status.weekKey]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, message: t(lang, 'weekly_cashback_already_claimed') };
    }

    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [status.amount, userId]);
    await client.query(
      `INSERT INTO periodic_claims (user_id, claim_type, period_key, amount) VALUES ($1, 'weekly', $2, $3)`,
      [userId, status.weekKey, status.amount]
    );
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'weekly_cashback', 'সাপ্তাহিক ক্যাশবক')`,
      [userId, status.amount]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'সপ্তাহিক ক্যাশব্যাক!', $2, 'success')`,
      [userId, `আপনি ${status.amount} কয়েন সপ্তাহিক ক্যাশব্যাক পেয়েছেন!`]
    );
    await client.query('COMMIT');
    return { success: true, amount: status.amount, message: t(lang, 'reward_coins_received_status_amount').replace('{value}', status.amount) };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimWeekly error:', e.message);
    return { success: false, message: t(lang, 'common_server_error') };
  } finally {
    client.release();
  }
}

// ==================== মাসিক রিওয়ার্ড ====================
async function getMonthlyStatus(userId) {
  // গত মাসের মোট বাজি (sports + casino — daily_losses.total_bet)
  const mk = lastMonthKey();
  const r = await pool.query(
    `SELECT COALESCE(SUM(total_bet),0) AS turnover
     FROM daily_losses
     WHERE user_id = $1
       AND to_char(loss_date, 'YYYY-MM') = $2`,
    [userId, mk]
  );
  const turnover = Number(r.rows[0].turnover);

  // সর্বোচ্ প্রাপ্য টিয়ার
  let bonus = 0;
  for (const t of MONTHLY_TIERS) {
    if (turnover >= t.min) bonus = t.bonus;
  }

  const claimed = await pool.query(
    `SELECT id FROM periodic_claims WHERE user_id = $1 AND claim_type = 'monthly' AND period_key = $2`,
    [userId, mk]
  );

  return {
    turnover,
    bonus,
    available: bonus > 0 && claimed.rows.length === 0,
    claimed: claimed.rows.length > 0,
    monthKey: mk,
    tiers: MONTHLY_TIERS
  };
}

async function claimMonthly(userId, lang = 'bn') {
  const status = await getMonthlyStatus(userId);
  if (status.claimed) return { success: false, message: t(lang, 'monthly_reward_already_claimed_alt') };
  if (!status.available) return { success: false, message: t(lang, 'monthly_reward_turnover_insufficient') };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query(
      `SELECT id FROM periodic_claims WHERE user_id = $1 AND claim_type = 'monthly' AND period_key = $2 FOR UPDATE`,
      [userId, status.monthKey]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, message: t(lang, 'monthly_reward_already_claimed') };
    }

    await client.query(`UPDATE users SET coins = coins + $1 WHERE id = $2`, [status.bonus, userId]);
    await client.query(
      `INSERT INTO periodic_claims (user_id, claim_type, period_key, amount) VALUES ($1, 'monthly', $2, $3)`,
      [userId, status.monthKey, status.bonus]
    );
    await client.query(
      `INSERT INTO coin_transactions (user_id, amount, type, description) VALUES ($1, $2, 'monthly_reward', 'মাসিক রিওয়ার্ড')`,
      [userId, status.bonus]
    );
    await client.query(
      `INSERT INTO notifications (user_id, title, message, type) VALUES ($1, 'মাসিক রিওয়ার্!', $2, 'success')`,
      [userId, `আপনি ${status.bonus} কয়েন মাসিক রিওয়ার্ড পেয়েছেন!`]
    );
    await client.query('COMMIT');
    return { success: true, amount: status.bonus, message: t(lang, 'reward_coins_received_status_bonus').replace('{value}', status.bonus) };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('claimMonthly error:', e.message);
    return { success: false, message: t(lang, 'common_server_error') };
  } finally {
    client.release();
  }
}

module.exports = { getWeeklyStatus, claimWeekly, getMonthlyStatus, claimMonthly };
