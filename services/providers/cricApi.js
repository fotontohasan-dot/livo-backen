// services/providers/cricApi.js
// ---------------------------------------------------------------------------
// বিদ্যমান ক্রিকেট ইন্টিগ্রেশনের অ্যাডাপ্টার (api.cricapi.com currentMatches)।
//
// প্রোডাকশন আচরণ অপরিবর্তিত — একই এন্ডপয়েন্ট, একই ক্যাশ, একই স্ট্যাটাস রেগেক্স।
// services/sportsAPI.js-এর বিদ্যমান ফাংশনটাই ব্যবহার করা হয়।
//
// league সম্পর্কে (Part 7): cricapi-র currentMatches রেসপন্সে সিরিজের *নাম* সবসময়
// আলাদা ফিল্ডে আসে না — যা নিশ্চিতভাবে আসে তা হলো series_id (একটা UUID) ও matchType।
// UUID কোনো পাঠযোগ্য লিগ নাম নয়, আর matchType ('odi'/'t20'/'test') ফরম্যাট, লিগ নয়।
// তাই এখানে শুধু তখনই league সেট করা হয় যখন প্রোভাইডার সত্যিই নাম-জাতীয় ফিল্ড দেয়
// (`series`/`seriesName`)। না দিলে league null-ই থাকে — অনুমান করে বানানো হয় না।
// series_id ও matchType হারায় না, provider_metadata-তে সংরক্ষিত থাকে।
// ---------------------------------------------------------------------------

const sportsAPI = require('../sportsAPI');
const { buildNormalizedMatch } = require('./normalizedMatch');

const PROVIDER = 'cricket-cricapi';

// বিদ্যমান matchUpdater.js-এর রেগেক্সটাই হুবহু রাখা হয়েছে, সাথে স্পষ্ট 'finished' সংকেত।
function mapStatus(raw) {
  const s = String(raw || '');
  if (/won by|match drawn|abandoned|no result|tied/i.test(s)) return 'finished';
  if (/live|innings|need|require|opt to/i.test(s)) return 'live';
  return 'upcoming';
}

// cricapi স্কোর অ্যারে: [{ r: runs, w: wickets, o: overs, inning: '...' }, ...]
function formatScore(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.r === undefined && entry.w === undefined) return null;
  return `${entry.r ?? 0}/${entry.w ?? 0}`;
}

function isEnabled() {
  return Boolean(process.env.CRICKET_API_KEY);
}

function normalizeOne(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const externalId = raw.id != null && String(raw.id).trim() !== '' ? String(raw.id) : null;
  if (!externalId) return null; // cricapi-র নিজস্ব স্থায়ী আইডি ছাড়া idempotent সেভ সম্ভব নয়

  const teams = Array.isArray(raw.teams) ? raw.teams : [];
  const score = Array.isArray(raw.score) ? raw.score : [];

  // প্রোভাইডার নাম-জাতীয় সিরিজ ফিল্ড দিলে সেটাই league; নইলে null (Part 7)
  const league = raw.series || raw.seriesName || null;

  const metadata = {};
  if (raw.series_id) metadata.series_id = raw.series_id;
  if (raw.matchType) metadata.match_type = raw.matchType;
  if (raw.venue) metadata.venue = raw.venue;

  return buildNormalizedMatch({
    provider: PROVIDER,
    externalId,
    sport: 'cricket',
    title: raw.name,
    league,
    teamA: teams[0],
    teamB: teams[1],
    status: mapStatus(raw.status),
    scoreA: formatScore(score[0]),
    scoreB: formatScore(score[1]),
    overs: score[0] && score[0].o !== undefined ? String(score[0].o) : null,
    startTime: raw.dateTimeGMT || raw.date || null,
    metadata: Object.keys(metadata).length ? metadata : null
  });
}

async function fetchMatches() {
  if (!isEnabled()) return [];
  try {
    const raw = await sportsAPI.getCricketCurrentMatches();
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeOne).filter(Boolean);
  } catch (err) {
    console.error(`[provider:${PROVIDER}] fetch error:`, err.message);
    return [];
  }
}

module.exports = { name: PROVIDER, sport: 'cricket', isEnabled, fetchMatches, normalizeOne, mapStatus, formatScore };
