// services/dataFreshness.js
// ==================== A1: বাসি (stale) স্পোর্টস ডেটা — fail-closed নীতি ====================
// নিয়ম: বাজি গ্রহণ ও সেটলমেন্ট কখনো বাসি ডেটায় চলবে না।
//   • বাজি: প্রোভাইডার/ফিড-সিঙ্ক করা ম্যাচের `synced_at` সীমার চেয়ে পুরনো (বা নেই) হলে প্রত্যাখ্যান।
//     হাতে (অ্যাডমিন) তৈরি ম্যাচে (provider NULL) কোনো ফিড নেই, তাই বাসি ধারণা প্রযোজ্য নয়।
//   • সেটলমেন্ট: শুধু অ্যাডমিন-নিশ্চিত ফলাফল; প্রোভাইডার ডেটা লাগলে অবশ্যই fresh।
// সীমা: SPORTS_DATA_MAX_AGE_MS, ডিফল্ট = সিঙ্ক ইন্টারভালের ২ গুণ (ডিফল্ট ৩০ মিনিট)।

const { getSyncIntervalMs } = require('./providers');

class StaleDataError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StaleDataError';
    this.code = 'STALE_SPORTS_DATA';
    this.details = details;
  }
}

function maxAgeMs() {
  const v = Number(process.env.SPORTS_DATA_MAX_AGE_MS);
  return Number.isFinite(v) && v > 0 ? v : getSyncIntervalMs() * 2;
}

/** @returns {{stale:boolean, ageMs:number|null, reason:string|null}} */
function assessMatchFreshness(row, now = Date.now()) {
  if (!row || !row.provider) return { stale: false, ageMs: null, reason: null }; // হাতে তৈরি — ফিড নেই
  if (!row.synced_at) return { stale: true, ageMs: null, reason: 'never_synced' };
  const ageMs = now - new Date(row.synced_at).getTime();
  if (!Number.isFinite(ageMs)) return { stale: true, ageMs: null, reason: 'bad_timestamp' };
  return ageMs > maxAgeMs() ? { stale: true, ageMs, reason: 'older_than_limit' } : { stale: false, ageMs, reason: null };
}

function assertMatchFresh(row, now) {
  const a = assessMatchFreshness(row, now);
  if (a.stale) throw new StaleDataError(`match ${row && row.id} data is stale (${a.reason})`, { matchId: row && row.id, ...a });
  return a;
}

/** প্রোভাইডার থেকে আসা ডেটা (sportsAPI) — `stale` চিহ্নিত হলে ব্যবহার নিষিদ্ধ। */
function assertFreshProviderData(data) {
  if (data && data.stale === true) throw new StaleDataError('provider data is stale', { staleSince: data.staleSince || null });
  return data;
}

/** সেটলমেন্টের উৎস: অ্যাডমিন-নিশ্চিত অথবা fresh প্রোভাইডার ডেটা — অন্য কিছু নয়। */
function assertSettlementSource({ source, data } = {}) {
  if (source === 'admin') return true;
  if (source === 'provider') { assertFreshProviderData(data); return true; }
  throw new StaleDataError(`settlement source "${source}" not allowed`, { source });
}

/** UI/API-র জন্য: `data_stale`, `synced_at`। */
function annotateStale(row, now) {
  const a = assessMatchFreshness(row, now);
  return { data_stale: a.stale, synced_at: row && row.synced_at ? new Date(row.synced_at).toISOString() : null };
}

module.exports = { StaleDataError, maxAgeMs, assessMatchFreshness, assertMatchFresh, assertFreshProviderData, assertSettlementSource, annotateStale };
