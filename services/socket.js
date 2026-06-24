const { Server } = require("socket.io");
const { pool } = require('../db');

let io;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  io.on("connection", (socket) => {
    console.log("🟢 User connected:", socket.id);

    socket.on("joinMatch", (matchId) => {
      socket.join(`match:${matchId}`);
      console.log(`User joined match: ${matchId}`);
    });

    socket.on("disconnect", () => {
      console.log("🔴 User disconnected:", socket.id);
    });
  });

  console.log("✅ Socket.io initialized");
};

// Live Score Update করার ফাংশন
const updateLiveScore = async (matchId, scoreData) => {
  if (!io) return;

  try {
    // ডাটাবেস আপডেট
    await pool.query(
      `UPDATE matches 
       SET score_a = $1, score_b = $2, overs = $3, status = 'live' 
       WHERE id = $4`, );

    // সবাইকে লাইভ আপডেট পাঠানো
    io.to(`match:${matchId}`).emit("scoreUpdate", {
      matchId,
      ...scoreData,
      timestamp: new Date()
    });

    console.log(`📢 Live score updated for match ${matchId}`);
  } catch (err) {
    console.error("Live score update error:", err);
  }
};

module.exports = { initSocket, updateLiveScore };
