// services/telegramNotifications.js
// অ্যাডমিনের Telegram-এ ডিপোজিট/উইথড্র (ইনলাইন বাটনসহ) ও সাপোর্ট মেসেজ নোটিফিকেশন।
// বাটন/রিপ্লাই প্রসেস করে services/telegramAdmin.js। দুটো ফাংশনই কখনো throw করে না।
const { pool } = require('../db');
const telegramConfig = require('./telegramConfig');
const { notifyTelegram } = require('./telegramNotify');
const { escapeHtml } = require('./telegramApi');

const SUPPORT_PREVIEW_LEN = 3000;
const LABEL = { deposit: 'ডিপোজিট', withdraw: 'উইথড্র' };

const clip = (v, max) => {
  const s = String(v == null ? '' : v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * বাটন তখনই কাজ করবে যখন নোটিফিকেশনটা webhook-ওয়ালা বট থেকেই অনুমোদিত অ্যাডমিন চ্যাটে যায়।
 * Admin প্যানেলে অন্য bot/chat সেট করা থাকলে বাটন ছাড়া সাধারণ নোটিফিকেশন যায়।
 */
function canUseButtons(config) {
  const adminChat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  return !!(
    config && adminChat && process.env.TELEGRAM_ADMIN_USER_IDS && process.env.TELEGRAM_WEBHOOK_SECRET &&
    config.botToken === process.env.TELEGRAM_BOT_TOKEN &&
    String(config.chatId) === String(adminChat)
  );
}

function paymentKeyboard(type, id) {
  const name = type === 'deposit' ? 'Deposit' : 'Withdraw';
  return {
    inline_keyboard: [[
      { text: `✅ Approve ${name}`, callback_data: `pay:approve:${type}:${id}` },
      { text: `❌ Reject ${name}`, callback_data: `pay:reject:${type}:${id}` }
    ]]
  };
}

async function notifyPaymentRequest(requestId) {
  try {
    const r = await pool.query(
      `SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON u.id = pr.user_id WHERE pr.id = $1`,
      [requestId]
    );
    const p = r.rows[0];
    if (!p || !LABEL[p.type] || p.status !== 'pending') return { sent: false, reason: 'not_pending' };

    const lines = [
      `${p.type === 'deposit' ? '💰' : '🏧'} <b>নতুন ${LABEL[p.type]} রিকোয়েস্ট</b>`,
      `রিকোয়েস্ট: #${p.id}`,
      `ইউজার: ${escapeHtml(p.username)} (user_id: ${p.user_id})`,
      `পরিমাণ: ${escapeHtml(p.amount)} টাকা`,
      `মেথড: ${escapeHtml(p.method)}`
    ];
    if (p.account_number) lines.push(`অ্যাকাউন্ট: <code>${escapeHtml(clip(p.account_number, 100))}</code>`);
    if (p.transaction_id) lines.push(`Transaction ID: <code>${escapeHtml(clip(p.transaction_id, 100))}</code>`);
    if (p.want_bonus) lines.push('বোনাস: নিতে চায়');

    const config = await telegramConfig.getConfig();
    return await notifyTelegram(lines.join('\n'), {
      category: p.type,
      replyMarkup: canUseButtons(config) ? paymentKeyboard(p.type, p.id) : undefined
    });
  } catch (err) {
    console.error('telegram payment notification error:', err.message);
    return { sent: false, reason: 'error' };
  }
}

/**
 * প্রথম লাইনটা (`🎫 SUPPORT #U<userId>`) সার্ভার-নির্ধারিত — Telegram থেকে Reply দিলে
 * services/telegramAdmin.js শুধু এই লাইন থেকেই ইউজার চেনে। ইউজারের লেখা কখনো প্রথম লাইনে যায় না।
 */
async function notifySupportMessage({ userId, username, messageId, message, liveAgent = false }) {
  try {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) return { sent: false, reason: 'invalid_user' };
    const body = liveAgent
      ? '🙋 লাইভ এজেন্ট রিকোয়েস্ট'
      : (message ? escapeHtml(clip(message, SUPPORT_PREVIEW_LEN)) : '(ফাইল পাঠানো হয়েছে — অ্যাডমিন প্যানেলে দেখুন)');
    const text = [
      `🎫 SUPPORT #U${id}${messageId ? ` #M${Number(messageId)}` : ''}`,
      `ইউজার: ${escapeHtml(clip(username || 'ইউজার', 100))} (user_id: ${id})`,
      '',
      body,
      '',
      `↩️ এই মেসেজে Reply দিন, অথবা <code>/reply ${id} আপনার উত্তর</code>`
    ].join('\n');
    return await notifyTelegram(text, { category: 'support', disablePreview: true });
  } catch (err) {
    console.error('telegram support notification error:', err.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { notifyPaymentRequest, notifySupportMessage, canUseButtons };
