// services/cricketMarketTemplate.js
// ---------------------------------------------------------------------------
// অ্যাডমিনের জন্য "ক্রিকেট মার্কেট একসাথে তৈরি" টেমপ্লেট।
//
// কেন আলাদা সারি: এই কোডবেসে একটা markets সারি = একটা রানার। match-detail পেজ
// bookmaker ছাড়া সব টাইপের সারিতে "Yes <অডস>" বাটন দেখায়, বাজি ধরা হয় runner='yes'
// দিয়ে, আর সেটেলমেন্টে অ্যাডমিন জয়ী সারিতে 'yes' বসান (অন্য সারিতে অন্য কিছু, যেমন 'no')।
// তাই ওভার/আন্ডার মার্কেটও একই ধরনে — "Total Runs Over 280.5" আর "Total Runs Under 280.5"
// আলাদা দুটো সারি। এতে ভিউ, অডস-রিজলভার বা সেটেলমেন্ট বদলাতে হয় না।
//
// অডস কখনো আন্দাজে বসানো হয় না: ফর্মে অ্যাডমিন যা দেন শুধু তাই, এবং প্রতিটা অডস
// oddsResolver-এর সীমার (1 < odd <= MAX_ODD) ভেতরে হতে হবে।
// ---------------------------------------------------------------------------

const { MAX_ODD } = require('./oddsResolver');

const MAX_LINE = 10000;

// টাইপ নামগুলো কয়েক জায়গায় (অ্যাডমিন তালিকা, রিপোর্ট) ফিল্টার হিসেবে কাজে লাগে।
const TYPES = {
  winner: 'match_winner',
  runs: 'total_runs',
  wickets: 'total_wickets',
  overs: 'total_overs'
};

function parseOdd(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 1 || n > MAX_ODD) return NaN;
  return Math.round(n * 100) / 100;
}

function parseLine(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || n > MAX_LINE) return NaN;
  // এক দশমিক ঘর পর্যন্ত (যেমন 280.5); বেশি হলে ছাঁটা হয়
  return Math.round(n * 10) / 10;
}

function cleanTeam(name, fallback) {
  const s = String(name || '').trim().slice(0, 80);
  return s || fallback;
}

/**
 * @param {object} match  { team_a, team_b }
 * @param {object} body   ফর্মের ফিল্ড (home_odds, away_odds, runs_line, wickets_line,
 *                        overs_line, over_odds, under_odds)
 * @returns {{ rows: Array<{type,name,odds}>, error: string|null }}
 */
function buildRows(match, body) {
  const rows = [];
  const b = body || {};

  const home = parseOdd(b.home_odds);
  const away = parseOdd(b.away_odds);
  if (Number.isNaN(home) || Number.isNaN(away)) return { rows: [], error: 'invalid_odds' };
  if ((home === null) !== (away === null)) return { rows: [], error: 'winner_needs_both_odds' };
  if (home !== null) {
    const a = cleanTeam(match && match.team_a, 'Team A');
    const t = cleanTeam(match && match.team_b, 'Team B');
    rows.push({ type: TYPES.winner, name: `${a} Win`, odds: home });
    rows.push({ type: TYPES.winner, name: `${t} Win`, odds: away });
  }

  const over = parseOdd(b.over_odds);
  const under = parseOdd(b.under_odds);
  if (Number.isNaN(over) || Number.isNaN(under)) return { rows: [], error: 'invalid_odds' };

  const lines = [
    [TYPES.runs, 'Total Runs', parseLine(b.runs_line)],
    [TYPES.wickets, 'Total Wickets', parseLine(b.wickets_line)],
    [TYPES.overs, 'Total Overs', parseLine(b.overs_line)]
  ];
  if (lines.some(([, , l]) => Number.isNaN(l))) return { rows: [], error: 'invalid_line' };

  const anyLine = lines.some(([, , l]) => l !== null);
  if (anyLine) {
    if (over === null || under === null) return { rows: [], error: 'ou_needs_both_odds' };
    for (const [type, label, line] of lines) {
      if (line === null) continue;
      rows.push({ type, name: `${label} Over ${line}`, odds: over });
      rows.push({ type, name: `${label} Under ${line}`, odds: under });
    }
  }

  if (rows.length === 0) return { rows: [], error: 'nothing_to_create' };
  return { rows, error: null };
}

// অডস JSONB-তে কোন আকারে যাবে। match-detail ভিউ non-bookmaker সারিতে market.odds['yes'] পড়ে,
// bookmaker-এ market.odds['0'] / ['1']। সংখ্যা (1.9) রাখলে ভিউ কোনো কী পায় না ও ১.৭৫ ফলব্যাক
// দেখায়, অথচ oddsResolver সংখ্যাটাই ধরে — ইউজার যা দেখে আর যা পায় তা আলাদা হয়ে যায়।
// তাই সবসময় ভিউ-বোধ্য অবজেক্ট আকারে।
function oddsShape(type, odd) {
  return type === 'bookmaker' ? { '0': odd, '1': odd } : { yes: odd };
}

module.exports = { buildRows, parseOdd, parseLine, oddsShape, TYPES, MAX_LINE };
