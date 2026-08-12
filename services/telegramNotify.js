// services/telegramNotify.js
// ---------------------------------------------------------------------------
// ডিপোজিট, উইথড্র রিকোয়েস্ট বা সাপোর্ট মেসেজ এলে অ্যাডমিনের Telegram-এ নোটিফিকেশন পাঠায়।
// telegram-bot.js-এর AI assistant বট থেকে আলাদা — শুধু এক-মুখী নোটিফিকেশনের জন্য,
// তাই এখানে webhook/AI কিছু লাগে না, শুধু sendMessage কল করলেই চলে।
//
// কনফিগ (bot token / chat id / on-off টগল) এখন services/telegramConfig.js থেকে আসে —
// Admin প্যানেলে (/admin/telegram) কিছু সেভ করা না থাকলে আগের মতোই .env-এর
// TELEGRAM_BOT_TOKEN + TELEGRAM_ADMIN_CHAT_ID/TELEGRAM_CHAT_ID ব্যবহার হয়, তাই
// বিদ্যমান ডিপ্লয়মেন্টে আচরণ অপরিবর্তিত থাকে।
// ---------------------------------------------------------------------------

const telegramConfig = require('./telegramConfig');

/**
 * @param {string} text - HTML-ফরম্যাটেড মেসেজ
 * @param {Object} [opts]
 * @param {'deposit'|'withdraw'|'support'|'security'|'system'} [opts.category]
 *        - দেওয়া থাকলে Admin প্যানেলে সেই ক্যাটাগরির টগল বন্ধ থাকলে মেসেজ পাঠানো হয় না।
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function notifyTelegram(text, opts = {}) {
  let config;
  try {
    config = await telegramConfig.getConfig();
  } catch (err) {
    console.error('telegramNotify: কনফিগ লোড ব্যর্থ:', err.message);
    return { sent: false, reason: 'config_error' };
  }

  // সেট করা না থাকলে/বন্ধ থাকলে চুপচাপ স্কিপ, বাকি ফ্লো আটকাবে না
  if (!telegramConfig.shouldNotify(config, opts.category)) {
    if (!config.enabled) return { sent: false, reason: 'disabled' };
    if (!config.botToken || !config.chatId) return { sent: false, reason: 'not_configured' };
    return { sent: false, reason: 'category_disabled' };
  }

  try {
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: 'HTML' })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // URL কখনো লগ করা হয় না — তাতে bot token থাকে
      console.error('telegramNotify: sendMessage ব্যর্থ:', res.status, body);
      return { sent: false, reason: 'api_error' };
    }
    return { sent: true };
  } catch (err) {
    console.error('telegramNotify error:', err.message);
    return { sent: false, reason: 'network_error' };
  }
}

module.exports = { notifyTelegram };
