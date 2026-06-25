const { pool } = require('../db');

/**
 * syncMatches function.
 * Fetches/Generates realistic upcoming matches for Cricket and Football.
 * Ensures no duplicates are added.
 */
async function syncMatches() {
  const footballTeams = ['Brazil', 'Argentina', 'France', 'Germany', 'England', 'Spain', 'Portugal', 'Italy'];
  const cricketTeams = ['Bangladesh', 'India', 'Pakistan', 'Australia', 'England', 'South Africa', 'New Zealand', 'Sri Lanka'];

  const matchesToAdd = [];
  const now = new Date();

  // Generate 5 Football matches for the next week
  for (let i = 1; i <= 5; i++) {
    const teamA = footballTeams[Math.floor(Math.random() * footballTeams.length)];
    let teamB = footballTeams[Math.floor(Math.random() * footballTeams.length)];
    while (teamA === teamB) teamB = footballTeams[Math.floor(Math.random() * footballTeams.length)];

    const matchDate = new Date(now);
    matchDate.setDate(now.getDate() + i);
    matchDate.setHours(18 + Math.floor(Math.random() * 4), 0, 0, 0); // Evening matches

    matchesToAdd.push({
      title: `${teamA} vs ${teamB} - International Friendly`,
      sport: 'football',
      team_a: teamA,
      team_b: teamB,
      match_date: matchDate,
      odds_a: (1.5 + Math.random() * 2).toFixed(2),
      odds_b: (1.5 + Math.random() * 2).toFixed(2),
      odds_draw: (2.5 + Math.random() * 2).toFixed(2)
    });
  }

  // Generate 5 Cricket matches for the next week
  for (let i = 1; i <= 5; i++) {
    const teamA = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];
    let teamB = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];
    while (teamA === teamB) teamB = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];

    const matchDate = new Date(now);
    matchDate.setDate(now.getDate() + i);
    matchDate.setHours(10 + Math.floor(Math.random() * 4), 0, 0, 0); // Daytime matches

    matchesToAdd.push({
      title: `${teamA} vs ${teamB} - World Cup Series`,
      sport: 'cricket',
      team_a: teamA,
      team_b: teamB,
      match_date: matchDate,
      odds_a: (1.4 + Math.random() * 1.5).toFixed(2),
      odds_b: (1.4 + Math.random() * 1.5).toFixed(2),
      odds_draw: null
    });
  }

  let addedCount = 0;
  for (const match of matchesToAdd) {
    // Check if match already exists (same teams on same day)
    const existing = await pool.query(
      `SELECT id FROM matches WHERE team_a = $1 AND team_b = $2 AND match_date::date = $3::date`,
      [match.team_a, match.team_b, match.match_date]
    );

    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO matches (title, sport, team_a, team_b, match_date, odds_a, odds_b, odds_draw) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [match.title, match.sport, match.team_a, match.team_b, match.match_date, match.odds_a, match.odds_b, match.odds_draw]
      );
      addedCount++;
    }
  }

  console.log(`Successfully synced matches. Added ${addedCount} new matches.`);
  return addedCount;
}

module.exports = { syncMatches };
