const { pool } = require('../db');
const sportsAPI = require('./sportsAPI');

// ক্রিকেট ম্যাচ API থেকে এনে ডাটবেসে রাখা
async function syncCricket() {
  try {
    const matches = await sportsAPI.getCricketCurrentMatches();
    for (const m of matches) {
      const teamA = m.teams[0] || 'TBA';
      const teamB = m.teams[1] || 'TBA';
      const scoreA = (m.score && m.score[0]) ? `${m.score[0].r}/${m.score[0].w}` : null;
      const scoreB = (m.score && m.score[1]) ? `${m.score[1].r}/${m.score[1].w}` : null;
      const overs = (m.score && m.score[0]) ? `${m.score[0].o}` : null;
      const status = /live|innings|need|require|opt to/i.test(m.status || '') ? 'live' : 'upcoming';

      await pool.query(
        `INSERT INTO matches (title, sport, team_a, team_b, status, score_a, score_b, overs)
         VALUES ($1,'cricket',$2,$3,$4,$5,$6,$7)
         ON CONFLICT DO NOTHING`,
        [m.name, teamA, teamB, status, scoreA, scoreB, overs]
      );
    }
    console.log(`✅ Cricket synced: ${matches.length} matches`);
  } catch (err) {
    console.error('Cricket sync error:', err.message);
  }
}

// ফুটবল লাইভ সর API থেকে এনে ডাটাবেসে রাখা
async function syncFootball() {
  try {
    const matches = await sportsAPI.getFootballLiveScores();
    for (const m of matches) {
      const status = m.status && /live|1h|2h|ht/i.test(m.status) ? 'live' : 'upcoming';
      await pool.query(
        `INSERT INTO matches (title, sport, team_a, team_b, status, score_a, score_b)
         VALUES ($1,'football',$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [m.name, m.homeTeam, m.awayTeam, status, m.homeScore, m.awayScore]
      );
    }
    console.log(`✅ Football synced: ${matches.length} matches`);
  } catch (err) {
    console.error('Football sync error:', err.message);
  }
}

const syncMatches = async () => {
  console.log('🔄 Syncing real matches...');
  await syncCricket();
  await syncFootball();

  // প্রতি ১৫ মিনিটে আবার সিঙ্ক (দিনে ৯৬ বার, ফ লিমিট ১০০ এর নিচে)
  setInterval(async () => {
    await syncCricket();
    await syncFootball();
  }, 15 * 60 * 1000);
};

module.exports = { syncMatches };
