// services/providers/index.js
// ---------------------------------------------------------------------------
// প্রোভাইডার রেজিস্ট্রি — নতুন স্পোর্টস API যোগ করার একমাত্র জায়গা।
//
// নতুন প্রোভাইডার যোগ করার ধাপ (কোর অ্যাপে কোনো পরিবর্তন লাগে না):
//   ১. services/providers/<name>.js লিখে { name, sport, isEnabled, fetchMatches }
//      এক্সপোর্ট করুন; fetchMatches() normalizedMatch আকারে অ্যারে ফেরত দেবে।
//   ২. নিচের ADAPTERS তালিকায় যোগ করুন।
//   ৩. অ্যাডাপ্টারের ইউনিট টেস্ট লিখুন (নেটওয়ার্ক ছাড়া, normalizeOne দিয়ে)।
//   ৪. Render-এ ক্রেডেনশিয়াল env var সেট করুন — isEnabled() সেটাই দেখে।
//   ৫. ডিপ্লয়।
//
// কনফিগারেশন (Part 8) — বিদ্যমান env var নাম অপরিবর্তিত রাখা হয়েছে:
//   RAPIDAPI_KEY               → football-rapidapi সক্রিয় হয় (আগের মতোই)
//   CRICKET_API_KEY            → cricket-cricapi সক্রিয় হয় (আগের মতোই)
//   SPORTS_PROVIDERS           → ঐচ্ছিক, কমা-সেপারেটেড allow-list; না দিলে সবই সক্রিয়
//   MATCH_SYNC_INTERVAL_MINUTES→ ঐচ্ছিক, ডিফল্ট ১৫ (আগের হার্ডকোড মানই ডিফল্ট)
//
// কোনো ক্রেডেনশিয়াল এখানে বা কোথাও হার্ডকোড করা নেই।
// ---------------------------------------------------------------------------

const footballRapidApi = require('./footballRapidApi');
const cricApi = require('./cricApi');

const ADAPTERS = [footballRapidApi, cricApi];

/**
 * যেসব অ্যাডাপ্টার (ক) কনফিগার করা আছে এবং (খ) allow-list-এ অনুমোদিত, সেগুলো ফেরত দেয়।
 */
function getEnabledProviders() {
  const allowList = (process.env.SPORTS_PROVIDERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return ADAPTERS.filter((adapter) => {
    if (allowList.length && !allowList.includes(adapter.name)) return false;
    try {
      return adapter.isEnabled();
    } catch (e) {
      console.error(`[provider:${adapter.name}] isEnabled error:`, e.message);
      return false;
    }
  });
}

function getSyncIntervalMs() {
  const minutes = parseInt(process.env.MATCH_SYNC_INTERVAL_MINUTES || '15', 10);
  // অস্বাভাবিক ছোট ইন্টারভাল প্রোভাইডারের rate limit ভাঙতে পারে — নিচে ৫ মিনিটে আটকানো
  const safe = Number.isFinite(minutes) && minutes >= 5 ? minutes : 15;
  return safe * 60 * 1000;
}

module.exports = { ADAPTERS, getEnabledProviders, getSyncIntervalMs };
