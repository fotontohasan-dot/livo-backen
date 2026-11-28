// services/telegramApi.js
// Telegram Bot API-র পাতলা ক্লায়েন্ট। নোটিফিকেশন, webhook ও রিপ্লাই — সব একই বটে যায়:
// Admin প্যানেলে সেভ করা টোকেন, না থাকলে TELEGRAM_BOT_TOKEN। কোনো ফাংশন throw করে না; ব্যর্থতায় { ok:false } ফেরত দেয়।
// URL কখনো লগ করা হয় না (তাতে bot token থাকে)।
const { integrationFetch } = require('../utils/integrationHttp');
const telegramConfig = require('./telegramConfig');

const CHUNK_SIZE = 4000; // Telegram-এর সীমা 4096

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getBotToken() {
  try {
    const { botToken } = await telegramConfig.getConfig();
    if (botToken) return botToken;
  } catch (err) {
    console.error('[telegram] কনফিগ লোড ব্যর্থ:', err.message);
  }
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

async function telegramRequest(method, payload = {}) {
  const token = await getBotToken();
  if (!token) return { ok: false, description: 'bot_token_missing' };
  try {
    const res = await integrationFetch('telegram', `https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      const description = (json && json.description) || `HTTP ${res.status}`;
      console.error(`[telegram] ${method} ব্যর্থ: ${description}`);
      return { ok: false, description };
    }
    return json;
  } catch (err) {
    console.error(`[telegram] ${method} নেটওয়ার্ক ত্রুটি: ${err.message}`);
    return { ok: false, description: 'network_error' };
  }
}

/**
 * @param {string|number} chatId
 * @param {string} text - ডিফল্টে HTML; ইউজার-ইনপুট অবশ্যই escapeHtml() দিয়ে বসাতে হবে
 * @param {object} [options] - parse_mode (null দিলে প্লেইন টেক্সট), reply_markup ইত্যাদি sendMessage ফিল্ড
 */
function sendTelegramMessage(chatId, text, options = {}) {
  const { parse_mode = 'HTML', ...rest } = options;
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text,
    ...(parse_mode ? { parse_mode } : {}),
    ...rest
  });
}

/** লম্বা প্লেইন টেক্সট (যেমন AI-র উত্তর) টুকরো করে পাঠায়। */
async function sendPlainText(chatId, text) {
  let rest = String(text || '');
  let last = { ok: false, description: 'empty_text' };
  while (rest.length) {
    let cut = rest.length <= CHUNK_SIZE ? rest.length : rest.lastIndexOf('\n', CHUNK_SIZE);
    if (cut < CHUNK_SIZE / 2) cut = Math.min(CHUNK_SIZE, rest.length);
    last = await sendTelegramMessage(chatId, rest.slice(0, cut), { parse_mode: null });
    if (!last.ok) break;
    rest = rest.slice(cut);
  }
  return last;
}

module.exports = { escapeHtml, getBotToken, telegramRequest, sendTelegramMessage, sendPlainText };
