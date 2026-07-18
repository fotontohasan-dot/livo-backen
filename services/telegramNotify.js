// services/telegramNotify.js
// ---------------------------------------------------------------------------
// ডিপোজিট, উইথড্র রিকোয়েস্ট বা সাপোর্ট মেসেজ এলে অ্যাডমিনের Telegram-এ নোটিফিকেশন পাঠায়।
// telegram-bot.js-এর AI assistant বট থেকে আলাদা — শুধু এক-মুখী নোটিফিকেশনের জন্য,
// তাই এখানে webhook/AI কিছু লাগে না, শুধু sendMessage কল করলেই চলে।
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// TELEGRAM_ADMIN_CHAT_ID (telegram-bot.js-এ ব্যবহৃত মূল ভ্যারিয়েবল) না থাকলে
// TELEGRAM_CHAT_ID ফলব্যাক হিসেবে গ্রহণ করা হয়
const CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !CHAT_ID) return; // সেট করা না থাকলে চুপচাপ স্কিপ, বাকি ফ্লো আটকাবে না
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('telegramNotify: sendMessage ব্যর্থ:', res.status, body);
    }
  } catch (err) {
    console.error('telegramNotify error:', err.message);
  }
}

module.exports = { notifyTelegram };
