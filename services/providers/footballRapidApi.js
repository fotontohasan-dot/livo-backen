// services/providers/footballRapidApi.js
// ---------------------------------------------------------------------------
// বিদ্যমান ফুটবল ইন্টিগ্রেশনের অ্যাডাপ্টার (today-football-prediction @ RapidAPI)।
//
// গুরুত্বপূর্ণ: এখানে প্রোডাকশনের আচরণ ইচ্ছাকৃতভাবে অপরিবর্তিত রাখা হয়েছে —
// একই এন্ডপয়েন্ট, একই `federation=UEFA`, একই `market=classic_1x2`, একই আজকের
// তারিখ, একই ৫ মিনিটের ক্যাশ। services/sportsAPI.js-এর বিদ্যমান ফাংশনটাই ব্যবহার
// করা হয়, যাতে HTTP/ক্যাশ লজিক ডুপ্লিকেট না হয় এবং ফলাফল হুবহু আগের মতোই থাকে।
// শুধু প্রোভাইডার-নির্দিষ্ট *ম্যাপিং* কোর থেকে সরে এখানে এসেছে।
//
// ভবিষ্যতে সব প্রতিযোগিতা আনতে হলে সেটা এখানে (বা কনফিগে) সচেতনভাবে বদলাতে হবে —
// নিঃশব্দে প্রসারিত করা হয়নি, কারণ তাতে API কোটা ও ফ্রন্টএন্ডের ফলাফল দুটোই বদলে যেত।
// ---------------------------------------------------------------------------

const sportsAPI = require('../sportsAPI');
const { buildNormalizedMatch } = require('./normalizedMatch');

const PROVIDER = 'football-rapidapi';

// প্রোভাইডারের status স্ট্রিং → আমাদের তিনটা স্ট্যাটাসের একটা।
// বিদ্যমান matchUpdater.js-এর রেগেক্সটাই হুবহু রাখা হয়েছে।
function mapStatus(raw) {
  if (raw && /live|1h|2h|ht/i.test(String(raw))) return 'live';
  if (raw && /^(ft|finished|ended)$/i.test(String(raw).trim())) return 'finished';
  return 'upcoming';
}

function isEnabled() {
  return Boolean(process.env.RAPIDAPI_KEY);
}

/**
 * প্রোভাইডারের কাঁচা রেসপন্স আইটেমকে normalized রেকর্ডে রূপান্তর করে।
 * আলাদা করে export করা হয়েছে যাতে নেটওয়ার্ক ছাড়াই ইউনিট টেস্ট করা যায়।
 */
function normalizeOne(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // sportsAPI ইতিমধ্যে id না থাকলে `home-away` ফলব্যাক বসায়। সেই ফলব্যাকটাই স্থায়ী
  // পরিচয় হিসেবে ব্যবহৃত হয় — আদর্শ নয়, কিন্তু প্রোভাইডার আসল আইডি না দিলে এটাই
  // সবচেয়ে স্থিতিশীল যা পাওয়া যায়, আর provider প্রিফিক্স থাকায় অন্য প্রোভাইডারের
  // সাথে সংঘর্ষ হয় না।
  const externalId = raw.id != null && String(raw.id).trim() !== ''
    ? String(raw.id)
    : null;
  if (!externalId) return null;

  return buildNormalizedMatch({
    provider: PROVIDER,
    externalId,
    sport: 'football',
    title: raw.name,
    league: raw.league,
    teamA: raw.homeTeam,
    teamB: raw.awayTeam,
    status: mapStatus(raw.status),
    scoreA: raw.homeScore,
    scoreB: raw.awayScore,
    overs: null, // ফুটবলে প্রযোজ্য নয়
    startTime: raw.date || null,
    metadata: null
  });
}

/**
 * প্রোভাইডার থেকে ম্যাচ এনে normalized তালিকা ফেরত দেয়।
 * কখনো throw করে না — ব্যর্থ হলে খালি অ্যারে, যাতে একটা প্রোভাইডার ডাউন থাকলেও
 * বাকি প্রোভাইডারের সিঙ্ক ও মূল অ্যাপ চলতে থাকে।
 */
async function fetchMatches() {
  if (!isEnabled()) return [];
  try {
    const raw = await sportsAPI.getFootballLiveScores();
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeOne).filter(Boolean);
  } catch (err) {
    console.error(`[provider:${PROVIDER}] fetch error:`, err.message);
    return [];
  }
}

module.exports = { name: PROVIDER, sport: 'football', isEnabled, fetchMatches, normalizeOne, mapStatus };
