const { Server } = require("socket.io");
const { pool } = require('../db');
const { getBotReply } = require('./chatbot');
const { notifyTelegram } = require('./telegramNotify');
const cache = require('./cache');
const { isAllowedOrigin } = require('../utils/allowedOrigins');

// ===== চ্যাট মেসেজ রেট-লিমিট =====
// HTTP রুটগুলো সবই কোনো না কোনো rate limiter-এর পেছনে, কিন্তু Socket.IO ইভেন্ট একটা আলাদা চ্যানেল
// যেখানে আগে কোনো সীমা ছিল না — একটা অ্যাকাউন্ট থেকে দ্রুতগতিতে send_message পাঠালে প্রতিটাই DB-তে
// ইনসার্ট হতো, সব admin-এর লাইভ সেশনে broadcast হতো, আর Telegram bot API-তেও কল যেত (bot-এর নিজের
// rate limit শেষ করে দেওয়া সম্ভব)। এখন প্রতি ইউজারে প্রতি উইন্ডোতে বার্তার সংখ্যা সীমিত করা হচ্ছে।
const CHAT_RATE_LIMIT = 15;      // প্রতি উইন্ডোতে সর্বোচ্চ বার্তা
const CHAT_RATE_WINDOW_SEC = 10; // ১০ সেকেন্ড উইন্ডো
// Redis অনুপলব্ধ থাকলে (cache.incrWithExpiry null দেয়) ইন-প্রসেস fallback — multi-instance
// deployment-এ perfectly synchronized না হলেও single-instance/dev/test-এ কার্যকর সুরক্ষা দেয়,
// আর Redis চালু থাকলে সেটাই আসল উৎস (সব instance জুড়ে সমন্বিত)।
const inMemoryChatRate = new Map();
async function allowChatMessage(userId) {
  const key = `chat:msg:${userId}`;
  const result = await cache.incrWithExpiry(key, CHAT_RATE_WINDOW_SEC);
  if (result) return result.count <= CHAT_RATE_LIMIT;

  const now = Date.now();
  const windowMs = CHAT_RATE_WINDOW_SEC * 1000;
  const entry = inMemoryChatRate.get(userId);
  if (!entry || now - entry.start > windowMs) {
    inMemoryChatRate.set(userId, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= CHAT_RATE_LIMIT;
}

// ===== "দেখা হয়েছে" (Seen) রিসিট — Messenger-এর মতো রিয়েল-টাইম নোটিফিকেশন =====
const notifyUserSeen = (userId) => {
  if (!io || !userId) return;
  try { io.to(`user:${userId}`).emit('messages_seen', { by: 'admin' }); }
  catch (err) { console.error('notifyUserSeen error:', err.message); }
};

const notifyAdminsSeen = (userId) => {
  if (!io || !userId) return;
  try { io.to('admins').emit('messages_seen', { by: Number(userId) }); }
  catch (err) { console.error('notifyAdminsSeen error:', err.message); }
};

let io;

// ===== অ্যাডমিন প্যানেলে রিয়েল-টাইম নোটিফিকেশন (ডিপোজিট/উইথড্র/চ্যাট) =====
// type: 'deposit' | 'withdraw' | 'chat'
const emitAdminAlert = (type, data = {}) => {
  if (!io) return;
  try {
    io.to('admins').emit('admin_alert', {
      type,
      title: data.title || '',
      message: data.message || '',
      createdAt: new Date()
    });
  } catch (err) {
    console.error('emitAdminAlert error:', err.message);
  }
};

const initSocket = (server, sessionMiddleware) => {
  // ===== নিরাপত্তা: Socket.IO-র origin পলিসি এখন মূল অ্যাপের সাথে অভিন্ন =====
  // আগে এখানে `origin: "*"` ছিল। handshake-এ সেশন কুকি যুক্ত থাকায় (নিচে io.engine.use)
  // যেকোনো তৃতীয়-পক্ষের ওয়েবসাইট ভিকটিমের ব্রাউজার থেকে credentialed handshake করে
  // `user:<id>` রুমের প্রাইভেট ইভেন্ট পড়তে পারত। এখন utils/allowedOrigins.js-এর একই
  // allow-list দুই লেয়ারেই প্রযোজ্য, আর fail-closed — তালিকায় না থাকলে সংযোগ প্রত্যাখ্যাত।
  io = new Server(server, {
    // মেসেজ সাইজ লিমিট: ডিফল্ট 1MB-ও একটা সকেট থেকে বড় পে-লোড স্প্যাম করার সুযোগ দেয়;
    // চ্যাট মেসেজ/ইভেন্ট পে-লোডের জন্য 64KB যথেষ্ট (ফাইল আপলোড আলাদা HTTP রুটে হয়)।
    maxHttpBufferSize: 64 * 1024,
    cors: {
      origin(origin, callback) {
        // ব্রাউজার WebSocket/polling handshake-এ সবসময় Origin পাঠায়। Origin না থাকা মানে
        // নন-ব্রাউজার ক্লায়েন্ট (নেটিভ অ্যাপ/সার্ভার-টু-সার্ভার) — HTTP লেয়ারের মতোই অনুমোদিত,
        // কারণ সেখানে ব্রাউজারের অ্যাম্বিয়েন্ট কুকি স্বয়ংক্রিয়ভাবে যুক্ত হয় না।
        callback(null, isAllowedOrigin(origin, { allowMissing: true }));
      },
      credentials: true,
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

        if (!(await allowChatMessage(senderId))) return; // রেট-লিমিট ছাড়িয়ে গেলে নীরবে ড্রপ

        const isAdmin = u.role === 'admin';
        const receiverId = (data && data.receiverId) || null;
        const message = (data && data.message) || null;
        const fileUrl = (data && data.fileUrl) || null;
        const fileType = (data && data.fileType) || null;

        if (!message && !fileUrl) return;

        // সার্ভার-সাইড দৈর্ঘ্য সীমা — ক্লায়েন্টের textarea-র maxlength বিশ্বাসযোগ্য নয়;
        // সীমা ছাড়া একটামাত্র মেসেজেই DB row/broadcast/Telegram পে-লোড ফুলিয়ে দেওয়া যেত।
        const MAX_MESSAGE_LEN = 4000;
        if (message && String(message).length > MAX_MESSAGE_LEN) return;

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
          emitAdminAlert('chat', {
            title: 'নতুন সাপোর্ট মেসেজ',
            message: message || 'একটি ফাইল পাঠানো হয়েছে'
          });
          // Telegram বার্তাটা parse_mode=HTML দিয়ে পাঠানো হয়, তাই ইউজারের username/message
          // সরাসরি বসালে সেটা Telegram-এর HTML হিসেবে ব্যাখ্যা হতো (মার্কআপ ইনজেকশন / বার্তা
          // বিকৃতি)। এন্টিটিগুলো এস্কেপ করে দেওয়া হচ্ছে।
          const tgEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          notifyTelegram(`💬 <b>নতুন সাপোর্ট মেসেজ</b>\n${tgEscape(u.username || 'ইউজার')}: ${message ? tgEscape(message) : '(ফাইল পাঠানো হয়েছে)'}`, { category: 'support' });

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

// ===== ডেমো (প্র্যাকটিস) কারেন্সি স্ট্যাটস — অ্যাডমিন ড্যাশবোর্ড =====
// মোট ডেমো সংখ্যাটি স্থায়ীভাবে নির্ধারিত (ফিক্সড) — এটি কোনো হিসাব থেকে আসে না,
// কেউ এটি পরিবর্তন/কমাতে-বাড়াতে পারবে না।
// বাকি তিনটি স্ট্যাট এখন সরাসরি ইউজারের আসল ব্যালেন্স (coins) ও বাজি থেকে
// রিয়েল-টাইম হিসাব হয় — তাই এটা ইউজারের প্রোফাইলে দেখা ব্যালেন্সের সাথে মিলবে।
const TOTAL_DEMO_FIXED = 9999999;

const getDemoStats = async () => {
  const heldByUsers = await pool.query(`SELECT COALESCE(SUM(coins),0) AS total FROM users`);
  // casino_bet এন্ট্রি এখন ঠিক সাইনে (নেগেটিভ, debit) লেখা হয় — মাস্টার অডিট
  // BUG-002 দেখুন (migrations.js Phase 08)। এখানে wagered টোটাল পূর্বের মতোই
  // ধনাত্মক দেখাতে -amount নেওয়া হচ্ছে (আচরণ অপরিবর্তিত রাখা)।
  const casinoWagered = await pool.query(
    `SELECT COALESCE(SUM(-amount),0) AS total FROM coin_transactions WHERE type='casino_bet'`
  );
  const sportsWagered = await pool.query(
    `SELECT COALESCE(SUM(stake),0) AS total FROM bets WHERE is_demo = false`
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

module.exports = { initSocket, updateLiveScore, getDemoStats, broadcastDemoStats, emitAdminAlert, notifyUserSeen, notifyAdminsSeen, allowChatMessage, CHAT_RATE_LIMIT, CHAT_RATE_WINDOW_SEC };
