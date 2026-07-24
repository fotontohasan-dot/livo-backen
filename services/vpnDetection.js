// ==================== VPN & Proxy Detection System ====================
// লগইন/ট্রানজেকশনের IP পরীক্ষা করে VPN, Proxy বা Tor ব্যবহার শনাক্ত করে এবং একটি
// Risk Score (0-100) হিসাব করে। বাহ্যিক সার্ভিস আনরিচেবল হলে fail-open থাকে —
// অর্থাৎ কখনো লগইন/ট্রানজেকশন ব্লক করে না, শুধু সিগন্যাল রিটার্ন করে।

const https = require('https');
const http = require('http');

const IP_CACHE_TTL_MS = 60 * 60 * 1000;       // প্রতি IP-এর রেজাল্ট ১ ঘণ্টা ক্যাশ থাকে
const TOR_LIST_REFRESH_MS = 6 * 60 * 60 * 1000; // Tor exit node লিস্ট প্রতি ৬ ঘণ্টায় রিফ্রেশ হয়
const FETCH_TIMEOUT_MS = 2500;

const ipCache = new Map(); // ip -> { result, expiresAt }
let torExitNodes = new Set();
let torListLastFetched = 0;
let torListFetching = null;

function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function refreshTorExitList() {
  if (torListFetching) return torListFetching;
  torListFetching = (async () => {
    try {
      const text = await fetchText('https://check.torproject.org/torbulkexitlist');
      const ips = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (ips.length) {
        torExitNodes = new Set(ips);
        torListLastFetched = Date.now();
      }
    } catch (e) {
      console.error('Tor exit list refresh failed (non-blocking):', e.message);
    } finally {
      torListFetching = null;
    }
  })();
  return torListFetching;
}

async function isTorExitNode(ip) {
  if (!ip) return false;
  if (!torListLastFetched || Date.now() - torListLastFetched > TOR_LIST_REFRESH_MS) {
    await refreshTorExitList(); // প্রথমবার/স্টেল হলে অপেক্ষা করে; ব্যর্থ হলে পুরনো/খালি লিস্ট দিয়েই এগোয়
  }
  return torExitNodes.has(ip);
}

// ip-api.com (ফ্রি টিয়ার, কী লাগে না) দিয়ে proxy/hosting শনাক্তকরণ
async function queryIpIntel(ip) {
  try {
    const raw = await fetchText(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,proxy,hosting,isp,org,countryCode`);
    const data = JSON.parse(raw);
    if (data.status !== 'success') return { isProxy: false, isHosting: false, isp: null, countryCode: null };
    return {
      isProxy: !!data.proxy,       // ip-api "proxy" ফ্ল্যাগ VPN/Proxy উভয়ই কভার করে
      isHosting: !!data.hosting,   // ডেটাসেন্টার/হোস্টিং IP — প্রায়ই VPS-based proxy তে ব্যবহৃত হয়
      isp: data.isp || data.org || null,
      countryCode: data.countryCode || null
    };
  } catch (e) {
    console.error('IP intel query failed (non-blocking, fail-open):', e.message);
    return { isProxy: false, isHosting: false, isp: null, countryCode: null };
  }
}

function computeRiskScore({ isTor, isProxy, isHosting }) {
  let score = 0;
  if (isTor) score += 90;
  else if (isProxy) score += 60;
  if (isHosting) score += 20;
  return Math.min(100, score);
}

/**
 * লগইন বা ট্রানজেকশনের সময় IP চেক করে VPN/Proxy/Tor শনাক্ত করে। ফলাফল ক্যাশ করা হয়
 * (একই IP বারবার চেক করলে বাহ্যিক সার্ভিসে চাপ কমে)। নেটওয়ার্ক ব্যর্থ হলে সব false/০ রিটার্ন
 * করে — কখনো কলিং ফ্লো ব্লক করে না।
 */
async function checkIp(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return { ip, isVpn: false, isProxy: false, isTor: false, isHosting: false, riskScore: 0, isp: null, countryCode: null };
  }

  const cached = ipCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const [intel, tor] = await Promise.all([
    queryIpIntel(ip),
    isTorExitNode(ip).catch(() => false)
  ]);

  const result = {
    ip,
    isVpn: intel.isProxy,   // ip-api-তে VPN আলাদা ফ্ল্যাগ নেই, proxy ফ্ল্যাগের আওতায় ধরা হয়
    isProxy: intel.isProxy,
    isTor: !!tor,
    isHosting: intel.isHosting,
    isp: intel.isp,
    countryCode: intel.countryCode,
    riskScore: computeRiskScore({ isTor: !!tor, isProxy: intel.isProxy, isHosting: intel.isHosting })
  };

  ipCache.set(ip, { result, expiresAt: Date.now() + IP_CACHE_TTL_MS });
  return result;
}

module.exports = { checkIp };
