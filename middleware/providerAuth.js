// middleware/providerAuth.js
// ---------------------------------------------------------------------------
// প্রোভাইডার কলব্যাক অথেন্টিকেশন — routes/providerWallet.js-এর প্রতিটা রুটে
// সবার আগে বসে। এখানে পাস না করলে ওয়ালেট লেয়ার পর্যন্ত কিছুই পৌঁছায় না।
//
// তিনটা স্বাধীন স্তর, প্রতিটাই একা যথেষ্ট নয় বলেই তিনটাই রাখা হয়েছে:
//
//   ১. IP allow-list — PROVIDER_<NAME>_IPS (কমা-সেপারেটেড)। কনফিগার করা না
//      থাকলে প্রোডাকশনে রিকোয়েস্ট প্রত্যাখ্যাত হয় (fail-closed), কারণ
//      "সেট করতে ভুলে গেছি" আর "সবাইকে অনুমতি" এক জিনিস নয়।
//   ২. HMAC স্বাক্ষর — কাঁচা বডির উপর, timingSafeEqual দিয়ে তুলনা।
//   ৩. timestamp উইন্ডো — ডিফল্ট ৩০ সেকেন্ড, replay ঠেকাতে।
//
// প্রোভাইডার-নির্দিষ্ট স্বাক্ষরের নিয়ম অ্যাডাপ্টারে থাকে (PHASE 3 —
// services/casinoProviders/)। অ্যাডাপ্টার থাকলে তার verifySignature() ব্যবহৃত
// হয়, না থাকলে services/wallet/signature.js-এর সাধারণ HMAC স্কিমে ফলব্যাক।
// এতে PHASE 2 নিজে থেকেই সম্পূর্ণ, আর PHASE 3 কোনো পরিবর্তন ছাড়াই প্লাগ করে।
//
// কোনো সিক্রেট, IP বা প্রোভাইডারের নাম এই ফাইলে হার্ডকোড নেই — সব env থেকে।
// ---------------------------------------------------------------------------

const signature = require('../services/wallet/signature');

/** env key নাম বানানো: "my-provider" → PROVIDER_MY_PROVIDER_IPS */
function envKey(provider, suffix) {
  return `PROVIDER_${String(provider || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`;
}

function allowedIps(provider) {
  return (process.env[envKey(provider, 'IPS')] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * IPv4-mapped IPv6 (::ffff:1.2.3.4) স্বাভাবিক করা — Node-এর socket থেকে
 * প্রায়ই এই রূপে আসে, অথচ প্রোভাইডার সাধারণ IPv4 লিখে দেয়।
 */
function normalizeIp(ip) {
  if (!ip) return '';
  const s = String(ip).trim();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

function isIpAllowed(req, provider) {
  const list = allowedIps(provider);
  if (!list.length) {
    // ডেভেলপমেন্ট/টেস্টে allow-list ছাড়া কাজ করার সুযোগ থাকে, নাহলে লোকাল
    // ইন্টিগ্রেশন টেস্টও চালানো যেত না। প্রোডাকশনে fail-closed।
    return process.env.NODE_ENV !== 'production';
  }
  // app.set('trust proxy', 1) থাকায় req.ip ইতিমধ্যেই আসল ক্লায়েন্ট IP।
  const candidates = [req.ip, req.socket && req.socket.remoteAddress].map(normalizeIp).filter(Boolean);
  const normalized = list.map(normalizeIp);
  return candidates.some(ip => normalized.includes(ip));
}

/** অ্যাডাপ্টার রেজিস্ট্রি থাকলে সেটা, নাহলে null (PHASE 3-এ যুক্ত হয়)। */
function findAdapter(provider) {
  try {
    const registry = require('../services/casinoProviders');
    return registry.get(provider) || null;
  } catch (e) {
    return null; // রেজিস্ট্রি এখনো নেই — সাধারণ স্কিমে চলবে
  }
}

function reject(res, status, code) {
  // ইচ্ছাকৃতভাবে কোনো বিবরণ নেই: কোন স্তরে আটকেছে (IP, স্বাক্ষর, নাকি
  // timestamp) সেটা জানানো মানে আক্রমণকারীকে ওরাকল দেওয়া।
  return res.status(status).json({ success: false, error: code });
}

function providerAuth(req, res, next) {
  const provider = req.params.provider;
  if (!provider || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(provider)) {
    return reject(res, 400, 'INVALID_PROVIDER');
  }

  if (!isIpAllowed(req, provider)) {
    console.warn(`[providerAuth] ${provider}: allow-list-এর বাইরের IP প্রত্যাখ্যাত`);
    return reject(res, 403, 'IP_NOT_ALLOWED');
  }

  const adapter = findAdapter(provider);
  let ok = false;
  try {
    if (adapter && typeof adapter.verifySignature === 'function') {
      ok = !!adapter.verifySignature(req);
    } else {
      const result = signature.verify({
        provider,
        timestamp: req.get('x-timestamp') || (req.body && req.body.timestamp),
        signature: req.get('x-signature') || (req.body && req.body.signature),
        rawBody: req.rawBody || ''
      });
      ok = result.ok;
      if (!ok) console.warn(`[providerAuth] ${provider}: স্বাক্ষর যাচাই ব্যর্থ (${result.reason})`);
    }
  } catch (err) {
    console.error(`[providerAuth] ${provider}: verifySignature error:`, err.message);
    ok = false;
  }

  if (!ok) return reject(res, 401, 'INVALID_SIGNATURE');

  req.providerName = provider;
  req.providerAdapter = adapter;
  next();
}

module.exports = providerAuth;
module.exports.isIpAllowed = isIpAllowed;
module.exports.allowedIps = allowedIps;
module.exports.normalizeIp = normalizeIp;
