// services/matchUpdater.js
// Fetch real matches from APIs and seed/sync them into the database
const { pool } = require('../db');
const sportsAPI = require('./sportsAPI');

/**
 * Main sync function — runs on server start + every X hours
 * Pulls real cricket + football data and upserts into matches table
 */
async function syncMatches() {
  const allMatches = [];
  
  try {
    // 🏏 CRICKET — live + upcoming
    const cricketLive = await sportsAPI.getCricketCurrentMatches();
    const cricketUpcoming = await sportsAPI.getCricketUpcoming();
    
    for (const m of [...cricketLive, ...cricketUpcoming]) {
      const teams = m.teams || [];
      if (teams.length < 2) continue;
      
      // Build score strings
      let scoreA = null, scoreB = null, overs = null;
      if (m.score && m.score.length > 0) {
        const s1 = m.score[0];
        if (s1) scoreA = `${s1.r}/${s1.w}`;
        if (m.score[1]) scoreB = `${m.score[1].r}/${m.score[1].w}`;
        if (s1 && s1.o) overs = `${s1.o}`;
      }
      
      let status = 'upcoming';
      if (m.matchEnded) status = 'finished';
      else if (m.matchStarted) status = 'live';
      
      allMatches.push({
        external_id: m.id,
        title: m.name || `${teams[0]} vs ${teams[1]}`,
        sport: 'cricket',
        team_a: teams[0],
        team_b: teams[1],
        match_date: m.dateTimeGMT ? new Date(m.dateTimeGMT) : new Date(),
        status,
        winner: m.matchWinner || null,
        result: m.status || null,
        score_a: scoreA,
        score_b: scoreB,
        overs,
      });
    }
    
    // ⚽ FOOTBALL — live + World Cup
    const footballLive = await sportsAPI.getFootballLiveScores();
    const worldCup = await sportsAPI.getWorldCupFixtures();
    
    for (const m of [...footballLive, ...worldCup]) {
      if (!m.homeTeam || !m.awayTeam) continue;
      
      let status = 'upcoming';
      if (m.status === 'FT' || m.status === 'Match Finished') status = 'finished';
      else if (m.progress || m.status === 'In Progress') status = 'live';
      
      allMatches.push({
        external_id: m.id,
        title: m.name || `${m.homeTeam} vs ${m.awayTeam}`,
        sport: 'football',
        team_a: m.homeTeam,
        team_b: m.awayTeam,
        match_date: m.date ? new Date(`${m.date} ${m.time || '00:00:00'}`) : new Date(),
        status,
        winner: null,
        result: m.progress || m.status || null,
        score_a: m.homeScore != null ? String(m.homeScore) : null,
        score_b: m.awayScore != null ? String(m.awayScore) : null,
        overs: null,
      });
    }
    
    // Ensure external_id column exists (one-time)
    await pool.query(`
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS external_id VARCHAR(100);
      CREATE UNIQUE INDEX IF NOT EXISTS matches_external_id_idx ON matches(external_id) WHERE external_id IS NOT NULL;
    `).catch(() => {}); // ignore if already exists
    
    // UPSERT each match
    let added = 0, updated = 0;
    for (const m of allMatches) {
      try {
        const result = await pool.query(`
          INSERT INTO matches (external_id, title, sport, team_a, team_b, match_date, status, winner, result, score_a, score_b, overs)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (external_id) DO UPDATE SET
            status = EXCLUDED.status,
            winner = EXCLUDED.winner,
            result = EXCLUDED.result,
            score_a = EXCLUDED.score_a,
            score_b = EXCLUDED.score_b,
            overs = EXCLUDED.overs
          RETURNING (xmax = 0) AS inserted
        `, [m.external_id, m.title, m.sport, m.team_a, m.team_b, m.match_date,
            m.status, m.winner, m.result, m.score_a, m.score_b, m.overs]);
        
        if (result.rows[0]?.inserted) added++; else updated++;
      } catch (err) {
        // skip individual errors, keep going
      }
    }
    
    console.log(`✅ Match sync complete. Added: ${added}, Updated: ${updated}`);
    return { added, updated, total: allMatches.length };
  } catch (err) {
    console.error('❌ syncMatches error:', err.message);
    return { added: 0, updated: 0, total: 0 };
  }
}

/**
 * Get all matches from DB — for frontend display
 */
async function getMatchesFromDB(sport = 'all', status = null) {
  let sql = 'SELECT * FROM matches WHERE 1=1';
  const params = [];
  
  if (sport !== 'all') {
    params.push(sport);
    sql += ` AND sport = $${params.length}`;
  }
  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  
  sql += ' ORDER BY CASE status WHEN \'live\' THEN 1 WHEN \'upcoming\' THEN 2 ELSE 3 END, match_date ASC LIMIT 50';
  
  const result = await pool.query(sql, params);
  return result.rows;
}

module.exports = { syncMatches, getMatchesFromDB };
