// routes/telegramWebhook.js
// POST /api/telegram/webhook (পুরনো /telegram-webhook অ্যালিয়াস হিসেবে থাকছে)।
// সেশন/CSRF/মেইনটেন্যান্স মিডলওয়্যারের আগে মাউন্ট হয়; সুরক্ষা secret-token হেডার দিয়ে।
const express = require('express');
const router = express.Router();
const { createLimiter } = require('../middleware/rateLimitFactory');
const { verifyWebhookSecret, isDuplicateUpdate } = require('../telegram-bot');
const { processUpdate } = require('../services/telegramAdmin');

// secret যাচাইয়ের আগেই যাতে কেউ অসীম রিকোয়েস্ট পাঠিয়ে CPU/লগ ভাসিয়ে দিতে না পারে
const telegramWebhookLimiter = createLimiter('telegram-webhook', {
  windowMs: 60 * 1000,
  max: 120,
  message: 'Too many requests'
});

const requireSecret = (rejectStatus) => (req, res, next) => {
  if (verifyWebhookSecret(req.get('X-Telegram-Bot-Api-Secret-Token'))) return next();
  console.warn(`⚠️ ${req.path}: অবৈধ বা অনুপস্থিত secret token — request বাতিল।`);
  return res.sendStatus(rejectStatus);
};

function handleUpdate(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // সাথে সাথে 200: AI-র উত্তর দেরি হলেও Telegram যেন একই update বারবার না পাঠায়
  res.sendStatus(200);
  if (isDuplicateUpdate(body.update_id)) {
    console.warn('⚠️ Telegram webhook: পুনরাবৃত্ত update_id — উপেক্ষা করা হলো।');
    return;
  }
  processUpdate(body).catch((err) => console.error('Telegram webhook error:', err.message));
}

const parseJson = express.json({ limit: '256kb' });

router.post('/api/telegram/webhook', telegramWebhookLimiter, requireSecret(403), parseJson, handleUpdate);
router.post('/telegram-webhook', telegramWebhookLimiter, requireSecret(401), parseJson, handleUpdate);

module.exports = router;
