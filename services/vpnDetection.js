// services/vpnDetection.js
// VPN / Proxy / Tor / Hosting-IP ডিটেকশন। কখনো ইউজারকে ব্লক করে না — শুধু অ্যাডমিন রিভিউয়ের জন্য ফ্ল্যাগ করে।
// অ্যাডমিন সেটিংস থেকে পুরো ফিচারটা enable/disable করা যায় (site_settings.vpn_detection_enabled)।

const { pool } = require('../db');
const { getSetting } = require('./settings');
const { logAdminAction } = require('./fraudDetection');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // ৬ ঘণ্টা — বারবার একই IP-এর জন্য API কল না করার জন্য
const FETCH_TIMEOUT_MS = 3000; // ধীর/আটকে থাকা API কল যাতে লগইন/ডিপোজিট আটকে না রাখে

function isPrivateOrLocalIp(ip) {
  if (!ip) return true;
  return /^(127\.|10\.|192\.168\.|::1|localhost)/.test(ip) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}

async function isWhitelisted(ip) {
  if (!ip) return false;
  const r = await pool.query(`SELECT 1 FROM trusted_ips WHERE ip = $1`, [ip]);
  return r.rows.length > 0;
}

async function getCachedIntel(ip) {
  const r = await pool.query(`SELECT * FROM ip_intel_cache WHERE ip = $1`, [ip]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  if (Date.now() - new Date(row.checked_at).getTime() > CACHE_TTL_MS) return null;
  return row;
}

async function saveCachedIntel(ip, intel) {
  await pool.query(
    `INSERT INTO ip_intel_cache (ip, is_vpn, is_proxy, is_tor, is_hosting, risk_level, provider, details, checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (ip) DO UPDATE SET
       is_vpn = EXCLUDED.is_vpn, is_proxy = EXCLUDED.is_proxy, is_tor = EXCLUDED.is_tor,
       is_hosting = EXCLUDED.is_hosting, risk_level = EXCLUDED.risk_level,
       provider = EXCLUDED.provider, details = EXCLUDED.details, checked_at = NOW()`,
    [ip, intel.isVpn, intel.isProxy, intel.isTor, intel.isHosting, intel.riskLevel, intel.provider, JSON.stringify(intel.raw || {})]
  );
}

function computeRiskLevel({ isVpn, isProxy, isTor, isHosting }) {
  if (isTor) return 'high';
  if (isVpn || isProxy) return 'medium';
  if (isHosting) return 'medium';
  return 'low';
}

/**
 * proxycheck.io ব্যবহার করে IP ইন্টেলিজেন্স আনা হয় (vpn/proxy/tor/hosting সবকিছু এক কলেই পাওয়া যায়)।
 * API key কনফিগার করা না থাকলে বা রিকোয়েস্ট ব্যর্থ হলে null রিটার্ন করে — কখনো এরর থ্রো করে না।
 */
async function fetchFromProvider(ip) {
  const apiKey = await getSetting('vpn_detection_api_key');
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `https://proxycheck.io/v2/${encodeURIComponent(ip)}?key=${encodeURIComponent(apiKey)}&vpn=1&asn=1&risk=1`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = await resp.json();
    const entry = data && data[ip];
    if (!entry) return null;

    const isProxyFlag = entry.proxy === 'yes';
    const type = (entry.type || '').toLowerCase();
    const isTor = isProxyFlag && type === 'tor';
    const isVpn = isProxyFlag && type === 'vpn';
    const isHosting = isProxyFlag && ['hosting', 'datacenter', 'business', 'compromised'].includes(type);
    const isGenericProxy = isProxyFlag && !isTor && !isVpn && !isHosting;

    return {
      isVpn, isProxy: isGenericProxy, isTor, isHosting,
      provider: 'proxycheck.io',
      raw: entry
    };
  } catch (err) {
    console.error('VPN detection provider error (non-blocking):', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * লগইন/সাইনআপ/ডিপোজিট/উইথড্রর সময় কল হয়। কখনো রিকোয়েস্ট ব্লক করে না।
 * context: 'login' | 'signup' | 'deposit' | 'withdraw'
 */
async function evaluateIp(userId, ip, context) {
  try {
    const enabled = (await getSetting('vpn_detection_enabled')) === 'true';
    if (!enabled) return null;
    if (!ip || isPrivateOrLocalIp(ip)) return null;
    if (await isWhitelisted(ip)) return null;

    let intel = await getCachedIntel(ip);
    if (!intel) {
      const fetched = await fetchFromProvider(ip);
      if (!fetched) return null; // provider অনুপলব্ধ/আনকনফিগার্ড — silently skip, ইউজার প্রভাবিত হয় না
      intel = {
        is_vpn: fetched.isVpn, is_proxy: fetched.isProxy, is_tor: fetched.isTor, is_hosting: fetched.isHosting,
        risk_level: computeRiskLevel({ isVpn: fetched.isVpn, isProxy: fetched.isProxy, isTor: fetched.isTor, isHosting: fetched.isHosting }),
        provider: fetched.provider, details: fetched.raw
      };
      await saveCachedIntel(ip, {
        isVpn: intel.is_vpn, isProxy: intel.is_proxy, isTor: intel.is_tor, isHosting: intel.is_hosting,
        riskLevel: intel.risk_level, provider: intel.provider, raw: intel.details
      });
    }

    const { is_vpn, is_proxy, is_tor, is_hosting, risk_level, provider, details } = intel;
    if (!is_vpn && !is_proxy && !is_tor && !is_hosting) return null; // ক্লিন IP — লগ করার দরকার নেই

    const inserted = await pool.query(
      `INSERT INTO vpn_detections (user_id, ip, context, is_vpn, is_proxy, is_tor, is_hosting, risk_level, provider, details, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open') RETURNING *`,
      [userId, ip, context, is_vpn, is_proxy, is_tor, is_hosting, risk_level,
        provider, typeof details === 'string' ? details : JSON.stringify(details || {})]
    );
    const detection = inserted.rows[0];

    const typeLabels = [];
    if (is_tor) typeLabels.push('Tor');
    if (is_vpn) typeLabels.push('VPN');
    if (is_proxy && !is_vpn && !is_tor) typeLabels.push('Proxy');
    if (is_hosting) typeLabels.push('Hosting/Datacenter');

    await logAdminAction(
      null, 'SYSTEM', 'VPN_DETECTION_FLAG',
      `ইউজার #${userId} — ${context} — IP ${ip} — ${typeLabels.join(', ')} — ঝুঁকি: ${risk_level.toUpperCase()}`,
      null
    );

    return detection;
  } catch (err) {
    console.error('evaluateIp error (non-blocking):', err.message);
    return null;
  }
}

async function getUserVpnStatus(userId) {
  const r = await pool.query(
    `SELECT * FROM vpn_detections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  const detections = r.rows;
  const order = { high: 3, medium: 2, low: 1 };
  let currentRiskLevel = 'none';
  for (const d of detections) {
    if (d.status !== 'open') continue;
    if (!order[currentRiskLevel] || order[d.risk_level] > order[currentRiskLevel]) currentRiskLevel = d.risk_level;
  }
  return {
    currentRiskLevel,
    openCount: detections.filter(d => d.status === 'open').length,
    detections
  };
}

module.exports = {
  evaluateIp,
  getUserVpnStatus,
  isWhitelisted
};
