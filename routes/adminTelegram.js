// routes/adminTelegram.js
// ---------------------------------------------------------------------------
// Admin → Telegram Integration সেটিংস পেজ।
//
// নিরাপত্তা স্তরগুলো:
//  • isAdmin — app.js-এ মাউন্ট করার সময় বসানো (routes/admin.js-এর মতোই প্রথম গেট)
//  • rbac.requirePermission('settings_view' / 'settings_edit') — সূক্ষ্ম RBAC স্তর
//  • CSRF — middleware/csrf.js পুরো অ্যাপে গ্লোবাল; admin layout প্রতিটা form/fetch-এ
//    টোকেন বসিয়ে দেয়, তাই আলাদা কিছু করতে হয় না (এই রুটগুলো কোনো exempt প্রিফিক্সে পড়ে না)
//  • rate limit — টেস্ট/সেভ এন্ডপয়েন্টে আলাদা কড়া সীমা (Telegram API abuse ঠেকাতে)
//  • Audit — প্রতিটা mutation admin_logs + audit_logs দুই জায়গাতেই লেখা হয়
//
// Bot token কখনো response/view/লগে যায় না — শুধু masked hint দেখানো হয়।
// ---------------------------------------------------------------------------

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const rbac = require('../services/rbac');
const RedisRateLimitStore = require('../services/redisRateLimitStore');
const { logAdminAction, logEvent: logAuditEvent } = require('../services/auditLog');
const telegramConfig = require('../services/telegramConfig');
const { notifyTelegram } = require('../services/telegramNotify');

// Telegram API-তে বাইরের কল যায় এমন রুটে (test/test-notification) কড়া সীমা
const telegramTestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'অনেকবার টেস্ট করা হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন।',
  store: new RedisRateLimitStore('rl:tgtest:'),
  handler: (req, res) => res.status(429).json({ success: false, error: 'অনেকবার টেস্ট করা হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন।' })
});

const telegramSaveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'অনেকবার সেভ করা হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন।',
  store: new RedisRateLimitStore('rl:tgsave:')
});

function actorOf(req) {
  return {
    id: req.session && req.session.user ? req.session.user.id : null,
    username: req.session && req.session.user ? req.session.user.username : 'UNKNOWN'
  };
}

/** admin_logs + audit_logs — দুটোর কোনোটাই মূল অ্যাকশনকে ব্লক/ব্যর্থ করে না */
async function audit(req, { actionType, details, action, riskLevel = 'medium', status = 'success', meta = {} }) {
  const actor = actorOf(req);
  try {
    await logAdminAction(actor.id, actor.username, actionType, details, req.ip);
  } catch (e) {
    console.error('adminTelegram logAdminAction error:', e.message);
  }
  logAuditEvent({
    req, actorType: 'admin', actorId: actor.id, actorUsername: actor.username,
    action, category: 'settings', status, riskLevel, details: meta
  }).catch(e => console.error(`adminTelegram logAuditEvent (${action}) error:`, e.message));
}

// ==================== পেজ ====================
router.get('/', rbac.requirePermission('settings_view'), async (req, res) => {
  try {
    const status = await telegramConfig.getStatus();
    res.render('admin/telegram', {
      status,
      categoryLabels: telegramConfig.CATEGORY_LABELS,
      categories: telegramConfig.CATEGORIES,
      saved: req.query.saved === '1',
      saveError: req.query.error ? String(req.query.error) : ''
    });
  } catch (err) {
    console.error('Telegram settings load error:', err && err.stack ? err.stack : err);
    res.render('admin/telegram', {
      status: {
        enabled: false, chatId: null, categories: telegramConfig.DEFAULT_CATEGORIES, tokenSet: false,
        tokenMasked: '', tokenSource: 'none', chatIdSource: 'none', ready: false, active: false,
        encryptionAvailable: telegramConfig.isEncryptionAvailable(), webhookSecretSet: false, configuredInDb: false
      },
      categoryLabels: telegramConfig.CATEGORY_LABELS,
      categories: telegramConfig.CATEGORIES,
      saved: false,
      saveError: 'সেটিংস লোড করা যায়নি।'
    });
  }
});

// JSON স্ট্যাটাস (পেজের auto-refresh ব্যাজের জন্য) — টোকেন কখনো এখানে থাকে না
router.get('/status', rbac.requirePermission('settings_view'), async (req, res) => {
  try {
    res.json({ success: true, status: await telegramConfig.getStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: 'স্ট্যাটাস লোড করা যায়নি।' });
  }
});

// ==================== সেটিংস সেভ (chat id + notification টগল) ====================
router.post('/settings', telegramSaveLimiter, rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const rawChatId = req.body.chat_id === undefined || req.body.chat_id === null ? '' : String(req.body.chat_id).trim();
    if (rawChatId && !telegramConfig.isValidChatId(rawChatId)) {
      return res.redirect('/admin/telegram?error=' + encodeURIComponent('Chat ID সঠিক নয় (সংখ্যা অথবা @username হতে হবে)।'));
    }

    const enabled = ['true', 'on', '1'].includes(String(req.body.enabled).toLowerCase());
    const categories = telegramConfig.normalizeCategories(req.body.categories || {});

    const { changed } = await telegramConfig.saveConfig(
      { enabled, chatId: rawChatId || null, categories },
      actorOf(req)
    );

    await audit(req, {
      actionType: 'TELEGRAM_SETTINGS_UPDATE',
      details: `Telegram ইন্টিগ্রেশন সেটিংস পরিবর্তন (${changed.join(', ') || 'কোনো পরিবর্তন নেই'})`,
      action: 'TELEGRAM_SETTINGS_CHANGED',
      riskLevel: 'medium',
      meta: { changed, enabled, categories, chatIdSet: !!rawChatId }
    });

    return res.redirect('/admin/telegram?saved=1');
  } catch (err) {
    console.error('Telegram settings save error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.redirect('/admin/telegram?error=' + encodeURIComponent('সেটিংস সেভ করা যায়নি।'));
  }
});

// ==================== Bot token সেট/রোটেট/ক্লিয়ার ====================
router.post('/token', telegramSaveLimiter, rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const action = String(req.body.action || 'set');

    if (action === 'clear') {
      await telegramConfig.saveConfig({ botToken: null }, actorOf(req));
      await audit(req, {
        actionType: 'TELEGRAM_TOKEN_CLEARED',
        details: 'Telegram bot token ডাটাবেস থেকে মুছে ফেলা হয়েছে (.env ফলব্যাক সক্রিয়)',
        action: 'TELEGRAM_TOKEN_CLEARED',
        riskLevel: 'high'
      });
      return res.redirect('/admin/telegram?saved=1');
    }

    const token = String(req.body.bot_token || '').trim();
    if (!telegramConfig.isValidBotToken(token)) {
      return res.redirect('/admin/telegram?error=' + encodeURIComponent('Bot token-এর ফরম্যাট সঠিক নয়।'));
    }
    if (!telegramConfig.isEncryptionAvailable()) {
      return res.redirect('/admin/telegram?error=' + encodeURIComponent('এনক্রিপশন কী সেট নেই — TELEGRAM_SETTINGS_KEY (বা SESSION_SECRET) ছাড়া টোকেন সেভ করা হবে না।'));
    }

    await telegramConfig.saveConfig({ botToken: token }, actorOf(req));

    // লগে কখনো পুরো টোকেন যায় না — শুধু masked hint
    await audit(req, {
      actionType: 'TELEGRAM_TOKEN_ROTATED',
      details: `Telegram bot token পরিবর্তন করা হয়েছে (${telegramConfig.maskToken(token)})`,
      action: 'TELEGRAM_TOKEN_ROTATED',
      riskLevel: 'high',
      meta: { tokenHint: telegramConfig.maskToken(token) }
    });

    return res.redirect('/admin/telegram?saved=1');
  } catch (err) {
    console.error('Telegram token save error:', err && err.stack ? err.stack : err);
    if (!res.headersSent) return res.redirect('/admin/telegram?error=' + encodeURIComponent('টোকেন সেভ করা যায়নি।'));
  }
});

// ==================== কানেকশন টেস্ট (getMe, ঐচ্ছিকভাবে টেস্ট মেসেজ) ====================
router.post('/test', telegramTestLimiter, rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const sendMessage = req.body.send_message === true || ['true', 'on', '1'].includes(String(req.body.send_message).toLowerCase());
    const result = await telegramConfig.testConnection({ sendMessage });

    await telegramConfig.recordTestResult({
      status: result.success ? 'success' : 'failure',
      error: result.success ? null : result.error,
      botUsername: result.botUsername || null
    });

    await audit(req, {
      actionType: 'TELEGRAM_CONNECTION_TEST',
      details: `Telegram কানেকশন টেস্ট: ${result.success ? 'সফল' : 'ব্যর্থ'}${result.error ? ' — ' + result.error : ''}`,
      action: 'TELEGRAM_CONNECTION_TESTED',
      status: result.success ? 'success' : 'failure',
      riskLevel: 'low',
      meta: { sendMessage, botUsername: result.botUsername || null, error: result.error || null }
    });

    const status = await telegramConfig.getStatus();
    return res.status(result.success ? 200 : 400).json({ ...result, status });
  } catch (err) {
    console.error('Telegram test error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: 'টেস্ট চালানো যায়নি।' });
  }
});

// ==================== টেস্ট নোটিফিকেশন (আসল notifyTelegram ফ্লো দিয়ে) ====================
// এটা testConnection()-এর মতো সরাসরি API কল না — enabled/category গেটসহ পুরো
// প্রোডাকশন নোটিফিকেশন পাথ ব্যবহার করে, তাই টগলগুলো আসলেই কাজ করছে কিনা যাচাই হয়।
router.post('/test-notification', telegramTestLimiter, rbac.requirePermission('settings_edit'), async (req, res) => {
  try {
    const category = telegramConfig.CATEGORIES.includes(String(req.body.category)) ? String(req.body.category) : null;
    const actor = actorOf(req);
    const result = await notifyTelegram(
      `🧪 <b>Livo Admin — টেস্ট নোটিফিকেশন</b>\nপাঠিয়েছেন: ${actor.username}${category ? `\nক্যাটাগরি: ${telegramConfig.CATEGORY_LABELS[category]}` : ''}`,
      { category }
    );

    const reasonText = {
      disabled: 'ইন্টিগ্রেশন বন্ধ আছে।',
      not_configured: 'Bot token বা Chat ID সেট করা নেই।',
      category_disabled: 'এই ক্যাটাগরির নোটিফিকেশন বন্ধ আছে।',
      api_error: 'Telegram API রিকোয়েস্ট প্রত্যাখ্যান করেছে।',
      network_error: 'Telegram API-তে পৌঁছানো যায়নি।',
      config_error: 'কনফিগ লোড করা যায়নি।'
    };

    await audit(req, {
      actionType: 'TELEGRAM_TEST_NOTIFICATION',
      details: `Telegram টেস্ট নোটিফিকেশন (${category || 'general'}): ${result.sent ? 'পাঠানো হয়েছে' : 'পাঠানো হয়নি — ' + (result.reason || 'unknown')}`,
      action: 'TELEGRAM_TEST_NOTIFICATION_SENT',
      status: result.sent ? 'success' : 'failure',
      riskLevel: 'low',
      meta: { category, sent: result.sent, reason: result.reason || null }
    });

    if (result.sent) return res.json({ success: true, message: 'টেস্ট নোটিফিকেশন পাঠানো হয়েছে।' });
    return res.status(400).json({ success: false, error: reasonText[result.reason] || 'নোটিফিকেশন পাঠানো যায়নি।', reason: result.reason });
  } catch (err) {
    console.error('Telegram test notification error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: 'টেস্ট নোটিফিকেশন পাঠানো যায়নি।' });
  }
});

module.exports = router;
