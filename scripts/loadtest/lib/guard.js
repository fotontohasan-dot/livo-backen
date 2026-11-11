// scripts/loadtest/lib/guard.js
// ---------------------------------------------------------------------------
// C3 — লোড টেস্ট শুধু স্পষ্টভাবে নামকরা STAGING-এ চলবে; production ডোমেইনে কখনো নয়।
//
// নিয়ম (সবগুলো পাস না করলে process.exit(2), কোনো নেটওয়ার্ক কল হয় না):
//   1. LOADTEST_STAGING_URL সেট থাকতে হবে (কোনো ডিফল্ট নেই, BASE_URL/PUBLIC_APP_URL থেকে অনুমান করা হয় না)।
//   2. হোস্টনেমে "staging" শব্দ থাকতে হবে, অথবা হোস্টটা LOADTEST_ALLOWED_HOSTS-এ (কমা-ভাগ) স্পষ্ট নামকরা থাকতে হবে।
//   3. হোস্ট production তালিকায় থাকলে — ALLOWED_HOSTS-এ থাকলেও — প্রত্যাখ্যাত। তালিকা: নিচের বিল্ট-ইন + LOADTEST_PRODUCTION_HOSTS।
//   4. হোস্ট এই প্রসেসের PUBLIC_APP_URL / CANONICAL_HOST-এর সমান হলে প্রত্যাখ্যাত (ভুল env থেকে production ধরা পড়ে)।
//   5. https ছাড়া প্রত্যাখ্যাত। ব্যতিক্রম: loopback (localhost/127.0.0.1) শুধু LOADTEST_ALLOW_LOCAL=1 দিলে — নিজের মেশিনে স্মোক টেস্টের জন্য।
// ---------------------------------------------------------------------------

// বিল্ট-ইন production হোস্ট (রিপো থেকে জানা)। নতুন production ডোমেইন যোগ হলে LOADTEST_PRODUCTION_HOSTS-এ দিন।
const BUILTIN_PRODUCTION_HOSTS = ['bet420-backen.onrender.com', 'livo-web.onrender.com'];
// এই প্যাটার্নে মিললেও প্রত্যাখ্যাত (সাবডোমেইন সহ): production-এর সুনির্দিষ্ট ব্র্যান্ড-ডোমেইন
const PRODUCTION_SUFFIXES = ['bet420.com', 'bet420.app'];

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const isLoopback = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';

function hostOf(u) {
  try { return new URL(u).host.toLowerCase(); } catch (_) { return null; }
}

/** @returns {{ ok: true, url: string, host: string } | { ok: false, reason: string }} — pure, টেস্টযোগ্য। */
function checkTarget(raw, env = process.env) {
  if (!raw) return { ok: false, reason: 'LOADTEST_STAGING_URL সেট নেই। staging-এর পুরো URL দিন (যেমন https://livo-web-staging.onrender.com)।' };
  let u;
  try { u = new URL(raw); } catch (_) { return { ok: false, reason: 'LOADTEST_STAGING_URL বৈধ URL নয়।' }; }
  const host = u.host.toLowerCase();
  const hostname = u.hostname.toLowerCase();

  const prodHosts = new Set([...BUILTIN_PRODUCTION_HOSTS, ...list(env.LOADTEST_PRODUCTION_HOSTS)]);
  if (prodHosts.has(host) || prodHosts.has(hostname)) return { ok: false, reason: `${host} একটি production হোস্ট — প্রত্যাখ্যাত।` };
  for (const suf of [...PRODUCTION_SUFFIXES, ...list(env.LOADTEST_PRODUCTION_SUFFIXES)]) {
    if (hostname === suf || hostname.endsWith('.' + suf)) {
      if (!/(^|[.-])staging([.-]|$)/.test(hostname)) return { ok: false, reason: `${host} production ডোমেইনের মতো — প্রত্যাখ্যাত।` };
    }
  }
  const own = [hostOf(env.PUBLIC_APP_URL), (env.CANONICAL_HOST || '').toLowerCase()].filter(Boolean);
  if (own.includes(host) || own.includes(hostname)) return { ok: false, reason: `${host} এই প্রসেসের PUBLIC_APP_URL/CANONICAL_HOST-এর সমান — production হতে পারে, প্রত্যাখ্যাত।` };

  if (isLoopback(hostname)) {
    if (env.LOADTEST_ALLOW_LOCAL !== '1') return { ok: false, reason: 'loopback শুধু LOADTEST_ALLOW_LOCAL=1 দিলে চলে (লোকাল স্মোক টেস্ট)।' };
    return { ok: true, url: u.origin, host, local: true };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'staging URL অবশ্যই https:// হতে হবে।' };

  const isStagingName = /(^|[.-])staging([.-]|$)/.test(hostname);
  const allowed = list(env.LOADTEST_ALLOWED_HOSTS);
  if (!isStagingName && !allowed.includes(host) && !allowed.includes(hostname)) {
    return { ok: false, reason: `${host}-এর নামে "staging" নেই এবং LOADTEST_ALLOWED_HOSTS-এ স্পষ্টভাবে দেওয়াও নেই।` };
  }
  return { ok: true, url: u.origin, host };
}

/** DB URL-এর জন্য একই যুক্তি (seed/pg-report): হোস্টে "staging" বা LOADTEST_ALLOWED_DB_HOSTS-এ স্পষ্ট; production তালিকায় নয়। */
function checkDbTarget(raw, env = process.env) {
  if (!raw) return { ok: false, reason: 'LOADTEST_DB_URL সেট নেই (staging ডাটাবেসের কানেকশন স্ট্রিং)।' };
  let u;
  try { u = new URL(raw); } catch (_) { return { ok: false, reason: 'LOADTEST_DB_URL বৈধ URL নয়।' }; }
  const host = u.hostname.toLowerCase();
  if (list(env.LOADTEST_PRODUCTION_DB_HOSTS).includes(host)) return { ok: false, reason: `${host} production DB হোস্ট — প্রত্যাখ্যাত।` };
  if (env.DATABASE_URL && hostOf(env.DATABASE_URL.replace(/^postgres(ql)?:/, 'http:')) === hostOf(raw.replace(/^postgres(ql)?:/, 'http:'))) {
    return { ok: false, reason: 'LOADTEST_DB_URL এই প্রসেসের DATABASE_URL-এর হোস্টের সমান — প্রত্যাখ্যাত।' };
  }
  const dbName = (u.pathname || '').replace(/^\//, '').toLowerCase();
  const stagingish = /staging/.test(host) || /staging/.test(dbName);
  const allowed = list(env.LOADTEST_ALLOWED_DB_HOSTS);
  if (!stagingish && !allowed.includes(host)) return { ok: false, reason: `${host}/${dbName}-এ "staging" নেই এবং LOADTEST_ALLOWED_DB_HOSTS-এ স্পষ্টভাবে দেওয়াও নেই।` };
  return { ok: true, url: raw, host, dbName };
}

function assertStagingTarget(env = process.env) {
  const r = checkTarget(env.LOADTEST_STAGING_URL, env);
  if (!r.ok) {
    console.error(`❌ লোড টেস্ট বাতিল: ${r.reason}`);
    process.exit(2);
  }
  return r;
}

function assertStagingDb(env = process.env) {
  const r = checkDbTarget(env.LOADTEST_DB_URL, env);
  if (!r.ok) {
    console.error(`❌ বাতিল: ${r.reason}`);
    process.exit(2);
  }
  return r;
}

module.exports = { checkTarget, checkDbTarget, assertStagingTarget, assertStagingDb, BUILTIN_PRODUCTION_HOSTS };
