// services/integrationRegistry.js
// ==================== ইন্টিগ্রেশনের তালিকা ও "কনফিগার্ড কিনা" (শুধু true/false) ====================
// ⚠️ এই ফাইল কোনো env *মান* কোথাও পাঠায় না — computeEnvFlags() শুধু boolean ফেরত দেয়।
// নাম (যেমন "wallet:bkash") env ভেরিয়েবলের *নাম* থেকে আসে, মান থেকে নয়।

const GROUPS = ['sports', 'casino', 'payment', 'messaging', 'media'];

// কোন env দরকার: all = সবগুলো থাকতে হবে, any = অন্তত একটা
const STATIC_INTEGRATIONS = [
  { id: 'sports:cricapi',   group: 'sports',    label: 'Cricket API (CricAPI)', all: ['CRICKET_API_KEY'] },
  { id: 'sports:rapidapi',  group: 'sports',    label: 'Football (RapidAPI)',   all: ['RAPIDAPI_KEY'] },
  { id: 'payment:sslcommerz', group: 'payment', label: 'SSLCommerz (পেমেন্ট গেটওয়ে)', all: ['SSLCZ_STORE_ID', 'SSLCZ_STORE_PASSWD'] },
  { id: 'wallet:bkash',     group: 'payment',   label: 'bKash (ওয়ালেট callback)', all: ['WALLET_CALLBACK_BKASH_SECRET'], anyOf: ['WALLET_CALLBACK_BKASH_PUBLIC_KEY'], orAll: true },
  { id: 'wallet:nagad',     group: 'payment',   label: 'Nagad (ওয়ালেট callback)', all: ['WALLET_CALLBACK_NAGAD_SECRET'], anyOf: ['WALLET_CALLBACK_NAGAD_PUBLIC_KEY'], orAll: true },
  { id: 'sms',              group: 'messaging', label: 'SMS গেটওয়ে',            all: ['SMS_API_URL', 'SMS_API_KEY'] },
  { id: 'email',            group: 'messaging', label: 'Email (SMTP)',          all: ['EMAIL_USER', 'EMAIL_PASS'] },
  { id: 'telegram',         group: 'messaging', label: 'Telegram',              all: ['TELEGRAM_BOT_TOKEN'], any: ['TELEGRAM_CHAT_ID', 'TELEGRAM_ADMIN_CHAT_ID'] },
  { id: 'cloudinary',       group: 'media',     label: 'Cloudinary',            all: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] }
];

const present = (env, k) => String(env[k] === undefined || env[k] === null ? '' : env[k]).trim() !== '';

function isConfigured(def, env) {
  const allOk = (def.all || []).every((k) => present(env, k));
  // ওয়ালেট callback: SECRET অথবা PUBLIC_KEY যেকোনো একটা (HMAC বা RSA)
  if (def.orAll) return allOk || (def.anyOf || []).some((k) => present(env, k));
  const anyOk = !def.any || def.any.some((k) => present(env, k));
  return allOk && anyOk;
}

/** কেসিনো অ্যাডাপ্টারের নাম → [{id,label,group,all}] (API_URL/AGENT_ID/SECRET লাগে, dbGames-এর isEnabled-এর মতো) */
function casinoDefs() {
  let adapters = [];
  try { adapters = require('./casinoProviders').ADAPTERS || []; } catch (_) { adapters = []; }
  return adapters
    .filter((a) => a && a.name && !/^mock/i.test(a.name))
    .map((a) => {
      const p = `PROVIDER_${String(a.name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
      return { id: `casino:${a.name}`, group: 'casino', label: `Casino — ${a.name}`, all: [p + 'API_URL', p + 'AGENT_ID', p + 'SECRET'] };
    });
}

/** env-এ যেসব wallet callback নাম পাওয়া যায় (bkash/nagad ছাড়াও) — নাম শুধু ভেরিয়েবলের নাম থেকে। */
function dynamicWalletDefs(env) {
  const seen = new Set(['BKASH', 'NAGAD']);
  const defs = [];
  for (const key of Object.keys(env)) {
    const m = /^WALLET_CALLBACK_([A-Z0-9]+)_(SECRET|PUBLIC_KEY)$/.exec(key);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    defs.push({
      id: `wallet:${m[1].toLowerCase()}`, group: 'payment', label: `${m[1]} (ওয়ালেট callback)`,
      all: [`WALLET_CALLBACK_${m[1]}_SECRET`], anyOf: [`WALLET_CALLBACK_${m[1]}_PUBLIC_KEY`], orAll: true
    });
  }
  return defs;
}

function listIntegrations(env = process.env) {
  return [...STATIC_INTEGRATIONS, ...casinoDefs(), ...dynamicWalletDefs(env)];
}

/** { [id]: boolean } — মান কখনো নয়। */
function computeEnvFlags(env = process.env) {
  const flags = {};
  for (const def of listIntegrations(env)) flags[def.id] = isConfigured(def, env);
  return flags;
}

/** env ভেরিয়েবলের *নাম* যাতে কোনো মান সম্ভাব্য গোপন — sanitize ও টেস্টে ব্যবহৃত। */
function secretEnvNames(env = process.env) {
  return Object.keys(env).filter((k) => /(SECRET|PASS|PASSWD|PASSWORD|TOKEN|KEY|PRIVATE|SIGN|DSN|URL)/i.test(k) && !/^(PUBLIC_APP_URL|CANONICAL_HOST)$/.test(k));
}

module.exports = { GROUPS, listIntegrations, computeEnvFlags, isConfigured, secretEnvNames };
