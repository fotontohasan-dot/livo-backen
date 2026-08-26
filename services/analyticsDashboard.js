const { pool } = require('../db');
const healthCheck = require('./healthCheck');
const fraudDetection = require('./fraudDetection');

function parseRange(query) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(Date.now() - 13 * 24 * 3600 * 1000);
  return { from, to };
}

async function getRealtimeStats() {
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE last_login >= NOW() - INTERVAL '15 minutes') AS active_now,
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM bets WHERE created_at >= NOW() - INTERVAL '1 hour') AS bets_last_hour,
      (SELECT COALESCE(SUM(amount),0) FROM payment_requests WHERE type='deposit' AND status='approved' AND created_at >= NOW() - INTERVAL '1 hour') AS deposit_last_hour
  `);
  return r.rows[0];
}

async function getUserGrowth(from, to) {
  const r = await pool.query(`
    SELECT d::date AS day, COALESCE((SELECT COUNT(*) FROM users WHERE created_at::date = d::date),0) AS new_users
    FROM generate_series($1::date, $2::date, INTERVAL '1 day') d ORDER BY day
  `, [from, to]);
  return r.rows;
}

async function getDepositWithdrawSummary(from, to) {
  const r = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN type='deposit' AND status='approved' THEN amount ELSE 0 END),0) AS total_deposit,
      COUNT(*) FILTER (WHERE type='deposit' AND status='approved') AS deposit_count,
      COALESCE(SUM(CASE WHEN type='withdraw' AND status='approved' THEN amount ELSE 0 END),0) AS total_withdraw,
      COUNT(*) FILTER (WHERE type='withdraw' AND status='approved') AS withdraw_count,
      COUNT(*) FILTER (WHERE status='pending') AS pending_count
    FROM payment_requests WHERE created_at BETWEEN $1 AND $2
  `, [from, to]);
  return r.rows[0];
}

async function getRevenueTrend(from, to) {
  const r = await pool.query(`
    SELECT d::date AS day,
      COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='deposit' AND status='approved' AND created_at::date = d::date),0) AS deposit,
      COALESCE((SELECT SUM(amount) FROM payment_requests WHERE type='withdraw' AND status='approved' AND created_at::date = d::date),0) AS withdraw
    FROM generate_series($1::date, $2::date, INTERVAL '1 day') d ORDER BY day
  `, [from, to]);
  return r.rows;
}

async function getBetStatistics(from, to) {
  const r = await pool.query(`
    SELECT
      COUNT(*) AS total_bets,
      COALESCE(SUM(stake),0) AS total_staked,
      COUNT(*) FILTER (WHERE status='won') AS won_count,
      COUNT(*) FILTER (WHERE status='lost') AS lost_count,
      COUNT(*) FILTER (WHERE status='pending') AS pending_count,
      COALESCE(SUM(CASE WHEN status='won' THEN stake*odd ELSE 0 END),0) AS total_payout
    FROM bets WHERE created_at BETWEEN $1 AND $2
  `, [from, to]);
  return r.rows[0];
}

async function getApiUsage(from, to) {
  try {
    const summary = await pool.query(`
      SELECT COUNT(*) AS total_requests,
        COUNT(*) FILTER (WHERE status_code >= 400) AS error_requests,
        COALESCE(AVG(response_time_ms),0) AS avg_response_ms
      FROM api_usage_logs WHERE created_at BETWEEN $1 AND $2
    `, [from, to]);
    const topEndpoints = await pool.query(`
      SELECT endpoint, COUNT(*) AS c FROM api_usage_logs
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY endpoint ORDER BY c DESC LIMIT 5
    `, [from, to]);
    return { ...summary.rows[0], topEndpoints: topEndpoints.rows };
  } catch (err) {
    return { total_requests: 0, error_requests: 0, avg_response_ms: 0, topEndpoints: [] };
  }
}

async function getRecentActivity() {
  const r = await pool.query(`SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 10`);
  return r.rows;
}

async function getFullDashboard(query) {
  const { from, to } = parseRange(query || {});
  const [realtime, userGrowth, depositWithdraw, revenueTrend, betStats, apiUsage, recentActivity, fraudStats, health] = await Promise.all([
    getRealtimeStats(),
    getUserGrowth(from, to),
    getDepositWithdrawSummary(from, to),
    getRevenueTrend(from, to),
    getBetStatistics(from, to),
    getApiUsage(from, to),
    getRecentActivity(),
    fraudDetection.getFraudDashboardStats().catch(() => null),
    healthCheck.runAllChecks().catch(() => null)
  ]);

  return {
    range: { from, to },
    realtime,
    userGrowth,
    depositWithdraw,
    revenueTrend,
    betStats,
    apiUsage,
    recentActivity,
    fraudStats,
    health
  };
}

module.exports = { parseRange, getFullDashboard };
