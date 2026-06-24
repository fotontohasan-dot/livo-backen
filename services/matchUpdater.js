const { pool } = require('../db');
const { updateLiveScore } = require('./socket');

// Dummy Live Score Generator (টেস্টের জন্য)
const liveMatches = [1, 2, 3]; // তোমার ম্যাচ আইডি

const simulateLiveUpdate = async () => {
  for (let matchId of liveMatches) {
    const scoreA = Math.floor(Math.random() * 350) + 50;
    const scoreB = Math.floor(Math.random() * 180) + 30;
    const overs = (Math.random() * 45 + 5).toFixed(1);

    await updateLiveScore(matchId, {
      score_a: `${scoreA}/8`,
      score_b: `${scoreB}/4`,
      overs: `${overs}`,
      status: 'live'
    });
  }
};

const syncMatches = async () => {
  try {
    console.log("🔄 Syncing matches...");

    // ডামি ডাটা তৈরি করা
    await pool.query(`
      INSERT INTO matches (title, sport, team_a, team_b, status, score_a, score_b, overs)
      VALUES 
        ('Sri Lanka Emerging vs West Indies Emerging', 'cricket', 'Sri Lanka Emerging', 'West Indies Emerging', 'live', '360/10', '122/4', '24.3')
      ON CONFLICT DO NOTHING;
    `);

    console.log("✅ Matches synced");

    // প্রতি ১৫ সেকেন্ডে লাইভ স্কোর আপডেট
    setInterval(simulateLiveUpdate, 15000);

  } catch (err) {
    console.error("Match sync error:", err);
  }
};

module.exports = { syncMatches };
