// services/telegramAccess.js
// পেমেন্ট বাটন, সাপোর্ট রিপ্লাই ও /pending কে ব্যবহার করতে পারবে।
//   • প্রাইভেট চ্যাট (chat id == user id): user id TELEGRAM_ADMIN_USER_IDS-এ থাকলে, অথবা সেটা অ্যাডমিন চ্যাট হলে
//   • গ্রুপ: অ্যাডমিন চ্যাট হতে হবে *এবং* user id TELEGRAM_ADMIN_USER_IDS-এ থাকতে হবে
// অ্যাডমিন চ্যাট = TELEGRAM_ADMIN_CHAT_ID (না থাকলে TELEGRAM_CHAT_ID)। env-এ কোনো id-ই না থাকলে
// তবেই Admin প্যানেলের chat id ধরা হয় — নইলে সেটিংস-অনুমতি দিয়ে পেমেন্ট অনুমোদনের ক্ষমতা নেওয়া যেত।
// (GitHub-এ লিখতে পারা AI assistant আলাদা ও কড়া নিয়মে চলে: telegram-bot.js isAuthorizedSender)
const telegramConfig = require('./telegramConfig');

// Render-এ মান বসাতে গিয়ে স্পেস বা কোট চলে এলে id মিলত না
const clean = (v) => String(v == null ? '' : v).replace(/["'\s]/g, '');

function envUserIds() {
  return new Set(String(process.env.TELEGRAM_ADMIN_USER_IDS || '').split(/[,;]/).map(clean).filter(Boolean));
}

async function isAdminActor({ chat, from } = {}) {
  if (!chat || !from || chat.id == null || from.id == null || from.is_bot) return false;
  const chatId = String(chat.id);
  const fromId = String(from.id);
  const users = envUserIds();
  let adminChat = clean(process.env.TELEGRAM_ADMIN_CHAT_ID) || clean(process.env.TELEGRAM_CHAT_ID);
  if (!adminChat && !users.size) adminChat = clean((await telegramConfig.getConfig()).chatId);

  if (chatId === fromId) return users.has(fromId) || fromId === adminChat;
  return !!adminChat && chatId === adminChat && users.has(fromId);
}

/** নোটিফিকেশন যে চ্যাটে যায়, শুধু সেখানেই অনুমতি না থাকার কারণ জানানো হয়; অন্যত্র বট চুপ থাকে। */
async function denialHint({ chat, from } = {}) {
  if (!chat || !from) return null;
  const config = await telegramConfig.getConfig();
  if (!config.chatId || String(chat.id) !== clean(config.chatId)) return null;
  return `⛔ অনুমতি নেই। Render-এ TELEGRAM_ADMIN_USER_IDS=${from.id} বসিয়ে redeploy দিন।`;
}

module.exports = { isAdminActor, denialHint };
