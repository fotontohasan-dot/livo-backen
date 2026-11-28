// services/telegramNotifications.js
// অ্যাডমিনের Telegram-এ ডিপোজিট/উইথড্র (ইনলাইন বাটনসহ) ও সাপোর্ট মেসেজ নোটিফিকেশন।
// বাটন/রিপ্লাই প্রসেস করে services/telegramAdmin.js। দুটো ফাংশনই কখনো throw করে না।
const { pool } = require('../db');
const { notifyTelegram } = require('./telegramNotify');
const { escapeHtml } = require('./telegramApi');
const { configProblem, webhookRegistrationFailure } = require('./telegramWebhookSetup');
const { CATEGORIES } = require('./supportReports');

const SUPPORT_PREVIEW_LEN = 3000;
const LABEL = { deposit: 'ডিপোজিট', withdraw: 'উইথড্র' };

const clip = (v, max) => {
  const s = String(v == null ? '' : v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

function paymentKeyboard(type, id) {
  const name = type === 'deposit' ? 'Deposit' : 'Withdraw';
  return {
    inline_keyboard: [[
      { text: `✅ Approve ${name}`, callback_data: `pay:approve:${type}:${id}` },
      { text: `❌ Reject ${name}`, callback_data: `pay:reject:${type}:${id}` }
    ]]
  };
}

const PAYMENT_SELECT = `SELECT pr.*, u.username FROM payment_requests pr JOIN users u ON u.id = pr.user_id`;

/** একটা pending রিকোয়েস্টের মেসেজ ও বাটন (নোটিফিকেশন ও /pending দুটোই ব্যবহার করে)। */
function buildPaymentMessage(p) {
  const lines = [
    `${p.type === 'deposit' ? '💰' : '🏧'} <b>নতুন ${LABEL[p.type]} রিকোয়েস্ট</b>`,
    `রেফারেন্স: <code>#${p.id}</code>`,
    `ইউজার: ${escapeHtml(p.username)} (user_id: ${p.user_id})`,
    `পরিমাণ: ${escapeHtml(p.amount)} টাকা`,
    `মেথড: ${escapeHtml(p.method)}`
  ];
  if (p.account_number) lines.push(`অ্যাকাউন্ট: <code>${escapeHtml(clip(p.account_number, 100))}</code>`);
  // ডিপোজিটে লাইনটা সবসময় থাকে, যাতে TrxID না থাকাটাও অ্যাডমিনের চোখে পড়ে
  if (p.type === 'deposit' || p.transaction_id) {
    lines.push(`ট্রানজ্যাকশন আইডি: ${p.transaction_id ? `<code>${escapeHtml(clip(p.transaction_id, 100))}</code>` : 'নেই'}`);
  }
  if (p.want_bonus) lines.push('বোনাস: নিতে চায়');

  // বাটন কাজ না করার কারণ থাকলে নীরবে লুকানো হয় না, মেসেজেই লেখা থাকে
  const blocked = configProblem();
  if (blocked) lines.push('', `⚠️ বাটন বন্ধ: ${escapeHtml(blocked)}`);
  else if (webhookRegistrationFailure()) lines.push('', `⚠️ Webhook রেজিস্টার হয়নি: ${escapeHtml(webhookRegistrationFailure())}`);

  return { text: lines.join('\n'), replyMarkup: blocked ? undefined : paymentKeyboard(p.type, p.id) };
}

async function notifyPaymentRequest(requestId) {
  try {
    const r = await pool.query(`${PAYMENT_SELECT} WHERE pr.id = $1`, [requestId]);
    const p = r.rows[0];
    if (!p || !LABEL[p.type] || p.status !== 'pending') return { sent: false, reason: 'not_pending' };

    const { text, replyMarkup } = buildPaymentMessage(p);
    return await notifyTelegram(text, { category: p.type, replyMarkup });
  } catch (err) {
    console.error('telegram payment notification error:', err.message);
    return { sent: false, reason: 'error' };
  }
}

/** ম্যানুয়াল (গেটওয়ে নয়) pending রিকোয়েস্ট, পুরনোটা আগে। */
async function listPendingPayments(limit = 10) {
  const r = await pool.query(
    `${PAYMENT_SELECT} WHERE pr.status = 'pending' AND pr.type IN ('deposit','withdraw') AND pr.gateway IS NULL
     ORDER BY pr.created_at ASC, pr.id ASC LIMIT $1`,
    [limit]
  );
  return r.rows;
}

/**
 * প্রথম লাইনটা (`🎫 SUPPORT #U<userId>`) সার্ভার-নির্ধারিত — Telegram থেকে Reply দিলে
 * services/telegramAdmin.js শুধু এই লাইন থেকেই ইউজার চেনে। ইউজারের লেখা কখনো প্রথম লাইনে যায় না।
 */
async function notifySupportMessage({ userId, username, messageId, message, liveAgent = false, topic = null }) {
  try {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) return { sent: false, reason: 'invalid_user' };
    const body = liveAgent
      ? `🙋 লাইভ এজেন্ট রিকোয়েস্ট${topic ? `\nবিষয়: ${escapeHtml(topic)}` : ''}`
      : (message ? escapeHtml(clip(message, SUPPORT_PREVIEW_LEN)) : '(ফাইল পাঠানো হয়েছে — অ্যাডমিন প্যানেলে দেখুন)');
    return await sendSupportText({ id, username, messageId, bodyLines: [body] });
  } catch (err) {
    console.error('telegram support notification error:', err.message);
    return { sent: false, reason: 'error' };
  }
}

function sendSupportText({ id, username, messageId, bodyLines }) {
  const text = [
    `🎫 SUPPORT #U${id}${messageId ? ` #M${Number(messageId)}` : ''}`,
    `ইউজার: ${escapeHtml(clip(username || 'ইউজার', 100))} (user_id: ${id})`,
    '',
    ...bodyLines,
    '',
    `↩️ এই মেসেজে Reply দিন, অথবা <code>/reply ${id} আপনার উত্তর</code>`
  ].join('\n');
  return notifyTelegram(text, { category: 'support', disablePreview: true });
}

/** লাইভ চ্যাটের ডিপোজিট/উইথড্র সমস্যার ফর্ম — নির্দিষ্ট ফরম্যাটে (data আগেই যাচাই করা)। */
async function notifySupportReport({ userId, username, messageId, reportId, category, data }) {
  try {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0 || !CATEGORIES[category]) return { sent: false, reason: 'invalid_report' };
    const value = (v) => (v ? `<code>${escapeHtml(v)}</code>` : 'দেওয়া হয়নি');
    return await sendSupportText({
      id, username, messageId,
      bodyLines: [
        `${CATEGORIES[category].icon} <b>${CATEGORIES[category].adminLabel}</b> — রিপোর্ট <code>#R${Number(reportId)}</code>`,
        `প্রেরকের নম্বর: ${value(data.senderNumber)}`,
        `রিসিভার নম্বর: ${value(data.receiverNumber)}`,
        `ট্রানজ্যাকশন আইডি: ${value(data.transactionId)}`,
        `সময়: ${data.occurredAt ? escapeHtml(data.occurredAt) : 'দেওয়া হয়নি'}`
      ]
    });
  } catch (err) {
    console.error('telegram support report error:', err.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = {
  notifyPaymentRequest, notifySupportMessage, notifySupportReport, buildPaymentMessage, listPendingPayments
};
