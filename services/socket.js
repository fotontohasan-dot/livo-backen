const { Server } = require("socket.io");
const { pool } = require('../db');
const { getBotReply } = require('./chatbot');

let io;

const initSocket = (server, sessionMiddleware) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // ===== নিরাপত্তা: socket handshake-এর সাথে Express session যুক্ত করা =====
  // এর ফলে socket.request.session.user থেকে আসল লগইন করা ইউজার/রোল পাওয়া যাবে,
  // ক্লায়েন্ট যা দাবি করে (senderId, isAdmin) তা আর বিশ্বাস করা হবে না।
  if (sessionMiddleware) {
    io.engine.use(sessionMiddleware);
  }

  io.on("connection", (socket) => {
    console.log("🟢 User connected:", socket.id);

    const getSessionUser = () => {
      const s = socket.request && socket.request.session;
      return (s && s.user) ? s.user : null;
    };

    // লগইন করা থাকলে সাথে সাথে নিজের চ্যাট রুমে ও (অ্যাডমিন হলে) admins রুমে জয়েন করানো
    const authUser = getSessionUser();
    if (authUser) {
      socket.join(`user:${authUser.id}`);
      if (authUser.role === 'admin') socket.join('admins');
    }

    // ===== ম্যাচ রুম (লাইভ স্কোর) — পাবলিক তথ্য, লগইন লাগবে না =====
    socket.on("joinMatch", (matchId) => {
      socket.join(`match:${matchId}`);
    });
    socket.on("join_matches", () => socket.join("matches"));
    socket.on("leave_matches", () => socket.leave("matches"));

    // ===== ইউজার নিজের চ্যাট রুমে জয়েন — শুধু নিজের রুমে, session দিয়ে যাচাই করে =====
    socket.on("join", () => {
      const u = getSessionUser();
      if (u) socket.join(`user:${u.id}`);
    });

    // ===== অ্যাডমিন চ্যাট রুম — শুধু আসল admin session হলেই =====
    socket.on("join_admin", () => {
      const u = getSessionUser();
      if (u && u.role === 'admin') socket.join("admins");
    });

    // ===== চ্যাট মেসেজ পাঠানো/গ্রহণ =====
    socket.on("send_message", async (data) => {
      try {
        const u = getSessionUser();
        if (!u) return; // লগইন ছাড়া মেসেজ পাঠানো যাবে না

        const senderId = u.id; // ক্লায়েন্টের senderId উপেক্ষা করা হচ্ছে, session-ই একমাত্র সত্য উৎস
        const isAdmin = u.role === 'admin';
        const receiverId = (data && data.receiverId) || null;
        const message = (data && data.message) || null;
        const fileUrl = (data && data.fileUrl) || null;
        const fileType = (data && data.fileType) || null;

        if (!message && !fileUrl) return;

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

          // ===== বট মোড হলে অটো-রিপ্লাই =====
          if (data && data.botMode && message) {
            const botText = await getBotReply(message);
            const botCreatedAt = new Date();

            await pool.query(
              `INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin, is_bot, created_at)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [senderId, senderId, botText, true, true, botCreatedAt]
            );

            io.to(`user:${senderId}`).emit("new_message", {
              senderId: null,
              receiverId: senderId,
              message: botText,
              isAdmin: true,
              isBot: true,
              fileUrl: null,
              fileType: null,
              createdAt: botCreatedAt
            });
          }
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

// ===== ডেমো (প্র্যাকটিস) কারেন্সি স্ট্যাটস =====
// মোট ডেমো সংখ্যাটি স্থায়ীভাবে নির্ধারিত (ফিক্সড) — এটি কোনো হিসাব থেকে আসে না,
// কেউ এটি পরিবর্তন/কমাতে-বাড়াতে পারবে না। বাকি তিনটি স্ট্যাট রিয়েল-টাইম DB থেকে আসে।
const TOTAL_DEMO_FIXED = 9999999;

const getDemoStats = async () => {
  const heldByUsers = await pool.query(`SELECT COALESCE(SUM(demo_balance),0) AS total FROM users`);
  const casinoWagered = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM demo_transactions WHERE category='casino' AND type='bet'`
  );
  const sportsWagered = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM demo_transactions WHERE category='sports' AND type='bet'`
  );

  return {
    totalDemo: TOTAL_DEMO_FIXED,
    userHeldDemo: Number(heldByUsers.rows[0].total),
    casinoDemoWagered: Number(casinoWagered.rows[0].total),
    sportsDemoWagered: Number(sportsWagered.rows[0].total)
  };
};

const broadcastDemoStats = async () => {
  if (!io) return;
  try {
    const stats = await getDemoStats();
    io.to("admins").emit("demo_stats_update", stats);
  } catch (err) {
    console.error("Demo stats broadcast error:", err.message);
  }
};

module.exports = { initSocket, updateLiveScore, getDemoStats, broadcastDemoStats };
