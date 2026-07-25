// services/deviceTracking.js
// প্রতিটি লগইনে ডিভাইস/ব্রাউজার/OS রেকর্ড করে, নতুন ডিভাইস শনাক্ত করে, এবং সেশন-লিংকড
// "Active Devices" ট্র্যাক করে যাতে ইউজার নির্দিষ্ট ডিভাইস বা সব ডিভাইস থেকে লগআউট করতে পারে।

const crypto = require('crypto');
const geoip = require('geoip-lite');
const { pool } = require('../db');
const { logAdminAction } = require('./fraudDetection');
const { sendNewDeviceAlert, sendDeviceTrustedAlert, sendDeviceRemovedAlert } = require('./email');
const { notifyUser, notifyAdmins } = require('./notify');

const ACTIVITY_TOUCH_INTERVAL_MS = 5 * 60 * 1000; // বারবার DB আপডেট না করে ৫ মিনিট পরপর last_activity রিফ্রেশ

// ==================== আনুমানিক লোকেশন (geoip-lite — অফলাইন DB, কোনো API key/নেটওয়ার্ক কল লাগে না) ====================
function lookupLocation(ip) {
  try {
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return 'Local/Unknown';
    }
    const geo = geoip.lookup(ip);
    if (!geo) return 'Unknown';
    return [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || 'Unknown';
  } catch (e) {
    return 'Unknown';
  }
}

// ==================== User-Agent পার্সিং (কোনো বাড়তি npm প্যাকেজ ছাড়াই, হালকা regex-ভিত্তিক) ====================
function parseUserAgent(ua) {
  ua = ua || '';
  let os = 'Unknown OS';
  if (/windows nt 10/i.test(ua)) os = 'Windows 10/11';
  else if (/windows nt/i.test(ua)) os = 'Windows';
  else if (/mac os x/i.test(ua) && /iphone|ipad/i.test(ua) === false) os = 'macOS';
  else if (/iphone/i.test(ua)) os = 'iOS';
  else if (/ipad/i.test(ua)) os = 'iPadOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/linux/i.test(ua)) os = 'Linux';

  let browser = 'Unknown Browser';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/samsungbrowser/i.test(ua)) browser = 'Samsung Internet';
  else if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) browser = 'Chrome';
  else if (/crios\//i.test(ua)) browser = 'Chrome (iOS)';
  else if (/fxios\//i.test(ua)) browser = 'Firefox (iOS)';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/safari\//i.test(ua) && /version\//i.test(ua)) browser = 'Safari';

  let deviceType = 'Desktop';
  if (/ipad|tablet/i.test(ua)) deviceType = 'Tablet';
  else if (/mobile|iphone|android/i.test(ua)) deviceType = 'Mobile';

  return { os, browser, deviceType };
}

function buildDeviceName({ browser, os, deviceType }) {
  return `${browser} · ${os}${deviceType && deviceType !== 'Desktop' ? ' (' + deviceType + ')' : ''}`;
}

function computeSignature(fingerprint, ua) {
  const base = fingerprint || ua || 'unknown';
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 32);
}

function extractIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
}

/**
 * সফল লগইন/রেজিস্ট্রেশনের পর কল হয়। login_logs-এ ইতিমধ্যে রো ইনসার্ট করা থাকলে
 * (routes/auth.js-এর recordLogin ফাংশন করে), এটি সেই রো-এর signature/is_new_device
 * আপডেট করে এবং সেশন-লিংকড device_sessions রো তৈরি/আপডেট করে।
 * কখনো লগইন/রেজিস্ট্রেশন ফ্লো ব্লক করে না — ব্যর্থ হলে silently skip করে।
 */
async function recordDeviceLogin(req, userId, loginLogId) {
  try {
    const ip = extractIp(req);
    const ua = req.get('user-agent') || '';
    const fingerprint = req.headers['x-device-fingerprint'] || req.body?.device_fingerprint || null;
    const signature = computeSignature(fingerprint, ua);
    const parsed = parseUserAgent(ua);
    const deviceName = buildDeviceName(parsed);
    const location = lookupLocation(ip);
    const sid = req.sessionID;

    const seenBefore = await pool.query(
      `SELECT 1 FROM login_logs WHERE user_id = $1 AND device_signature = $2 AND id != $3 LIMIT 1`,
      [userId, signature, loginLogId || 0]
    );
    const isNewDevice = seenBefore.rows.length === 0;

    if (loginLogId) {
      await pool.query(
        `UPDATE login_logs SET device_signature = $1, is_new_device = $2, location = $3 WHERE id = $4`,
        [signature, isNewDevice, location, loginLogId]
      );
    }

    if (sid) {
      await pool.query(
        `INSERT INTO device_sessions (user_id, sid, device_signature, device_name, browser, os, device_type, ip, user_agent, is_new_device, location, created_at, last_activity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
         ON CONFLICT (sid) DO UPDATE SET
           user_id = EXCLUDED.user_id, device_signature = EXCLUDED.device_signature,
           device_name = EXCLUDED.device_name, browser = EXCLUDED.browser, os = EXCLUDED.os,
           device_type = EXCLUDED.device_type, ip = EXCLUDED.ip, user_agent = EXCLUDED.user_agent,
           location = EXCLUDED.location, last_activity = NOW(), revoked_at = NULL`,
        [userId, sid, signature, deviceName, parsed.browser, parsed.os, parsed.deviceType, ip, ua, isNewDevice, location]
      );
    }

    if (isNewDevice) {
      await logAdminAction(
        null, 'SYSTEM', 'NEW_DEVICE_LOGIN',
        `ইউজার #${userId} — নতুন ডিভাইস থেকে লগইন: ${deviceName} — IP ${ip} — ${location}`, null
      );

      // ইউজারকে রিয়েল-টাইম সিকিউরিটি অ্যালার্ট (নোটিফিকেশন সেন্টার + অনলাইন থাকলে পুশ)
      notifyUser(userId, {
        title: '🔐 নতুন ডিভাইস থেকে লগইন',
        message: `${deviceName} থেকে আপনার অ্যাকাউন্টে লগইন হয়েছে — IP: ${ip}, লোকেশন: ${location}। এটা আপনি না হলে এখনই পাসওয়ার্ড বদলান।`,
        type: 'security',
      }).catch(() => {});

      // অ্যাডমিন প্যানেলেও রিয়েল-টাইম দেখানো
      notifyAdmins('security', {
        title: 'নতুন ডিভাইস লগইন',
        message: `ইউজার #${userId} — ${deviceName} — IP ${ip} — ${location}`,
      });

      // নতুন ডিভাইস থেকে লগইন হলে ইউজারকে ইমেইল সতর্কতা — ব্যর্থ হলেও লগইন ফ্লো কখনো আটকাবে না
      try {
        const userRes = await pool.query('SELECT email, username FROM users WHERE id = $1', [userId]);
        const u = userRes.rows[0];
        if (u && u.email) {
          await sendNewDeviceAlert(u.email, {
            username: u.username, deviceName, ip, location, time: new Date()
          });
        }
      } catch (mailErr) {
        console.error('sendNewDeviceAlert error (non-blocking):', mailErr.message);
      }
    }

    return { isNewDevice, deviceName, signature, location };
  } catch (err) {
    console.error('recordDeviceLogin error (non-blocking):', err.message);
    return null;
  }
}

/**
 * প্রতিটি রিকোয়েস্টে কল হয় (থ্রটলড) — ৫ মিনিট পরপর last_activity রিফ্রেশ করে।
 * ব্যর্থ হলে silently skip করে, কখনো রিকোয়েস্ট আটকায় না।
 */
const lastTouchCache = new Map(); // sid -> timestamp, মেমরিতে রাখা হয়েছে যাতে প্রতি রিকোয়েস্টে DB read লাগে না
async function touchDeviceActivity(req) {
  try {
    const sid = req.sessionID;
    if (!sid) return;
    const now = Date.now();
    const last = lastTouchCache.get(sid) || 0;
    if (now - last < ACTIVITY_TOUCH_INTERVAL_MS) return;
    lastTouchCache.set(sid, now);
    if (lastTouchCache.size > 5000) lastTouchCache.clear(); // মেমরি লিক প্রতিরোধ
    await pool.query(`UPDATE device_sessions SET last_activity = NOW() WHERE sid = $1 AND revoked_at IS NULL`, [sid]);
  } catch (err) {
    console.error('touchDeviceActivity error (non-blocking):', err.message);
  }
}

async function listActiveSessions(userId, currentSid) {
  const r = await pool.query(
    `SELECT * FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_activity DESC`,
    [userId]
  );
  return r.rows.map(row => ({ ...row, is_current: row.sid === currentSid }));
}

/** বর্তমান সেশনের ডিভাইসটি সাম্প্রতিক লগইনে নতুন হিসেবে চিহ্নিত হয়েছিল কিনা — Fraud Detection-এর জন্য (যেমন: নতুন ডিভাইস থেকে বড় উইথড্র)। ব্যর্থ হলে false (fail-safe, ফ্ল্যাগ মিস হবে কিন্তু কখনো ফ্লো আটকাবে না)। */
async function isSessionNewDevice(sid) {
  if (!sid) return false;
  try {
    const r = await pool.query(`SELECT is_new_device FROM device_sessions WHERE sid = $1`, [sid]);
    return !!(r.rows[0] && r.rows[0].is_new_device);
  } catch (err) {
    console.error('isSessionNewDevice error (non-blocking):', err.message);
    return false;
  }
}

async function listLoginHistory(userId, limit = 50, offset = 0) {
  const r = await pool.query(
    `SELECT * FROM login_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return r.rows.map(row => ({ ...row, ...parseUserAgent(row.user_agent) }));
}

async function revokeDeviceSession(userId, deviceSessionId, actorLabel) {
  const found = await pool.query(
    `SELECT sid, device_name FROM device_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [deviceSessionId, userId]
  );
  if (!found.rows[0]) return false;
  const { sid, device_name } = found.rows[0];

  await pool.query(`UPDATE device_sessions SET revoked_at = NOW() WHERE id = $1`, [deviceSessionId]);
  try {
    await pool.query(`DELETE FROM user_sessions WHERE sid = $1`, [sid]); // এই মুহূর্তে সার্ভার-সাইড সেশন invalid হয়ে যায়
  } catch (e) {
    console.error('user_sessions delete error:', e.message);
  }

  await logAdminAction(null, actorLabel || 'SYSTEM', 'DEVICE_SESSION_REVOKED',
    `ইউজার #${userId} — ডিভাইস লগআউট করা হয়েছে: ${device_name || sid}`, null);

  return true;
}

async function revokeAllOtherSessions(userId, currentSid, actorLabel) {
  const rows = await pool.query(
    `SELECT id, sid FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL AND sid != $2`,
    [userId, currentSid]
  );
  for (const row of rows.rows) {
    await pool.query(`UPDATE device_sessions SET revoked_at = NOW() WHERE id = $1`, [row.id]);
    try { await pool.query(`DELETE FROM user_sessions WHERE sid = $1`, [row.sid]); } catch (e) {}
  }
  if (rows.rows.length) {
    await logAdminAction(null, actorLabel || 'SYSTEM', 'ALL_OTHER_SESSIONS_REVOKED',
      `ইউজার #${userId} — ${rows.rows.length}টি অন্য ডিভাইস থেকে লগআউট করা হয়েছে`, null);
  }
  return rows.rows.length;
}

/** ইউজারের সব সক্রিয় (non-revoked) ডিভাইস — Trusted Devices পেজের জন্য, পূর্ণ তথ্যসহ */
async function listTrustedDevicesPage(userId, currentSid) {
  const r = await pool.query(
    `SELECT id, sid, device_name, device_label, browser, os, device_type, ip, location,
            is_trusted, trusted_at, is_new_device, created_at, last_activity
     FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY is_trusted DESC, last_activity DESC`,
    [userId]
  );
  return r.rows.map(row => ({
    ...row,
    display_name: row.device_label || row.device_name || 'অজানা ডিভাইস',
    is_current: row.sid === currentSid,
  }));
}

/** ডিভাইস রিনেম — নিজের ডিভাইস কিনা মালিকানা যাচাই করে */
async function renameDevice(userId, deviceSessionId, newLabel) {
  const label = String(newLabel || '').trim().slice(0, 100);
  if (!label) return false;
  const r = await pool.query(
    `UPDATE device_sessions SET device_label = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL RETURNING id`,
    [label, deviceSessionId, userId]
  );
  return !!r.rows[0];
}

/**
 * ডিভাইস Trusted/Untrusted টগল করা। Trusted করলে ইমেইল + audit log + রিয়েল-টাইম নোটিফিকেশন পাঠানো হয়
 * (Untrusted করলে শুধু audit log — স্প্যামি ইমেইল এড়াতে, রিমুভের সময়ই যা গুরুত্বপূর্ণ)।
 */
async function setDeviceTrusted(userId, deviceSessionId, trusted, actorLabel) {
  const found = await pool.query(
    `SELECT * FROM device_sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [deviceSessionId, userId]
  );
  if (!found.rows[0]) return false;
  const device = found.rows[0];

  await pool.query(
    `UPDATE device_sessions SET is_trusted = $1, trusted_at = CASE WHEN $1 THEN NOW() ELSE trusted_at END WHERE id = $2`,
    [!!trusted, deviceSessionId]
  );

  await logAdminAction(null, actorLabel || 'SYSTEM', trusted ? 'DEVICE_TRUSTED' : 'DEVICE_UNTRUSTED',
    `ইউজার #${userId} — ডিভাইস "${device.device_label || device.device_name}" ${trusted ? 'Trusted' : 'Untrusted'} করা হয়েছে`, null);

  try {
    const { logEvent } = require('./auditLog');
    await logEvent({
      actorType: 'user', actorId: userId, actorUsername: actorLabel,
      action: trusted ? 'DEVICE_TRUSTED' : 'DEVICE_UNTRUSTED', category: 'security', riskLevel: 'low',
      details: { deviceSessionId, deviceName: device.device_label || device.device_name, ip: device.ip },
    });
  } catch (e) { console.error('auditLog (device trust) error:', e.message); }

  if (trusted) {
    try {
      const u = await pool.query('SELECT email, username FROM users WHERE id = $1', [userId]);
      if (u.rows[0] && u.rows[0].email) {
        await sendDeviceTrustedAlert(u.rows[0].email, {
          username: u.rows[0].username, deviceName: device.device_label || device.device_name,
          ip: device.ip, location: device.location, time: new Date(),
        });
      }
    } catch (e) { console.error('sendDeviceTrustedAlert error (non-blocking):', e.message); }

    try {
      await notifyUser(userId, {
        title: '🔐 ডিভাইস Trusted করা হয়েছে',
        message: `"${device.device_label || device.device_name}" এখন থেকে Trusted ডিভাইস হিসেবে চিহ্নিত।`,
        type: 'security',
      });
    } catch (e) {}
  }

  return true;
}

/**
 * ডিভাইস রিমুভ (লগ-আউট) + Trusted থাকলে ইমেইল সতর্কতা।
 * বিদ্যমান revokeDeviceSession()-কে অপরিবর্তিত রেখে তার উপর একটা wrapper —
 * শুধু রিমুভের আগে ডিভাইসটা trusted ছিল কিনা জেনে নেয়, তারপর একই ফাংশন কল করে।
 */
async function removeDeviceWithNotification(userId, deviceSessionId, actorLabel) {
  const found = await pool.query(
    `SELECT device_name, device_label, ip, location, is_trusted FROM device_sessions
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [deviceSessionId, userId]
  );
  const device = found.rows[0];
  if (!device) return false;

  const ok = await revokeDeviceSession(userId, deviceSessionId, actorLabel);
  if (!ok) return false;

  try {
    const { logEvent } = require('./auditLog');
    await logEvent({
      actorType: 'user', actorId: userId, actorUsername: actorLabel,
      action: 'DEVICE_REMOVED', category: 'security', riskLevel: device.is_trusted ? 'medium' : 'low',
      details: { deviceSessionId, deviceName: device.device_label || device.device_name, ip: device.ip, wasTrusted: device.is_trusted },
    });
  } catch (e) { console.error('auditLog (device remove) error:', e.message); }

  if (device.is_trusted) {
    try {
      const u = await pool.query('SELECT email, username FROM users WHERE id = $1', [userId]);
      if (u.rows[0] && u.rows[0].email) {
        await sendDeviceRemovedAlert(u.rows[0].email, {
          username: u.rows[0].username, deviceName: device.device_label || device.device_name,
          ip: device.ip, location: device.location, time: new Date(),
        });
      }
    } catch (e) { console.error('sendDeviceRemovedAlert error (non-blocking):', e.message); }

    try {
      await notifyUser(userId, {
        title: '🔐 Trusted ডিভাইস সরানো হয়েছে',
        message: `"${device.device_label || device.device_name}" ডিভাইসটি লগ-আউট ও Trusted তালিকা থেকে সরানো হয়েছে।`,
        type: 'security',
      });
    } catch (e) {}
  }

  return true;
}

/** অ্যাডমিন ইউজার ডিটেইল পেজের জন্য — সাম্প্রতিক লগইন + সক্রিয় ডিভাইস */
async function getUserDeviceOverview(userId, limit = 10) {
  const [recentLogins, activeSessions] = await Promise.all([
    listLoginHistory(userId, limit, 0),
    listActiveSessions(userId, null)
  ]);
  return { recentLogins, activeSessions };
}

module.exports = {
  parseUserAgent,
  buildDeviceName,
  computeSignature,
  extractIp,
  lookupLocation,
  recordDeviceLogin,
  touchDeviceActivity,
  listActiveSessions,
  isSessionNewDevice,
  listLoginHistory,
  revokeDeviceSession,
  revokeAllOtherSessions,
  getUserDeviceOverview,
  listTrustedDevicesPage,
  renameDevice,
  setDeviceTrusted,
  removeDeviceWithNotification
};
