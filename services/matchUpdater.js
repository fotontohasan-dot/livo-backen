const { pool } = require('../db');

/**
 * syncMatches function.
 * Fetches realistic upcoming matches for Cricket and Football from TheSportsDB API.
 * Ensures no duplicates are added.
 */
async function syncMatches() {
  const leagues = [
    { id: '4328', sport: 'football' }, // English Premier League
    { id: '4331', sport: 'football' }, // German Bundesliga
    { id: '4332', sport: 'football' }, // Italian Serie A
    { id: '4334', sport: 'football' }, // French Ligue 1
    { id: '4335', sport: 'football' }, // Spanish La Liga
    { id: '4461', sport: 'cricket' },  // Australian Big Bash League
    { id: '5529', sport: 'cricket' }   // Bangladesh Premier League
  ];

  let addedCount = 0;

  for (const league of leagues) {
    try {
      // Using API key '3' which is the public testing key for TheSportsDB
      const response = await fetch(`https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=${league.id}`);
      const data = await response.json();

      if (data && data.events) {
        for (const event of data.events) {
          const matchDate = new Date(event.strTimestamp || `${event.dateEvent}T${event.strTime || '00:00:00'}`);

          // Check if match already exists (same teams on same day)
          const existing = await pool.query(
            `SELECT id FROM matches WHERE team_a = $1 AND team_b = $2 AND match_date::date = $3::date`,
            [event.strHomeTeam, event.strAwayTeam, matchDate]
          );

          if (existing.rows.length === 0) {
            await pool.query(
              `INSERT INTO matches (title, sport, team_a, team_b, match_date) VALUES ($1, $2, $3, $4, $5)`,
              [event.strEvent, league.sport, event.strHomeTeam, event.strAwayTeam, matchDate]
            );
            addedCount++;
          }
        }
      }
    } catch (err) {
      console.error(`Error syncing league ${league.id}:`, err.message);
    }
  }

  // Fallback: If no matches found from API (common in dev/testing environments),
  // generate some mock matches to ensure the site isn't empty.
  if (addedCount === 0) {
    const fallbackCount = await generateMockMatches();
    console.log(`No API matches found. Generated ${fallbackCount} mock matches.`);
    return fallbackCount;
  }

  console.log(`Successfully synced matches from API. Added ${addedCount} new matches.`);
  return addedCount;
}

async function generateMockMatches() {
  const footballTeams = [
    'Brazil', 'Argentina', 'France', 'Germany', 'England', 'Spain', 'Portugal', 'Italy', 'Netherlands', 'Belgium',
    'Real Madrid', 'Barcelona', 'Manchester City', 'Liverpool', 'Manchester United', 'Arsenal', 'Chelsea', 'PSG'
  ];
  const cricketTeams = [
    'Bangladesh', 'India', 'Pakistan', 'Australia', 'England', 'South Africa', 'New Zealand', 'Sri Lanka', 'Afghanistan', 'West Indies',
    'KKR', 'CSK', 'MI', 'RCB', 'GT', 'LSG', 'RR', 'DC', 'SRH', 'PBKS'
  ];

  const matchesToAdd = [];
  const now = new Date();

  // 5 Football
  for (let i = 0; i < 5; i++) {
    const teamA = footballTeams[Math.floor(Math.random() * footballTeams.length)];
    let teamB = footballTeams[Math.floor(Math.random() * footballTeams.length)];
    while (teamA === teamB) teamB = footballTeams[Math.floor(Math.random() * footballTeams.length)];
    const matchDate = new Date(now);
    matchDate.setDate(now.getDate() + Math.floor(Math.random() * 7) + 1);
    matchDate.setHours(18 + Math.floor(Math.random() * 4), 0, 0, 0);
    matchesToAdd.push({ title: `${teamA} vs ${teamB}`, sport: 'football', team_a: teamA, team_b: teamB, match_date: matchDate });
  }

  // 5 Cricket
  for (let i = 0; i < 5; i++) {
    const teamA = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];
    let teamB = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];
    while (teamA === teamB) teamB = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];
    const matchDate = new Date(now);
    matchDate.setDate(now.getDate() + Math.floor(Math.random() * 7) + 1);
    matchDate.setHours(10 + Math.floor(Math.random() * 4), 0, 0, 0);
    matchesToAdd.push({ title: `${teamA} vs ${teamB}`, sport: 'cricket', team_a: teamA, team_b: teamB, match_date: matchDate });
  }

  let count = 0;
  for (const m of matchesToAdd) {
    const existing = await pool.query(
      `SELECT id FROM matches WHERE team_a = $1 AND team_b = $2 AND match_date::date = $3::date`,
      [m.team_a, m.team_b, m.match_date]
    );
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO matches (title, sport, team_a, team_b, match_date) VALUES ($1, $2, $3, $4, $5)`,
        [m.title, m.sport, m.team_a, m.team_b, m.match_date]
      );
      count++;
    }
  }
  return count;
}

module.exports = { syncMatches };
