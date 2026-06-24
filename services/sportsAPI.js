// services/sportsAPI.js
// Sports data service — Cricket (CricAPI) + Football (TheSportsDB)

// ⚠️ TODO: এই key পরে env variable এ সরাব
// এখন প্রথমে কাজ করানো জরুরি
const CRICKET_API_KEY = process.env.CRICKET_API_KEY || 11ee3d02-f9eb-4ecf-a9a5-788174dd3fe7;
const SPORTSDB_KEY = '123'; // TheSportsDB public free key

// -------- Simple in-memory cache (5 min) --------
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
    const url = `https://api.cricapi.com/v1/currentMatches?apikey=${CRICKET_API_KEY}&offset=0`;
    const res = await fetch(url);
    const json = await res.json();
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
      tossWinner: m.tossWinner,
      tossChoice: m.tossChoice,
      matchWinner: m.matchWinner,
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

// ================== FOOTBALL ==================

async function getFootballLiveScores() {
  const cached = getCached('football:live');
  if (cached) return cached;
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/livescore.php?s=Soccer`;
    const res = await fetch(url);
    const json = await res.json();
    const matches = (json.events || json.livescore || []).map(m => ({
      id: m.idEvent,
      name: `${m.strHomeTeam} vs ${m.strAwayTeam}`,
      homeTeam: m.strHomeTeam,
      awayTeam: m.strAwayTeam,
      homeScore: m.intHomeScore,
      awayScore: m.intAwayScore,
      league: m.strLeague,
      progress: m.strProgress,
      status: m.strStatus,
      date: m.dateEvent,
      sport: 'football',
    }));
    setCache('football:live', matches);
    return matches;
  } catch (err) {
    console.error('Football live error:', err.message);
    return [];
  }
}

// FIFA World Cup 2026 fixtures
async function getWorldCupFixtures() {
  const cached = getCached('football:worldcup');
  if (cached) return cached;
  try {
    // League ID 4429 = FIFA World Cup in TheSportsDB
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventsnextleague.php?id=4429`;
    const res = await fetch(url);
    const json = await res.json();
    const matches = (json.events || []).map(m => ({
      id: m.idEvent,
      name: `${m.strHomeTeam} vs ${m.strAwayTeam}`,
      homeTeam: m.strHomeTeam,
      awayTeam: m.strAwayTeam,
      league: m.strLeague,
      date: m.dateEvent,
      time: m.strTime,
      venue: m.strVenue,
      sport: 'football',
      tournament: 'FIFA World Cup',
    }));
    setCache('football:worldcup', matches);
    return matches;
  } catch (err) {
    console.error('World Cup fetch error:', err.message);
    return [];
  }
}

// Search any league by name
async function searchLeague(name) {
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/search_all_leagues.php?s=Soccer`;
    const res = await fetch(url);
    const json = await res.json();
    return (json.countries || []).filter(l =>
      l.strLeague.toLowerCase().includes(name.toLowerCase())
    );
  } catch (err) {
    return [];
  }
}

module.exports = {
  getCricketCurrentMatches,
  getCricketUpcoming,
  getCricketMatchInfo,
  getFootballLiveScores,
  getWorldCupFixtures,
  searchLeague,
};
