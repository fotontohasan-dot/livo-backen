// services/duplicateDetection.js
// একই ব্যক্তির একাধিক অ্যাকাউন্ট শনাক্তকরণ — IP, Device Fingerprint, Browser, Payment Account
// মিল বিশ্লেষণ করে Risk Score দেয়। কখনো অ্যাকাউন্ট ব্লক করে না — শুধু ফ্ল্যাগ করে, সিদ্ধান্ত অ্যাডমিনের।

const { pool } = require('../db');
const { logAdminAction } = require('./fraudDetection');

// প্রতিটি সিগন্যাল টাইপের ভিত্তি ওজন (Risk Score গণনার জন্য, সর্বোচ্চ ১০০ পর্যন্ত)
const WEIGHTS = {
  shared_device: 40,
  shared_ip: 25,
  shared_browser: 15,
  shared_payment_account: 35
};
const EXTRA_PER_MATCH = 8; // একাধিক অ্যাকাউন্টে মিললে প্রতিটি অতিরিক্ত মিলের জন্য বাড়তি স্কোর
const MAX_SCORE = 100;

async function findByIp(userId, ip) {
  if (!ip) return [];
  const r = await pool.query(
    `SELECT DISTINCT user_id FROM login_logs WHERE ip = $1 AND user_id IS NOT NULL AND user_id != $2`,
    [ip, userId]
  );
  return r.rows.map(row => row.user_id);
}

async function findByDevice(userId, deviceFingerprint, deviceSignature) {
  const ids = new Set();
  if (deviceFingerprint) {
    const r = await pool.query(
      `SELECT DISTINCT user_id FROM login_logs WHERE device_fingerprint = $1 AND user_id IS NOT NULL AND user_id != $2`,
      [deviceFingerprint, userId]
    );
    r.rows.forEach(row => ids.add(row.user_id));
  }
  if (deviceSignature) {
    const r = await pool.query(
      `SELECT DISTINCT user_id FROM device_sessions WHERE device_signature = $1 AND user_id IS NOT NULL AND user_id != $2`,
      [deviceSignature, userId]
    );
    r.rows.forEach(row => ids.add(row.user_id));
  }
  return [...ids];
}

async function findByBrowser(userId, browser, os) {
  if (!browser || !os) return [];
  const r = await pool.query(
    `SELECT DISTINCT user_id FROM device_sessions WHERE browser = $1 AND os = $2 AND user_id IS NOT NULL AND user_id != $3`,
    [browser, os, userId]
  );
  return r.rows.map(row => row.user_id);
}

async function findByPaymentAccount(userId, accountNumber) {
  if (!accountNumber) return [];
  const r = await pool.query(
    `SELECT DISTINCT user_id FROM (
       SELECT user_id FROM bank_cards WHERE account_number = $1
       UNION
       SELECT user_id FROM payment_requests WHERE account_number = $1
     ) t WHERE user_id != $2`,
    [accountNumber, userId]
  );
  return r.rows.map(row => row.user_id);
}

function computeRiskScore(signals) {
  let score = 0;
  for (const s of signals) {
    const base = WEIGHTS[s.type] || 10;
    const extra = Math.max(0, (s.relatedUsers.length - 1)) * EXTRA_PER_MATCH;
    score += base + extra;
  }
  return Math.min(MAX_SCORE, score);
}

async function createDuplicateFlag(userId, signals) {
  const riskScore = computeRiskScore(signals);
  if (!riskScore) return null;

  const matchTypes = signals.map(s => s.type);
  const matchedUserIds = [...new Set(signals.flatMap(s => s.relatedUsers))];
  const reason = signals.map(s => s.description).join('; ');

  const inserted = await pool.query(
    `INSERT INTO duplicate_account_flags (user_id, matched_user_ids, match_types, risk_score, reason, details, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open') RETURNING *`,
    [userId, matchedUserIds, matchTypes, riskScore, reason, JSON.stringify(signals)]
  );
  const flag = inserted.rows[0];

  await logAdminAction(
    null, 'SYSTEM', 'DUPLICATE_ACCOUNT_DETECTED',
    `ইউজার #${userId} — Risk Score: ${riskScore} — ${reason}`, null
  );

  return flag;
}

/**
 * নতুন রেজিস্ট্রেশন/লগইনের পর কল হয়। কখনো ব্লক করে না — ব্যর্থ হলে শুধু লগ করে এগিয়ে যায়।
 */
// সিগন্যাল তৈরি করার একমাত্র জায়গা। evaluateDuplicateAccount() (লগইন পাথ) এবং
// scanAllUsers() (অ্যাডমিন ব্যাচ স্ক্যান) — দুটোই এই ফাংশনই ব্যবহার করে, তাই ম্যাচ
// খোঁজার পদ্ধতি আলাদা হলেও ফলাফল ও description টেক্সট কখনো ভিন্ন হতে পারে না।
function buildSignals({ deviceMatches, ipMatches, browserMatches, paymentMatches, ip, browser, os, accountNumber }) {
  const signals = [];

  if (deviceMatches.length) {
    signals.push({
      type: 'shared_device', relatedUsers: deviceMatches,
      description: `ডিভাইস ফিঙ্গারপ্রিন্ট ${deviceMatches.length}টি অন্য অ্যাকাউন্টে মিলেছে`
    });
  }

  if (ipMatches.length) {
    signals.push({
      type: 'shared_ip', relatedUsers: ipMatches,
      description: `IP (${ip}) ${ipMatches.length}টি অন্য অ্যাকাউন্টে ব্যবহৃত হয়েছে`
    });
  }

  if (browserMatches.length) {
    signals.push({
      type: 'shared_browser', relatedUsers: browserMatches,
      description: `একই ব্রাউজার/OS (${browser} · ${os}) ${browserMatches.length}টি অন্য অ্যাকাউন্টে পাওয়া গেছে`
    });
  }

  if (paymentMatches.length) {
    signals.push({
      type: 'shared_payment_account', relatedUsers: paymentMatches,
      description: `পেমেন্ট অ্যাকাউন্ট (${accountNumber}) ${paymentMatches.length}টি অন্য অ্যাকাউন্টে ব্যবহৃত হয়েছে`
    });
  }

  return signals;
}

async function evaluateDuplicateAccount(userId, { ip, deviceFingerprint, deviceSignature, browser, os, accountNumber } = {}) {
  try {
    const signals = buildSignals({
      deviceMatches: await findByDevice(userId, deviceFingerprint, deviceSignature),
      ipMatches: await findByIp(userId, ip),
      browserMatches: await findByBrowser(userId, browser, os),
      paymentMatches: await findByPaymentAccount(userId, accountNumber),
      ip, browser, os, accountNumber
    });

    if (signals.length) return await createDuplicateFlag(userId, signals);
    return null;
  } catch (err) {
    console.error('evaluateDuplicateAccount error (non-blocking):', err.message);
    return null;
  }
}

// একটা কলামের মান → যেসব user_id ওই মান ব্যবহার করেছে — এমন ইনডেক্স বানায়।
// একবার পুরো টেবিল পড়ে মেমরিতে ম্যাপ তৈরি করা হয়, যাতে প্রতি ইউজারের জন্য আলাদা
// কোয়েরি না লাগে। এর ফলাফল findByIp/findByDevice/findByBrowser-এর সাথে হুবহু এক:
// ওরাও ঠিক এই টেবিল-কলাম জোড়া থেকেই DISTINCT user_id বের করে।
async function buildIndex(sql, keyFn) {
  const r = await pool.query(sql);
  const map = new Map();
  for (const row of r.rows) {
    const key = keyFn(row);
    if (key === null) continue;
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(row.user_id);
  }
  return map;
}

function othersFor(map, key, selfId) {
  if (key === null || key === undefined) return [];
  const set = map.get(key);
  if (!set) return [];
  const out = [];
  for (const id of set) if (id !== selfId) out.push(id);
  return out;
}

/**
 * বিদ্যমান সব ইউজার স্ক্যান করে পুরনো ডুপ্লিকেট (এই ফিচার চালুর আগের) শনাক্ত করে।
 * অ্যাডমিন প্যানেল থেকে "Scan Now" চাপলে কল হয়।
 *
 * আগে প্রতিটা ইউজারের জন্য আলাদা করে ৪টা lookup কোয়েরি চালানো হতো
 * (evaluateDuplicateAccount → findByDevice ×2, findByIp, findByBrowser)। মাপা হয়েছিল:
 * ২৪২২ ইউজারে ১৪,০৩১ কোয়েরি, ৩০ সেকেন্ড — ইউজারপ্রতি প্রায় ৫.৮টি।
 *
 * এখন lookup টেবিলগুলো একবারই পড়ে মেমরিতে ইনডেক্স বানানো হয়, তারপর প্রতিটা ইউজারের
 * ম্যাচ মেমরিতেই বের করা হয়। সিগন্যাল তৈরি ও ফ্ল্যাগ লেখা আগের কোডই (buildSignals,
 * createDuplicateFlag) করে, তাই সনাক্তকরণের ফলাফল অপরিবর্তিত।
 *
 * দ্রষ্টব্য: এই পাথে accountNumber পাস করা হয় না (আগেও হতো না), তাই
 * shared_payment_account সিগন্যাল এখানে কখনো তৈরি হয় না — আচরণ আগের মতোই।
 */
async function scanAllUsers() {
  const users = await pool.query(`SELECT id, last_ip, last_device FROM users ORDER BY id`);

  // প্রতিটা ইউজারের সর্বশেষ ডিভাইস/সেশন তথ্য (আগের মতোই)
  const deviceRes = await pool.query(`
    SELECT DISTINCT ON (user_id) user_id, device_fingerprint
    FROM login_logs
    WHERE device_fingerprint IS NOT NULL
    ORDER BY user_id, created_at DESC
  `);
  const sessionRes = await pool.query(`
    SELECT DISTINCT ON (user_id) user_id, device_signature, browser, os
    FROM device_sessions
    ORDER BY user_id, last_activity DESC
  `);
  const deviceByUser = new Map(deviceRes.rows.map(r => [r.user_id, r.device_fingerprint]));
  const sessionByUser = new Map(sessionRes.rows.map(r => [r.user_id, r]));

  // মান → user_id সেট ইনডেক্স (প্রতিটা একবারই পড়া হয়)
  const ipIndex = await buildIndex(
    `SELECT DISTINCT ip, user_id FROM login_logs WHERE ip IS NOT NULL AND user_id IS NOT NULL`,
    row => row.ip
  );
  const fingerprintIndex = await buildIndex(
    `SELECT DISTINCT device_fingerprint, user_id FROM login_logs
      WHERE device_fingerprint IS NOT NULL AND user_id IS NOT NULL`,
    row => row.device_fingerprint
  );
  const signatureIndex = await buildIndex(
    `SELECT DISTINCT device_signature, user_id FROM device_sessions
      WHERE device_signature IS NOT NULL AND user_id IS NOT NULL`,
    row => row.device_signature
  );
  // browser ও os দুটোই থাকলে তবেই ম্যাচ ধরা হয় — findByBrowser-এর শর্তের সাথে মিল রেখে
  const browserIndex = await buildIndex(
    `SELECT DISTINCT browser, os, user_id FROM device_sessions
      WHERE browser IS NOT NULL AND os IS NOT NULL AND user_id IS NOT NULL`,
    row => `${row.browser}\u0000${row.os}`
  );

  let flaggedCount = 0;
  for (const u of users.rows) {
    const session = sessionByUser.get(u.id);
    const deviceFingerprint = deviceByUser.get(u.id) || null;
    const deviceSignature = session?.device_signature || null;
    const browser = session?.browser || null;
    const os = session?.os || null;

    // findByDevice() ফিঙ্গারপ্রিন্ট ও সিগনেচার — দুটোর ফল একত্র করে, তাই এখানেও তাই
    const deviceMatches = [...new Set([
      ...othersFor(fingerprintIndex, deviceFingerprint, u.id),
      ...othersFor(signatureIndex, deviceSignature, u.id)
    ])];

    const signals = buildSignals({
      deviceMatches,
      ipMatches: othersFor(ipIndex, u.last_ip || null, u.id),
      browserMatches: (browser && os) ? othersFor(browserIndex, `${browser}\u0000${os}`, u.id) : [],
      paymentMatches: [], // এই পাথে accountNumber নেই — আগের আচরণের সাথে অভিন্ন
      ip: u.last_ip, browser, os, accountNumber: undefined
    });

    if (signals.length) {
      try {
        const flag = await createDuplicateFlag(u.id, signals);
        if (flag) flaggedCount++;
      } catch (err) {
        // আগের কোডে evaluateDuplicateAccount নিজেই ত্রুটি গিলে null ফেরত দিত;
        // একটা ইউজারে সমস্যা হলে পুরো স্ক্যান থেমে যাবে না
        console.error('scanAllUsers flag error (non-blocking):', err.message);
      }
    }
  }
  return flaggedCount;
}

async function listDuplicateFlags({ status = '', minScore = '', userId = '', page = 1, limit = 25 } = {}) {
  const conditions = [];
  const params = [];
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (minScore) { params.push(minScore); conditions.push(`risk_score >= $${params.length}`); }
  if (userId) { params.push(userId); conditions.push(`user_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await pool.query(`SELECT COUNT(*) FROM duplicate_account_flags ${where}`, params);
  const total = parseInt(countRes.rows[0].count, 10);

  const offset = (page - 1) * limit;
  const listParams = [...params, limit, offset];
  const result = await pool.query(
    `SELECT f.*, u.username, u.email, u.phone
     FROM duplicate_account_flags f LEFT JOIN users u ON u.id = f.user_id
     ${where}
     ORDER BY f.risk_score DESC, f.created_at DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );

  return { logs: result.rows, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function reviewDuplicateFlag(id, status, adminId, adminUsername, ip) {
  const r = await pool.query(
    `UPDATE duplicate_account_flags SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3 RETURNING user_id`,
    [status, adminId, id]
  );
  if (r.rows[0]) {
    await logAdminAction(
      adminId, adminUsername, 'DUPLICATE_ACCOUNT_REVIEWED',
      `ডুপ্লিকেট ফ্ল্যাগ #${id} (ইউজার #${r.rows[0].user_id}) কে "${status}" হিসেবে চিহ্নিত করা হয়েছে`, ip
    );
  }
  return r.rows[0] || null;
}

module.exports = {
  evaluateDuplicateAccount,
  scanAllUsers,
  listDuplicateFlags,
  reviewDuplicateFlag
};
