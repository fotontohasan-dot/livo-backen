// services/telegramAdmin.js
// Webhook থেকে আসা update-এর রাউটার:
//   • callback_query            → ডিপোজিট/উইথড্র Approve/Reject
//   • /pending                  → অপেক্ষমাণ রিকোয়েস্ট, বাটনসহ
//   • সাপোর্ট মেসেজে Reply, /reply → ইউজারের সাপোর্ট চ্যাটে উত্তর
//   • বাকি সব মেসেজ              → telegram-bot.js (Claude AI assistant)
// অনুমোদনের নিয়ম: services/telegramAccess.js (AI assistant-এর নিয়ম আলাদা ও কড়া)।
const { pool } = require('../db');
const bot = require('../telegram-bot');
const { escapeHtml, getBotToken, telegramRequest, sendTelegramMessage } = require('./telegramApi');
const { isAdminActor, denialHint } = require('./telegramAccess');
const { buildPaymentMessage, listPendingPayments } = require('./telegramNotifications');
const { logEvent } = require('./auditLog');
const notify = require('./notify');
const { sanitizeText } = require('../middleware/validate');

const CALLBACK_RE = /^pay:(approve|reject):(deposit|withdraw):(\d{1,9})$/;
const SUPPORT_HEADER_RE = /^🎫 SUPPORT #U(\d{1,9})(?: #M\d+)?$/;
const REPLY_CMD_RE = /^\/reply(?:@\w+)?\s+(\d{1,9})\s+([\s\S]+)$/;
const MAX_REPLY_LEN = 2000;

const actorName = (from) => `TELEGRAM:${from.id}`;

function audit(from, action, { status = 'success', riskLevel = 'high', category = 'financial', details = {} } = {}) {
  logEvent({ actorType: 'admin', actorUsername: actorName(from), action, category, status, riskLevel, details })
    .catch((e) => console.error('telegram audit error:', e.message));
}

// ==================== পেমেন্ট বাটন ====================
async function finishCallbackMessage(message, resultLine) {
  const original = String(message.text || '').slice(0, 3500);
  const text = `${escapeHtml(original)}\n\n<b>${escapeHtml(resultLine)}</b>`;
  // reply_markup না পাঠালে Telegram বাটনগুলো সরিয়ে দেয়
  const edited = await telegramRequest('editMessageText', {
    chat_id: message.chat.id, message_id: message.message_id, text, parse_mode: 'HTML'
  });
  if (!edited.ok) await sendTelegramMessage(message.chat.id, text);
}

async function handleCallbackQuery(query) {
  const from = query.from;
  const message = query.message;
  const answer = (text, showAlert = false) => telegramRequest('answerCallbackQuery', {
    callback_query_id: query.id, text, show_alert: showAlert
  });

  const actor = { chat: message && message.chat, from };
  if (!(await isAdminActor(actor))) {
    console.warn(`⚠️ অননুমোদিত Telegram callback (chat=${message?.chat?.id}, user=${from?.id})`);
    audit(from || { id: 'unknown' }, 'TELEGRAM_CALLBACK_UNAUTHORIZED', { status: 'failure', category: 'security' });
    await answer((await denialHint(actor)) || 'অনুমতি নেই।', true);
    return;
  }

  const match = CALLBACK_RE.exec(String(query.data || ''));
  if (!match) {
    await answer('অচেনা অ্যাকশন।', true);
    return;
  }
  const [, action, type, rawId] = match;
  const id = Number(rawId);
  await answer('⏳ প্রসেস হচ্ছে…');

  try {
    const current = (await pool.query('SELECT type, status FROM payment_requests WHERE id = $1', [id])).rows[0];
    if (!current || current.type !== type) {
      await finishCallbackMessage(message, `⚠️ রিকোয়েস্ট #${id} পাওয়া যায়নি।`);
      return;
    }

    // অ্যাডমিন প্যানেলের একই ফাংশন: সারি-লক (FOR UPDATE) + pending চেক + ব্যালেন্স/লেজার, এক ট্রানজেকশনে
    const payment = require('../routes/payment');
    const run = action === 'approve' ? payment.approvePaymentRequestById : payment.rejectPaymentRequestById;
    const result = await run(id);

    if (!result.success) {
      if (result.reason === 'not_found_or_processed') {
        const now = (await pool.query('SELECT status FROM payment_requests WHERE id = $1', [id])).rows[0];
        await finishCallbackMessage(message, `ℹ️ রিকোয়েস্ট #${id} আগেই প্রসেস হয়েছে (status: ${now ? now.status : 'unknown'})।`);
      } else {
        // বাটন রেখে দেওয়া হয় যাতে আবার চেষ্টা করা যায়
        await sendTelegramMessage(message.chat.id, `❌ রিকোয়েস্ট #${id} প্রসেস করা যায়নি, কিছুই বদলায়নি। আবার চেষ্টা করুন।`);
      }
      return;
    }

    const status = action === 'approve' ? 'approved' : 'rejected';
    if (result.notification) {
      notify.emitToUser(result.request.user_id, result.notification);
      notify.emitBadgeUpdate(result.request.user_id);
    }
    const details = { requestId: id, userId: result.request.user_id, type, amount: result.request.amount, telegramUserId: String(from.id) };
    audit(from, action === 'approve' ? 'PAYMENT_APPROVED' : 'PAYMENT_REJECTED', { details });
    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action_type, details) VALUES (NULL, $1, $2, $3)`,
      [actorName(from), `${type}_${action}`, `${type} #${id} ${status} via Telegram`]
    ).catch((e) => console.error('telegram admin_logs error:', e.message));

    const who = from.username ? `@${from.username}` : `user ${from.id}`;
    const refund = action === 'reject' && type === 'withdraw' ? ' — টাকা ইউজারকে ফেরত দেওয়া হয়েছে' : '';
    await finishCallbackMessage(message, `${action === 'approve' ? '✅ Approved' : '❌ Rejected'} #${id} (${who})${refund}`);
  } catch (err) {
    console.error('telegram callback error:', err.message);
    await sendTelegramMessage(message.chat.id, `❌ রিকোয়েস্ট #${id}: সার্ভার ত্রুটি। অ্যাডমিন প্যানেলে স্ট্যাটাস যাচাই করুন।`);
  }
}

// ==================== সাপোর্ট রিপ্লাই ====================
/** আমাদের বটের পাঠানো সাপোর্ট নোটিফিকেশনে Reply হলে ইউজার id, নইলে null। */
function parseSupportReplyTarget(replied, botToken) {
  const botId = String(botToken || '').split(':')[0];
  if (!replied || !replied.from || !botId || String(replied.from.id) !== botId) return null;
  const match = SUPPORT_HEADER_RE.exec(String(replied.text || '').split('\n')[0]);
  return match ? Number(match[1]) : null;
}

/** ডাটাবেজে সেভ করে ইউজারকে রিয়েল-টাইমে পাঠায়। */
async function deliverSupportReply(userId, rawText) {
  if (String(rawText).length > MAX_REPLY_LEN) return { ok: false, reason: 'too_long' };
  const text = sanitizeText(rawText, { maxLen: MAX_REPLY_LEN });
  if (!text) return { ok: false, reason: 'empty' };

  const user = (await pool.query(`SELECT id, username, role FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user || user.role === 'admin') return { ok: false, reason: 'user_not_found' };

  const inserted = await pool.query(
    `INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin, is_read, created_at)
     VALUES (NULL, $1, $2, true, false, NOW()) RETURNING id, created_at`,
    [user.id, text]
  );
  await pool.query(`UPDATE chat_messages SET is_read = true WHERE sender_id = $1 AND is_admin = false AND is_read = false`, [user.id]);
  // ইউজারের লাইভ চ্যাট প্যানেল শুধু 'ai' ছাড়া অন্য অবস্থায় দেখা যায় — তাই উত্তর গেলে সবসময় 'connected'
  const connected = await pool.query(
    `UPDATE users SET support_status = 'connected', support_status_updated_at = NOW()
     WHERE id = $1 AND support_status IS DISTINCT FROM 'connected'`,
    [user.id]
  );

  const socket = require('./socket');
  socket.emitSupportReply(user.id, {
    senderId: null, receiverId: user.id, message: text, isAdmin: true,
    fileUrl: null, fileType: null, createdAt: inserted.rows[0].created_at
  });
  socket.notifyUserSeen(user.id);
  if (connected.rowCount) socket.notifySupportStatus(user.id, 'connected');
  await notify.notifyUser(user.id, {
    title: 'সাপোর্ট থেকে নতুন উত্তর', message: text.slice(0, 200), type: 'info', category: 'message'
  });
  return { ok: true, messageId: inserted.rows[0].id, username: user.username };
}

async function replyToUser(msg, userId, text) {
  const chatId = msg.chat.id;
  try {
    const result = await deliverSupportReply(userId, text);
    if (!result.ok) {
      const why = { too_long: `উত্তর ${MAX_REPLY_LEN} অক্ষরের বেশি।`, empty: 'উত্তর খালি।', user_not_found: `ইউজার #${userId} পাওয়া যায়নি।` };
      await sendTelegramMessage(chatId, `❌ পাঠানো যায়নি: ${why[result.reason]}`);
      return;
    }
    audit(msg.from, 'TELEGRAM_SUPPORT_REPLY', {
      category: 'security', riskLevel: 'low', details: { userId, messageId: result.messageId }
    });
    await sendTelegramMessage(chatId, `✅ ${escapeHtml(result.username)} (user_id: ${userId})-কে উত্তর পাঠানো হয়েছে।`);
  } catch (err) {
    console.error('telegram support reply error:', err.message);
    await sendTelegramMessage(chatId, '❌ উত্তর পাঠানো যায়নি (সার্ভার ত্রুটি)। অ্যাডমিন প্যানেল যাচাই করুন।');
  }
}

// ==================== অপেক্ষমাণ রিকোয়েস্ট ====================
async function sendPending(chatId) {
  try {
    const rows = await listPendingPayments();
    if (!rows.length) return sendTelegramMessage(chatId, '✅ কোনো অপেক্ষমাণ ডিপোজিট/উইথড্র নেই।');
    for (const row of rows) {
      const { text, replyMarkup } = buildPaymentMessage(row);
      await sendTelegramMessage(chatId, text, replyMarkup ? { reply_markup: replyMarkup } : {});
    }
    return sendTelegramMessage(chatId, `মোট দেখানো হলো: ${rows.length}টি (একবারে সর্বোচ্চ ১০টি, পুরনোটা আগে)।`);
  } catch (err) {
    console.error('telegram /pending error:', err.message);
    return sendTelegramMessage(chatId, '❌ তালিকা আনা যায়নি।');
  }
}

// ==================== রাউটার ====================
async function processUpdate(update) {
  if (update.callback_query) return handleCallbackQuery(update.callback_query);

  const msg = update.message;
  if (!msg) return undefined;
  if (!(await isAdminActor(msg))) {
    const hint = await denialHint(msg);
    if (hint) await sendTelegramMessage(msg.chat.id, hint);
    // handleMessage অননুমোদিত প্রেরককে শুধু লগ/অডিট করে, কোনো উত্তর দেয় না
    return bot.handleMessage(msg);
  }

  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (/^\/pending(?:@\w+)?$/.test(text)) return sendPending(msg.chat.id);
  if (/^\/reply(?:@\w+)?(?:\s|$)/.test(text)) {
    const cmd = REPLY_CMD_RE.exec(text);
    if (!cmd) return sendTelegramMessage(msg.chat.id, 'ব্যবহার: <code>/reply userId আপনার উত্তর</code>');
    return replyToUser(msg, Number(cmd[1]), cmd[2]);
  }

  const target = msg.reply_to_message ? parseSupportReplyTarget(msg.reply_to_message, await getBotToken()) : null;
  if (target && !text.startsWith('/')) {
    if (!text) return sendTelegramMessage(msg.chat.id, 'শুধু টেক্সট উত্তর পাঠানো যায়।');
    return replyToUser(msg, target, text);
  }

  if (!bot.isAuthorizedSender(msg)) {
    return sendTelegramMessage(msg.chat.id,
      `ℹ️ AI assistant চালু করতে Render-এ TELEGRAM_ADMIN_CHAT_ID=${msg.chat.id} ও TELEGRAM_ADMIN_USER_IDS=${msg.from.id} দুটোই লাগবে।\n/pending ও সাপোর্ট রিপ্লাই কাজ করবে।`);
  }
  return bot.handleMessage(msg);
}

module.exports = { processUpdate, handleCallbackQuery, deliverSupportReply, parseSupportReplyTarget };
