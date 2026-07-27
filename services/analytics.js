/**
 * Admin Dashboard Analytics Service
 * Reusable queries for real-time stats, charts, growth, revenue, API usage, security, health.
 * Backward compatible — does not alter existing tables or routes.
 */
const { pool } = require('../db');
const cache = require('./cache');

async function getCoreStats() {
  const [
    users, totalCoins, activeUsers, newUsersToday,
    todayDeposit, todayWithdraw, totalDepositAll, totalWithdrawAll,
    todayBets, todayProfitLoss, pendingDeposits, pendingWithdrawals,
    pendingKyc, pendingSupport
  ] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM users'),
    pool.query('SELECT COALESCE(SUM(coins),0) AS total FROM users'),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM users WHERE last_login >= NOW() - INTERVAL '15 minutes'`),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM users WHERE created_at::date = CURRENT_DATE`),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*)::int AS cnt FROM payment_requests WHERE type='deposit' AND status='approved' AND created_at::date = CURRENT_DATE`),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*)::int AS cnt FROM payment_requests WHERE type='withdraw' AND status='approved' AND created_at::date = CURRENT_DATE`),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests WHERE type='deposit' AND status='approved'`),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests WHERE type='withdraw' AND status='approved'`),
    pool.query(`SELECT COALESCE(SUM(stake),0) AS total, COUNT(*)::int AS cnt FROM bets WHERE created_at::date = CURRENT_DATE`),
    pool.query(`SELECT COALESCE(SUM(stake),0) AS staked, COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS paidout FROM bets WHERE created_at::date = CURRENT_DATE AND status IN ('won','lost')`),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM payment_requests WHERE type='deposit' AND status='pending'`),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM payment_requests WHERE type='withdraw' AND status='pending'`),
    pool.query(`SELECT COUNT(*)::int AS cnt FROM kyc_requests WHERE status='pending'`),
    pool.query(`SELECT COUNT(DISTINCT sender_id)::int AS cnt FROM chat_messages WHERE is_admin=false AND is_read=false`)
  ]);

  const todayProfit = Number(todayProfitLoss.rows[0].staked) - Number(todayProfitLoss.rows[0].paidout);
  const pending_deposits = pendingDeposits.rows[0].cnt;
  const pending_withdrawals = pendingWithdrawals.rows[0].cnt;
  const pending_kyc = pendingKyc.rows[0].cnt;
  const pending_support = pendingSupport.rows[0].cnt;

  return {
    total_users: users.rows[0].count,
    total_coins_in_system: Number(totalCoins.rows[0].total),
    total_coins: Number(totalCoins.rows[0].total),
    active_users: activeUsers.rows[0].cnt,
    active_users_now: activeUsers.rows[0].cnt,
    new_users_today: newUsersToday.rows[0].cnt,
    today_deposit: Number(todayDeposit.rows[0].total),
    today_deposit_count: todayDeposit.rows[0].cnt,
    today_withdraw: Number(todayWithdraw.rows[0].total),
    today_withdraw_count: todayWithdraw.rows[0].cnt,
    total_deposits_all_time: Number(totalDepositAll.rows[0].total),
    total_deposit_all: Number(totalDepositAll.rows[0].total),
    total_withdrawals_all_time: Number(totalWithdrawAll.rows[0].total),
    total_withdraw_all: Number(totalWithdrawAll.rows[0].total),
    today_bet_amount: Number(todayBets.rows[0].total),
    today_bet_count: todayBets.rows[0].cnt,
    today_profit: todayProfit,
    pending_deposits,
    pending_withdrawals,
    pending_kyc,
    pending_support,
    pending_total: pending_deposits + pending_withdrawals + pending_kyc
  };
}

async function getRevenueTrend(days = 14) {
  const r = await pool.query(`
    SELECT d::date AS day,
      COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='deposit' AND status='approved' AND created_at::date = d::date),0) AS deposit,
      COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='withdraw' AND status='approved' AND created_at::date = d::date),0) AS withdraw,
      COALESCE((SELECT SUM(stake) FROM bets WHERE created_at::date = d::date),0) AS staked,
      COALESCE((SELECT SUM(stake*odd) FROM bets WHERE created_at::date = d::date AND status='won'),0) AS payout
    FROM generate_series(CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day', CURRENT_DATE, INTERVAL '1 day') d
    ORDER BY day
  `, [days]);
  return r.rows.map(row => ({
    day: row.day,
    deposit: Number(row.deposit),
    withdraw: Number(row.withdraw),
    ggr: Number(row.staked) - Number(row.payout)
  }));
}

async function getUserGrowth(days = 14) {
  const r = await pool.query(`
    SELECT d::date AS day,
      COALESCE((SELECT COUNT(*) FROM users WHERE created_at::date = d::date),0)::int AS new_users
    FROM generate_series(CURRENT_DATE - ($1::int - 1) * INTERVAL '1 day', CURRENT_DATE, INTERVAL '1 day') d
    ORDER BY day
  `, [days]);
  return r.rows.map(row => ({ day: row.day, count: parseInt(row.new_users) }));
}

async function getBetStats() {
  const r = await pool.query(`
    SELECT
      COUNT(*)::int AS total_bets,
      COUNT(*) FILTER (WHERE status='pending')::int AS pending_bets,
      COUNT(*) FILTER (WHERE status='won')::int AS won_bets,
      COUNT(*) FILTER (WHERE status='lost')::int AS lost_bets,
      COALESCE(SUM(stake),0) AS total_staked,
      COALESCE(SUM(stake) FILTER (WHERE created_at::date = CURRENT_DATE),0) AS today_staked
    FROM bets
  `);
  return r.rows[0];
}

async function getApiUsageSummary() {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*)::int AS total_requests,
        COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300)::int AS success_count,
        COUNT(*) FILTER (WHERE status_code >= 400)::int AS error_count,
        COALESCE(AVG(response_time_ms),0)::int AS avg_response_ms
      FROM api_usage_logs
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `);
    return r.rows[0] || { total_requests: 0, success_count: 0, error_count: 0, avg_response_ms: 0 };
  } catch (e) {
    return { total_requests: 0, success_count: 0, error_count: 0, avg_response_ms: 0 };
  }
}

async function getSecurityAlerts() {
  try {
    const [failed, newDevice, openFraud, openDup] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM failed_login_attempts WHERE created_at >= NOW() - INTERVAL '24 hours'`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM login_logs WHERE is_new_device = true AND created_at >= NOW() - INTERVAL '24 hours'`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM fraud_flags WHERE status='open'`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM duplicate_account_flags WHERE status='open'`).catch(() => ({ rows: [{ c: 0 }] }))
    ]);
    return {
      failed_logins_24h: failed.rows[0].c,
      new_device_logins_24h: newDevice.rows[0].c,
      open_fraud_flags: openFraud.rows[0].c,
      open_duplicate_flags: openDup.rows[0].c
    };
  } catch (e) {
    return { failed_logins_24h: 0, new_device_logins_24h: 0, open_fraud_flags: 0, open_duplicate_flags: 0 };
  }
}

async function getServerHealth() {
  const redis = cache.getStatus();
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch (e) {}
  let queueHealth = { redisConnected: false, queues: [] };
  try {
    queueHealth = await require('../queues').getQueueHealthStats();
  } catch (e) {}
  const mem = process.memoryUsage();
  return {
    db: dbOk,
    redis: redis,
    queue: queueHealth,
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(mem.rss / 1024 / 1024),
    node_version: process.version
  };
}

module.exports = {
  getCoreStats,
  getRevenueTrend,
  getUserGrowth,
  getBetStats,
  getApiUsageSummary,
  getSecurityAlerts,
  getServerHealth
};
