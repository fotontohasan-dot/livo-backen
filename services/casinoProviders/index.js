// services/casinoProviders/index.js
// ---------------------------------------------------------------------------
// ক্যাসিনো প্রোভাইডার রেজিস্ট্রি — নতুন প্রোভাইডার যোগ করার একমাত্র জায়গা।
//
// কাঠামোটা ইচ্ছাকৃতভাবে services/providers/index.js-এর (স্পোর্টস) হুবহু
// সমান্তরাল — একই ধারণা দুই জায়গায় দুইরকম দেখালে রক্ষণাবেক্ষণে ভুল হয়।
//
// নতুন প্রোভাইডার যোগ করতে ঠিক দুটো পরিবর্তন লাগে:
//   ১. services/casinoProviders/<name>.js (_template.js কপি করে)
//   ২. নিচের ADAPTERS অ্যারেতে একটা লাইন
// কোর অ্যাপের আর কোথাও কিছু বদলায় না — লবি, লঞ্চ, ওয়ালেট, অ্যাডমিন সবই
// রেজিস্ট্রি ও DB থেকে চলে।
//
// কনফিগারেশন:
//   PROVIDER_<NAME>_*             → অ্যাডাপ্টারের isEnabled() শুধু এটাই দেখে
//   CASINO_PROVIDERS              → ঐচ্ছিক allow-list; খালি হলে সবই সক্রিয়
//   CASINO_SYNC_INTERVAL_MINUTES  → ঐচ্ছিক, ডিফল্ট ৩৬০ (৬ ঘণ্টা)
//
// কোনো ক্রেডেনশিয়াল এখানে বা কোথাও হার্ডকোড করা নেই।
// ---------------------------------------------------------------------------

const mockCasino = require('./mockCasino');

// _template.js ইচ্ছাকৃতভাবে এখানে নেই — ওটা কপি করার নমুনা, চালানোর জন্য নয়।
const ADAPTERS = [mockCasino];

function allowList() {
  return (process.env.CASINO_PROVIDERS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * যেসব অ্যাডাপ্টার (ক) কনফিগার করা আছে এবং (খ) allow-list-এ অনুমোদিত।
 * isEnabled() থ্রো করলে সেই অ্যাডাপ্টার নীরবে বাদ যায় — একটা ভুল কনফিগার
 * করা প্রোভাইডার যেন বাকিদের sync আটকে না দেয়।
 */
function getEnabledProviders() {
  const allow = allowList();
  return ADAPTERS.filter((adapter) => {
    if (allow.length && !allow.includes(adapter.name)) return false;
    try {
      return adapter.isEnabled();
    } catch (e) {
      console.error(`[casinoProvider:${adapter.name}] isEnabled error:`, e.message);
      return false;
    }
  });
}

/** নাম দিয়ে একটা অ্যাডাপ্টার — সক্রিয় না হলে null। */
function get(name) {
  return getEnabledProviders().find(a => a.name === name) || null;
}

function getSyncIntervalMs() {
  const minutes = parseInt(process.env.CASINO_SYNC_INTERVAL_MINUTES || '360', 10);
  // অস্বাভাবিক ছোট ইন্টারভাল প্রোভাইডারের rate limit ভাঙতে পারে — নিচে ১৫ মিনিটে আটকানো
  const safe = Number.isFinite(minutes) && minutes >= 15 ? minutes : 360;
  return safe * 60 * 1000;
}

module.exports = { ADAPTERS, getEnabledProviders, get, getSyncIntervalMs };
