// routes/help-center.js
// ---------------------------------------------------------------------------
// "ব্যাটিং হেল্প সেন্টার" পেজ + এর ছোট FAQ চ্যাটবট API।
// বট রিপ্লাই লজিকের জন্য services/chatbot.js (একই ফাইল যেটা লাইভ সাপোর্ট চ্যাটের
// বট-মোডেও ব্যবহার হয়) রিইউজ করা হয়েছে, যাতে দুই জায়গায় আলাদা/অসামঞ্জস্যপূর্ণ
// FAQ লজিক না থাকে।
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const { filterMiddleware } = require('../middleware/filterMiddleware');
const { getBotReply } = require('../services/chatbot');
const { requireFeature } = require('../middleware/featureGate');
const rateLimit = require('express-rate-limit');

// PHASE 13/6 fix (MEDIUM-12): এই endpoint টি unauthenticated এবং FAQ-তে না
// মিললে একটি পয়সা-খরচকারী third-party LLM API-তে অনুরোধ পাঠায়। আগে এর
// নিজস্ব কোনো সীমা ছিল না — শুধু global limiter (300/15min per IP)। ফলে
// যে কেউ API credit পুড়িয়ে দিতে পারত, এবং লম্বা বার্তা পাঠিয়ে token খরচ
// বহুগুণ বাড়াতে পারত। তাই ডেডিকেটেড rate limit + বার্তার দৈর্ঘ্যসীমা।
const MAX_CHAT_MESSAGE_LEN = 1000;

const helpChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: req.t('help_center_rate_limited')
  })
});

// হেল্প সেন্টার পেজ রেন্ডার করবে
router.get('/', (req, res) => {
  res.render('help-center', {
    title: req.t('help_center_title'),
    user: (req.session && req.session.user) || null
  });
});

// চ্যাটবট এপিআই এন্ডপয়েন্ট
// filterMiddleware() → req.body.message-এ গালাগালি/অশ্লীল/১৮+ কনটেন্ট থাকলে
// এখানেই 400 রিটার্ন করে দেয়, নিচের কোড আর চলে না।
router.post('/api/chat', helpChatLimiter, requireFeature('ai_chatbot'), filterMiddleware(), async (req, res) => {
  const userMessage = (req.body && typeof req.body.message === 'string') ? req.body.message : '';

  if (!userMessage.trim()) {
    return res.status(400).json({ success: false, error: req.t('common_message_empty') });
  }

  // দৈর্ঘ্যসীমা: upstream token খরচ সীমিত রাখে
  if (userMessage.length > MAX_CHAT_MESSAGE_LEN) {
    return res.status(400).json({
      success: false,
      error: req.t('help_center_message_too_long')
    });
  }

  try {
    const reply = await getBotReply(userMessage);
    res.json({ success: true, reply });
  } catch (err) {
    console.error('help-center /api/chat error:', err.message);
    res.status(500).json({
      success: false,
      error: req.t('help_center_bot_unavailable')
    });
  }
});

module.exports = router;
