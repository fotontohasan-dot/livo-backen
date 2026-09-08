// routes/games.js
// ---------------------------------------------------------------------------
// PHASE 1 — ইন-হাউস গেম সম্পূর্ণ অপসারণ
//
// আগে এই ফাইলে ১১৮টি গেমের ক্যাটালগ, সার্ভার-সাইড RNG (crash point জেনারেটর,
// হ্যান্ডলার ভিত্তিক সেটেলমেন্ট), ব্যালেন্স ডেবিট/ক্রেডিট ও লেজার-রাইট — সব
// একসাথে ছিল। প্ল্যাটফর্ম এখন থার্ড-পার্টি প্রোভাইডারের গেম চালাবে, তাই
// RNG-র দায়িত্ব প্রোভাইডারের কাছে চলে গেছে এবং ব্যালেন্স মিউটেশনের একমাত্র
// পথ হবে Seamless Wallet API (PHASE 2 — routes/providerWallet.js)।
//
// এই রাউটারে ইচ্ছাকৃতভাবে যা টিকে আছে:
//   • requireFeature('games') — রাউটার-লেভেল ফিচার গেট (আগের মতোই)
//   • GET /api/recent-wins    — coin_transactions থেকে পড়ে, প্রোভাইডার
//                               গেমের জয়েও একইভাবে কাজ করবে
//
// লবি ও লঞ্চ রুট PHASE 3-এ (services/casinoProviders + casinoGameSync) আসবে।
// ততক্ষণ পর্যন্ত /games খালি স্টেট দেখাবে — এটাই কাঙ্ক্ষিত আচরণ।
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { requireFeature } = require('../middleware/featureGate');

// পুরো রাউটারে ফিচার গেট — নির্দিষ্ট রুট নয়, রাউটার-লেভেলে বসানো হয়েছে
// যাতে ভবিষ্যতে যোগ হওয়া সাব-রুটও আপনাআপনি সুরক্ষিত থাকে, আর সরাসরি
// URL দিয়ে কোনো পথ বাদ পড়ে না যায়।
router.use(requireFeature('games'));

const { pool } = require('../db');

// ==================== সাম্প্রতিক বড় জয় (পাবলিক, রিড-অনলি) ====================
// ডেটা সোর্স: coin_transactions — গেম খেলার নিট ফল এখানেই লেখা হয়
// (type='game_play')। ধনাত্মক amount মানে ইউজার জিতেছে। প্রোভাইডার ওয়ালেট
// API-ও win ক্রেডিট একই টেবিলে একই type দিয়ে লেখে, তাই এই এন্ডপয়েন্ট
// অপরিবর্তিত থেকেই নতুন কাঠামোতে কাজ করে।
//
// গোপনীয়তা: ইউজারনেম কখনো পুরোটা যায় না — শুধু শেষ ৩ অক্ষর, আগে তারকা চিহ্ন।
// user_id, ইমেইল, ফোন বা ব্যালেন্স কিছুই বের হয় না। ফলে সেকশনটা পাবলিক থাকতে পারে।
router.get('/api/recent-wins', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.username, ct.amount, ct.description, ct.created_at
       FROM coin_transactions ct
       JOIN users u ON u.id = ct.user_id
       WHERE ct.type = 'game_play' AND ct.amount > 0
       ORDER BY ct.created_at DESC
       LIMIT 10`
    );

    const wins = result.rows.map((row) => {
      const name = String(row.username || '');
      const tail = name.length > 3 ? name.slice(-3) : name;
      return {
        user: `******${tail}`,
        game: row.description || 'Game',
        amount: Number(row.amount)
      };
    });

    res.json({ success: true, wins });
  } catch (err) {
    console.error('recent-wins error:', err.message);
    // ব্যর্থ হলেও হোমপেজ যেন না ভাঙে — খালি তালিকা, ২০০ নয় বরং সৎ খালি ফল
    res.json({ success: true, wins: [] });
  }
});

module.exports = router;
