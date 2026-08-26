// queues/processors/fraudScan.js
const { pool } = require('../../db');

// একটা ইউজারের উপর সাধারণ Fraud Heuristic Scan চালায় এবং ফলাফল fraud_scan_logs-এ সেভ করে।
// এটা কোনো fully automated ban সিস্টেম না — শুধু ঝুঁকিপূর্ণ প্যাটার্ন চিহ্নিত করে
// অ্যাডমিনকে সতর্ক করার জন্য (risk_score + flags)। চূড়ান্ত সিদ্ধান্ত অ্যাডমিন নেবে।
async function runFraudScan(payload) {
  const userId = payload.userId;
  if (!userId) throw new Error('fraud scan: userId প্রয়োজন');

  const flags = [];
  let riskScore = 0;

  const userRes = await pool.query('SELECT id, username, last_ip, last_device FROM users WHERE id=$1', [userId]);
  const user = userRes.rows[0];
  if (!user) throw new Error(`fraud scan: user ${userId} পাওয়া যায়নি`);

  // ১) একই IP/Device শেয়ার করা অন্য অ্যাকাউন্ট (মাল্টি-অ্যাকাউন্টিং সন্দেহ)
  if (user.last_ip) {
    const dupIp = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM users WHERE last_ip=$1 AND id<>$2`,
      [user.last_ip, userId]
    );
    if (dupIp.rows[0].cnt > 0) {
      flags.push(`same_ip_accounts:${dupIp.rows[0].cnt}`);
      riskScore += Math.min(dupIp.rows[0].cnt * 15, 45);
    }
  }
  if (user.last_device) {
    const dupDevice = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM users WHERE last_device=$1 AND id<>$2`,
      [user.last_device, userId]
    );
    if (dupDevice.rows[0].cnt > 0) {
      flags.push(`same_device_accounts:${dupDevice.rows[0].cnt}`);
      riskScore += Math.min(dupDevice.rows[0].cnt * 15, 45);
    }
  }

  // ২) দ্রুত ডিপোজিট → উইথড্র প্যাটার্ন (বোনাস অ্যাবিউজ / মানি লন্ডারিং সন্দেহ)
  const rapidPattern = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM coin_transactions
     WHERE user_id=$1 AND type='withdraw' AND created_at > NOW() - INTERVAL '24 hours'
       AND EXISTS (
         SELECT 1 FROM coin_transactions t2
         WHERE t2.user_id=$1 AND t2.type='deposit'
           AND t2.created_at BETWEEN coin_transactions.created_at - INTERVAL '30 minutes' AND coin_transactions.created_at
       )`,
    [userId]
  );
  if (rapidPattern.rows[0].cnt > 0) {
    flags.push(`rapid_deposit_withdraw:${rapidPattern.rows[0].cnt}`);
    riskScore += Math.min(rapidPattern.rows[0].cnt * 10, 30);
  }

  riskScore = Math.min(riskScore, 100);
  const riskLevel = riskScore >= 60 ? 'high' : riskScore >= 25 ? 'medium' : 'low';

  await pool.query(
    `INSERT INTO fraud_scan_logs (user_id, risk_score, risk_level, flags, triggered_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, riskScore, riskLevel, JSON.stringify(flags), payload.triggeredBy || 'system']
  );

  return { userId, riskScore, riskLevel, flags };
}

async function processFraudScanJob(job) {
  return runFraudScan(job.data);
}

module.exports = { runFraudScan, processFraudScanJob };
