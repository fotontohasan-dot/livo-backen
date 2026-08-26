// services/sportsAPI.js
const CRICKET_API_KEY = process.env.CRICKET_API_KEY || '';
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const FOOTBALL_HOST = 'today-football-prediction.p.rapidapi.com';

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { time: Date.now(), data });
}

// ================== CRICKET ==================

async function getCricketCurrentMatches() {
  const cached = getCached('cricket:current');
  if (cached) return cached;
  try {
    if (!CRICKET_API_KEY) {
      console.error('Cricket: CRICKET_API_KEY নেই!');
      return [];
    }
    const url = `https://api.cricapi.com/v1/currentMatches?apikey=${CRICKET_API_KEY}&offset=0`;
    const res = await fetch(url);
    const json = await res.json();

    // ডিবাগ: API কী বলছে লগে দেখাও
    console.log('Cricket API status:', json.status, '| message:', json.info ? JSON.stringify(json.info) : (json.reason || 'N/A'));

    const matches = (json.data || []).map(m => ({
      id: m.id,
      name: m.name,
      status: m.status,
      venue: m.venue,
      date: m.date,
      dateTimeGMT: m.dateTimeGMT,
      teams: m.teams || [],
      teamInfo: m.teamInfo || [],
      score: m.score || [],
      matchType: m.matchType,
      // প্রোভাইডার এই ফিল্ডগুলো পাঠালে হারিয়ে যেত — অ্যাডাপ্টারে league/metadata
      // নরমালাইজ করার জন্য দরকার। না পাঠালে undefined থাকে, বানানো হয় না।
      series_id: m.series_id,
      series: m.series,
      sport: 'cricket',
    }));
    setCache('cricket:current', matches);
    return matches;
  } catch (err) {
    console.error('Cricket API error:', err.message);
    return [];
  }
}

async function getCricketUpcoming() {
  const cached = getCached('cricket:upcoming');
  if (cached) return cached;
  try {
    if (!CRICKET_API_KEY) return [];
    const url = `https://api.cricapi.com/v1/matches?apikey=${CRICKET_API_KEY}&offset=0`;
    const res = await fetch(url);
    const json = await res.json();
    const matches = (json.data || []).map(m => ({
      id: m.id,
      name: m.name,
      status: m.status,
      venue: m.venue,
      date: m.date,
      teams: m.teams || [],
      sport: 'cricket',
    }));
    setCache('cricket:upcoming', matches);
    return matches;
  } catch (err) {
    console.error('Cricket upcoming error:', err.message);
    return [];
  }
}

async function getCricketMatchInfo(matchId) {
  const cached = getCached(`cricket:match:${matchId}`);
  if (cached) return cached;
  try {
    const url = `https://api.cricapi.com/v1/match_info?apikey=${CRICKET_API_KEY}&id=${matchId}`;
    const res = await fetch(url);
    const json = await res.json();
    setCache(`cricket:match:${matchId}`, json.data);
    return json.data;
  } catch (err) {
    console.error('Cricket match info error:', err.message);
    return null;
  }
}

// ================== FOOTBALL (RapidAPI) ==================

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function getFootballLiveScores() {
  const cached = getCached('football:live');
  if (cached) return cached;

  if (!RAPIDAPI_KEY) {
    console.warn('Football: RAPIDAPI_KEY নেই, স্কিপ করা হল');
    return [];
  }

  try {
    const url = `https://${FOOTBALL_HOST}/predictions/list?iso_date=${todayISO()}&federation=UEFA&market=classic_1x2`;
    const res = await fetch(url, {
      headers: {
        'x-rapidapi-host': FOOTBALL_HOST,
        'x-rapidapi-key': RAPIDAPI_KEY,
      },
    });

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      console.error('Football: JSON আসেনি (status ' + res.status + ')');
      return [];
    }

    const json = await res.json();
    const list = json.data || json.predictions || [];
    const matches = list.map(m => ({
      id: m.id || `${m.home_team}-${m.away_team}`,
      name: `${m.home_team || m.homeTeam || ''} vs ${m.away_team || m.awayTeam || ''}`,
      homeTeam: m.home_team || m.homeTeam || '',
      awayTeam: m.away_team || m.awayTeam || '',
      homeScore: null,
      awayScore: null,
      league: m.competition_name || m.league || 'Football',
      status: 'upcoming',
      date: m.date || todayISO(),
      sport: 'football',
    }));
    setCache('football:live', matches);
    return matches;
  } catch (err) {
    console.error('Football live error:', err.message);
    return [];
  }
}

async function getWorldCupFixtures() {
  return [];
}

async function searchLeague() {
  return [];
}

module.exports = {
  getCricketCurrentMatches,
  getCricketUpcoming,
  getCricketMatchInfo,
  getFootballLiveScores,
  getWorldCupFixtures,
  searchLeague,
};
