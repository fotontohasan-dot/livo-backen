// utils/stagingGuard.js
// ---------------------------------------------------------------------------
// staging-এ আসল পেমেন্ট/প্রোভাইডারে ভুলে কল যাওয়া ঠেকানোর বিশুদ্ধ হেল্পার।
// কোনো সিক্রেট এখানে পড়া/ছাপা হয় না — শুধু নাম ও হোস্টনাম-ভিত্তিক সিদ্ধান্ত।
// ---------------------------------------------------------------------------

/** APP_ENV বা NODE_ENV 'staging' হলে true (render.staging.yaml-এ APP_ENV=staging)। */
function isStaging(env = process.env) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  return norm(env.APP_ENV) === 'staging' || norm(env.NODE_ENV) === 'staging';
}

const SSLCZ_LIVE_URL = 'https://securepay.sslcommerz.com';
const SSLCZ_SANDBOX_URL = 'https://sandbox.sslcommerz.com';

/**
 * SSLCommerz-এর বেস URL। live কেবল তখনই যখন SSLCZ_IS_LIVE ঠিক 'true' **এবং**
 * এটা staging নয়। staging-এ SSLCZ_IS_LIVE=true বসে গেলেও (যেমন env গ্রুপে ভুল করে)
 * সবসময় sandbox।
 * @returns {{ live: boolean, baseUrl: string, blockedLiveInStaging: boolean }}
 */
function resolveSslczMode(env = process.env) {
  const requested = env.SSLCZ_IS_LIVE === 'true';
  const blocked = requested && isStaging(env);
  const live = requested && !blocked;
  return { live, baseUrl: live ? SSLCZ_LIVE_URL : SSLCZ_SANDBOX_URL, blockedLiveInStaging: blocked };
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch (_) { return ''; }
}
const looksMock = (url) => hostOf(url).includes('mock');

/**
 * staging-এ কোন প্রোভাইডার মক নয় (আসল হোস্টে যেতে পারে)। শুধু নামের তালিকা ফেরত দেয়।
 * "সক্রিয়" মানে কী/URL সেট আছে; "মক" মানে মক হোস্টে ঘোরানো বা কী 'mock'।
 */
function nonMockProviders(env = process.env) {
  const out = [];
  const overrideOn = env.ALLOW_PROVIDER_BASE_URL_OVERRIDE === 'true';

  if (env.CRICKET_API_KEY) {
    const redirected = overrideOn && env.CRICKET_API_BASE_URL && looksMock(env.CRICKET_API_BASE_URL);
    if (!redirected) out.push('sports:cricket (CRICKET_API_KEY সেট, মক URL-এ ঘোরানো নয়)');
  }
  if (env.RAPIDAPI_KEY) {
    const redirected = overrideOn && env.FOOTBALL_API_BASE_URL && looksMock(env.FOOTBALL_API_BASE_URL);
    if (!redirected) out.push('sports:football (RAPIDAPI_KEY সেট, মক URL-এ ঘোরানো নয়)');
  }
  if (env.SMS_API_URL && env.SMS_API_KEY) {
    if (!looksMock(env.SMS_API_URL)) out.push('sms (SMS_API_URL মক হোস্ট নয়)');
  }
  for (const k of Object.keys(env)) {
    const m = /^PROVIDER_(.+)_API_URL$/.exec(k);
    if (!m || !env[k]) continue;
    if (m[1] === 'MOCK_CASINO' || looksMock(env[k])) continue;
    out.push(`casino:${m[1].toLowerCase()} (${k} মক হোস্ট নয়)`);
  }
  if (env.SSLCZ_STORE_ID && env.SSLCZ_STORE_PASSWD) {
    out.push('payment:sslcommerz (স্টোর কী সেট; staging-এ সবসময় sandbox URL, live ব্লক করা)');
  }
  return out;
}

/**
 * APP_ENV সেট নেই, অথচ পরিবেশ দেখে staging মনে হচ্ছে (Render সার্ভিসের নাম বা PUBLIC_APP_URL-এ "staging")।
 * তাহলে সতর্কতার বার্তা ফেরত দেয়, নইলে null। কোনো মান ছাপে না — শুধু ভেরিয়েবলের নাম।
 */
function stagingWithoutAppEnvWarning(env = process.env) {
  if (String(env.APP_ENV || '').trim()) return null;
  const svc = String(env.RENDER_SERVICE_NAME || '');
  const url = hostOf(env.PUBLIC_APP_URL || '');
  if (/staging/i.test(svc) || /staging/i.test(url)) {
    return 'APP_ENV সেট নেই, অথচ এটি staging পরিবেশ মনে হচ্ছে (সার্ভিসের নাম/PUBLIC_APP_URL দেখে)। '
      + 'staging-এর সুরক্ষা (SSLCommerz sandbox-এ বাধ্য রাখা, DB SSL আচরণ, প্রোভাইডার যাচাই) সক্রিয় হবে না। APP_ENV=staging বসান।';
  }
  return null;
}

module.exports = { isStaging, stagingWithoutAppEnvWarning, resolveSslczMode, nonMockProviders, SSLCZ_LIVE_URL, SSLCZ_SANDBOX_URL };
