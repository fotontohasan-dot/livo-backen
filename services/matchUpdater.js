const { pool } = require('../db');

/**
 * syncMatches function.
 * Fetches/Generates realistic upcoming matches for Cricket and Football.
 * Ensures no duplicates are added and covers multiple days ahead.
 */
async function syncMatches() {
  const footballTeams = [
    'Brazil', 'Argentina', 'France', 'Germany', 'England', 'Spain', 'Portugal', 'Italy',
    'Netherlands', 'Belgium', 'Croatia', 'Uruguay', 'Senegal', 'Morocco', 'Japan', 'South Korea',
    'Manchester City', 'Real Madrid', 'Liverpool', 'Bayern Munich', 'Barcelona', 'PSG', 'Arsenal', 'Inter Milan',
    'AC Milan', 'Chelsea', 'Manchester United', 'Juventus', 'Dortmund', 'Atletico Madrid', 'Napoli', 'Bayer Leverkusen'
  ];
  const cricketTeams = [
    'Bangladesh', 'India', 'Pakistan', 'Australia', 'England', 'South Africa', 'New Zealand', 'Sri Lanka',
    'West Indies', 'Afghanistan', 'Ireland', 'Zimbabwe', 'Scotland', 'Netherlands', 'Nepal', 'USA',
    'Dhaka Dynamites', 'Comilla Victorians', 'Sylhet Strikers', 'Fortune Barishal', 'Rangpur Riders', 'Chattogram Challengers',
    'Mumbai Indians', 'Chennai Super Kings', 'Royal Challengers Bangalore', 'Kolkata Knight Riders', 'Gujarat Titans'
  ];

  const matchesToAdd = [];
  const now = new Date();

  // Generate matches for the next 7 days
  for (let day = 1; day <= 7; day++) {
    // Generate 3-5 Football matches each day
    const footballCount = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < footballCount; i++) {
      const teamA = footballTeams[Math.floor(Math.random() * footballTeams.length)];
      let teamB = footballTeams[Math.floor(Math.random() * footballTeams.length)];
      while (teamA === teamB) teamB = footballTeams[Math.floor(Math.random() * footballTeams.length)];

      const matchDate = new Date(now);
      matchDate.setDate(now.getDate() + day);
      matchDate.setHours(14 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 4) * 15, 0, 0);

      matchesToAdd.push({
        title: `${teamA} vs ${teamB} - Match Day ${day}`,
        sport: 'football',
        team_a: teamA,
        team_b: teamB,
        match_date: matchDate
      });
    }

    // Generate 2-4 Cricket matches each day
    const cricketCount = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < cricketCount; i++) {
      const teamA = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];
      let teamB = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];
      while (teamA === teamB) teamB = cricketTeams[Math.floor(Math.random() * cricketTeams.length)];

      const matchDate = new Date(now);
      matchDate.setDate(now.getDate() + day);
      matchDate.setHours(9 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 4) * 15, 0, 0);

      matchesToAdd.push({
        title: `${teamA} vs ${teamB} - Series Day ${day}`,
        sport: 'cricket',
        team_a: teamA,
        team_b: teamB,
        match_date: matchDate
      });
    }
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
        `INSERT INTO matches (title, sport, team_a, team_b, match_date) VALUES ($1, $2, $3, $4, $5)`,
        [match.title, match.sport, match.team_a, match.team_b, match.match_date]
      );
      addedCount++;
    }
  }

  console.log(`Successfully synced matches. Added ${addedCount} new matches.`);
  return addedCount;
}

module.exports = { syncMatches };
