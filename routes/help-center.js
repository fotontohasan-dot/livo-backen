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
const { evaluateRequest, logBotEvent } = require('../services/botDetection');
const { getIpRule, getClientIp } = require('../services/ipRules');

// হেল্প সেন্টার পেজ রেন্ডার করবে
router.get('/', (req, res) => {
  res.render('help-center', {
    title: 'ব্যাটিং হেল্প সেন্টার',
    user: (req.session && req.session.user) || null
  });
});

// চ্যাটবট এপিআই এন্ডপয়েন্ট — Public API, তাই honeypot/CAPTCHA প্রযোজ্য না (JSON কল),
// কিন্তু rate/UA-ভিত্তিক বট ডিটেকশন প্রয়োগ করা হচ্ছে
// filterMiddleware() → req.body.message-এ গালাগালি/অশ্লীল/১৮+ কনটেন্ট থাকলে
// এখানেই 400 রিটার্ন করে দেয়, নিচের কোড আর চলে না।
router.post('/api/chat', filterMiddleware(), async (req, res) => {
  const userMessage = (req.body && req.body.message) || '';
  const ip = getClientIp(req);
  const userAgent = req.get('user-agent') || '';

  const rule = await getIpRule(ip);
  if (rule === 'block') {
    return res.status(403).json({ success: false, error: 'অ্যাক্সেস সীমাবদ্ধ করা হয়েছে।' });
  }

  if (rule !== 'whitelist') {
    const botCheck = evaluateRequest({ ip, userAgent, endpoint: '/help-center/api/chat' });
    if (botCheck.riskLevel === 'high') {
      logBotEvent({ ip, endpoint: '/help-center/api/chat', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent, blocked: true })
        .catch(e => console.error('logBotEvent error:', e.message));
      return res.status(429).json({ success: false, error: 'অনেকবার রিকোয়েস্ট করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।' });
    }
    if (botCheck.signals.length > 0) {
      logBotEvent({ ip, endpoint: '/help-center/api/chat', signals: botCheck.signals, riskLevel: botCheck.riskLevel, userAgent, blocked: false })
        .catch(e => console.error('logBotEvent error:', e.message));
    }
  }

  if (!userMessage.trim()) {
    return res.status(400).json({ success: false, error: 'বার্তা খালি রাখা যাবে না।' });
  }

  try {
    const reply = await getBotReply(userMessage);
    res.json({ success: true, reply });
  } catch (err) {
    console.error('help-center /api/chat error:', err.message);
    res.status(500).json({
      success: false,
      error: 'দুঃখিত, এই মুহূর্তে উত্তর দিতে পারছি না। এডমিন শীঘ্রই যোগাযোগ করবে।'
    });
  }
});

module.exports = router;
