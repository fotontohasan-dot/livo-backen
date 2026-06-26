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

    // ===== ম্যাচ রুম (লাইভ স্কোর) =====
    socket.on("joinMatch", (matchId) => {
      socket.join(`match:${matchId}`);
    });
    socket.on("join_matches", () => socket.join("matches"));
    socket.on("leave_matches", () => socket.leave("matches"));

    // ===== ইউজার নিজের চ্যাট রুমে জয়েন =====
    socket.on("join", (userId) => {
      if (userId) socket.join(`user:${userId}`);
    });

    // ===== অ্যাডমিন চ্যাট রুম =====
    socket.on("join_admin", () => {
      socket.join("admins");
    });

    // ===== চ্যাট মেসেজ পাঠানো/গ্রহণ =====
    socket.on("send_message", async (data) => {
      try {
        const senderId = data && data.senderId;
        const receiverId = (data && data.receiverId) || null;
        const message = (data && data.message) || null;
        const fileUrl = (data && data.fileUrl) || null;
        const fileType = (data && data.fileType) || null;
        let isAdmin = !!(data && data.isAdmin);

        if (!senderId || (!message && !fileUrl)) return;

        // নিরাপত্তা: কেউ isAdmin:true দাবি করলেও ডেটাবেস থেকে আসল রোল যাচাই
        if (isAdmin) {
          const r = await pool.query('SELECT role FROM users WHERE id = $1', [senderId]);
          isAdmin = !!(r.rows[0] && r.rows[0].role === 'admin');
        }

        const createdAt = new Date();

        // ডেটাবেসে সেভ
        await pool.query(
          `INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin, file_url, file_type, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [senderId, receiverId, message, isAdmin, fileUrl, fileType, createdAt]
        );

        const payload = {
          senderId,
          receiverId,
          message,
          isAdmin,
          fileUrl,
          fileType,
          createdAt
        };

        if (isAdmin) {
          // অ্যাডমিন → নির্দিষ্ট ইউজারের কাছে
          if (receiverId) io.to(`user:${receiverId}`).emit("new_message", payload);
        } else {
          // ইউজার → সব অ্যাডমিনের কাছে
          io.to("admins").emit("new_message", payload);
        }
      } catch (err) {
        console.error("send_message error:", err.message);
      }
    });

    socket.on("disconnect", () => {
      console.log("🔴 User disconnected:", socket.id);
    });
  });

  console.log("✅ Socket.io initialized");
};

// ===== লাইভ স্কোর আপডেট (আগের মতোই) =====
const updateLiveScore = async (matchId, scoreData) => {
  if (!io) return;
  try {
    await pool.query(
      `UPDATE matches
       SET score_a = $1, score_b = $2, overs = $3, status = 'live'
       WHERE id = $4`,
      [scoreData.score_a, scoreData.score_b, scoreData.overs, matchId]
    );

    io.to(`match:${matchId}`).emit("scoreUpdate", {
      matchId,
      ...scoreData,
      timestamp: new Date()
    });
  } catch (err) {
    console.error("Live score update error:", err.message);
  }
};

module.exports = { initSocket, updateLiveScore };
