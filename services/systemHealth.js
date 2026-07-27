// services/systemHealth.js
// অ্যাডমিন ড্যাশবোর্ড অ্যানালিটিক্সের জন্য — Server Health, API Usage, Bet Statistics।
// বিদ্যমান services/cache.js (Redis) ও services/queue.js-এর প্যাটার্ন অনুসরণ করে:
// কখনো throw করে না, ব্যর্থ হলে সেফ ডিফল্ট রিটার্ন করে যাতে ড্যাশবোর্ড কখনো ভেঙে না পড়ে।

const os = require('os');
const { execFile } = require('child_process');
const { pool } = require('../db');

function bytesToMb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/** ডিস্ক স্পেস — Linux `df` কমান্ড দিয়ে, ব্যর্থ হলে null (উইজেট গ্রেসফুলি লুকিয়ে যায়) */
function getDiskUsage() {
  return new Promise((resolve) => {
    execFile('df', ['-Pk', '/'], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const lines = stdout.trim().split('\n');
        const parts = lines[lines.length - 1].trim().split(/\s+/);
        const totalKb = parseInt(parts[1], 10);
        const usedKb = parseInt(parts[2], 10);
        const availKb = parseInt(parts[3], 10);
        if (!totalKb) return resolve(null);
        resolve({
          totalMb: Math.round(totalKb / 1024),
          usedMb: Math.round(usedKb / 1024),
          freeMb: Math.round(availKb / 1024),
          usedPercent: Math.round((usedKb / totalKb) * 1000) / 10
        });
      } catch {
        resolve(null);
      }
    });
  });
}

const HEALTH_THRESHOLDS = {
  memoryWarnPercent: 80,
  memoryErrorPercent: 92,
  diskWarnPercent: 80,
  diskErrorPercent: 92,
  loadWarnFactor: 1.5, // loadavg[0] / cpuCount
  loadErrorFactor: 3
};

/** Server Health উইজেট — CPU load, Memory, Disk, Uptime */
async function getServerHealth() {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMemPercent = Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10;
  const cpuCount = os.cpus()?.length || 1;
  const loadAvg = os.loadavg(); // [1m, 5m, 15m], Windows-এ [0,0,0]
  const loadFactor = loadAvg[0] / cpuCount;
  const disk = await getDiskUsage();

  const issues = [];
  let level = 'healthy';
  if (usedMemPercent >= HEALTH_THRESHOLDS.memoryErrorPercent) { level = 'error'; issues.push('সিস্টেম মেমরি প্রায় শেষ'); }
  else if (usedMemPercent >= HEALTH_THRESHOLDS.memoryWarnPercent) { if (level === 'healthy') level = 'warning'; issues.push('সিস্টেম মেমরি ব্যবহার বেশি'); }

  if (disk) {
    if (disk.usedPercent >= HEALTH_THRESHOLDS.diskErrorPercent) { level = 'error'; issues.push('ডিস্ক স্পেস প্রায় শেষ'); }
    else if (disk.usedPercent >= HEALTH_THRESHOLDS.diskWarnPercent) { if (level === 'healthy') level = 'warning'; issues.push('ডিস্ক স্পেস কম'); }
  }

  if (loadFactor >= HEALTH_THRESHOLDS.loadErrorFactor) { level = 'error'; issues.push('CPU লোড অস্বাভাবিক বেশি'); }
  else if (loadFactor >= HEALTH_THRESHOLDS.loadWarnFactor) { if (level === 'healthy') level = 'warning'; issues.push('CPU লোড বেশি'); }

  return {
    level, issues,
    uptimeSec: Math.round(process.uptime()),
    hostUptimeSec: Math.round(os.uptime()),
    process: { rssMb: bytesToMb(mem.rss), heapUsedMb: bytesToMb(mem.heapUsed), heapTotalMb: bytesToMb(mem.heapTotal) },
    system: { totalMemMb: bytesToMb(totalMem), freeMemMb: bytesToMb(freeMem), usedMemPercent },
    cpu: { count: cpuCount, loadAvg1m: Math.round(loadAvg[0] * 100) / 100, loadFactor: Math.round(loadFactor * 100) / 100 },
    disk
  };
}

/** API Usage উইজেট — নির্দিষ্ট রেঞ্জে রিকোয়েস্ট কাউন্ট, গড় রেসপন্স টাইম, টপ এন্ডপয়েন্ট, এরর রেট */
async function getApiUsageStats(from, to) {
  try {
    const [totalsR, topEndpointsR] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS cnt,
                ROUND(AVG(response_time_ms))::int AS avg_ms,
                COUNT(*) FILTER (WHERE status_code >= 400) AS error_cnt
         FROM api_usage_logs WHERE created_at BETWEEN $1 AND $2::date + INTERVAL '1 day'`,
        [from, to]
      ),
      pool.query(
        `SELECT endpoint, method, COUNT(*) AS cnt, ROUND(AVG(response_time_ms))::int AS avg_ms
         FROM api_usage_logs WHERE created_at BETWEEN $1 AND $2::date + INTERVAL '1 day'
         GROUP BY endpoint, method ORDER BY cnt DESC LIMIT 5`,
        [from, to]
      )
    ]);
    const total = parseInt(totalsR.rows[0].cnt, 10) || 0;
    const errorCnt = parseInt(totalsR.rows[0].error_cnt, 10) || 0;
    return {
      totalRequests: total,
      avgResponseMs: totalsR.rows[0].avg_ms || 0,
      errorCount: errorCnt,
      errorRatePercent: total ? Math.round((errorCnt / total) * 1000) / 10 : 0,
      topEndpoints: topEndpointsR.rows.map(r => ({ endpoint: r.endpoint, method: r.method, count: parseInt(r.cnt, 10), avgMs: r.avg_ms || 0 }))
    };
  } catch (err) {
    console.error('[systemHealth] getApiUsageStats error:', err.message);
    return { totalRequests: 0, avgResponseMs: 0, errorCount: 0, errorRatePercent: 0, topEndpoints: [] };
  }
}

/** Bet Statistics উইজেট — নির্দিষ্ট রেঞ্জে মোট বাজি, স্টেক, পেআউট, উইন-রেট, হাউজ প্রফিট */
async function getBetStatistics(from, to) {
  try {
    const r = await pool.query(
      `SELECT COUNT(*) AS cnt,
              COUNT(*) FILTER (WHERE status = 'won') AS won_cnt,
              COUNT(*) FILTER (WHERE status = 'lost') AS lost_cnt,
              COUNT(*) FILTER (WHERE status = 'pending') AS pending_cnt,
              COALESCE(SUM(stake),0) AS total_stake,
              COALESCE(SUM(stake * odd) FILTER (WHERE status = 'won'),0) AS total_payout
       FROM bets WHERE created_at BETWEEN $1 AND $2::date + INTERVAL '1 day'`,
      [from, to]
    );
    const row = r.rows[0];
    const settledCnt = parseInt(row.won_cnt, 10) + parseInt(row.lost_cnt, 10);
    const totalStake = Number(row.total_stake);
    const totalPayout = Number(row.total_payout);
    return {
      totalBets: parseInt(row.cnt, 10),
      wonCount: parseInt(row.won_cnt, 10),
      lostCount: parseInt(row.lost_cnt, 10),
      pendingCount: parseInt(row.pending_cnt, 10),
      winRatePercent: settledCnt ? Math.round((parseInt(row.won_cnt, 10) / settledCnt) * 1000) / 10 : 0,
      totalStake,
      totalPayout,
      houseProfit: totalStake - totalPayout
    };
  } catch (err) {
    console.error('[systemHealth] getBetStatistics error:', err.message);
    return { totalBets: 0, wonCount: 0, lostCount: 0, pendingCount: 0, winRatePercent: 0, totalStake: 0, totalPayout: 0, houseProfit: 0 };
  }
}

module.exports = { getServerHealth, getApiUsageStats, getBetStatistics, getDiskUsage };
