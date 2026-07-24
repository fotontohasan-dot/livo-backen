const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://livo-backen.onrender.com';

// ==================== নিরাপত্তা: Webhook যাচাইকরণ ====================
// Telegram প্রতিটি webhook request-এ এই secret token header হিসেবে পাঠাবে
// (setWebhook কল করার সময় এই একই token Telegram-কে জানিয়ে দেওয়া হয়)।
// header না থাকলে/না মিললে বুঝতে হবে request Telegram থেকে আসেনি।
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || null;
if (!WEBHOOK_SECRET) {
  console.warn('⚠️ TELEGRAM_WEBHOOK_SECRET সেট করা নেই — নিরাপত্তার জন্য বট কোনো webhook request গ্রহণ করবে না (fail-closed)। .env-এ TELEGRAM_WEBHOOK_SECRET সেট করুন (যেমন: openssl rand -hex 24)।');
}

// শুধুমাত্র এই chat ID থেকে আসা মেসেজ প্রসেস হবে (admin/Mahmud-এর Telegram chat id)।
// সেট না থাকলে বট fail-closed থাকবে — GitHub-writable AI bot কখনো সবার জন্য খোলা রাখা উচিত না।
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
if (!ADMIN_CHAT_ID) {
  console.warn('⚠️ TELEGRAM_ADMIN_CHAT_ID সেট করা নেই — নিরাপত্তার জন্য বট আপাতত কোনো মেসেজ প্রসেস করবে না। .env-এ আপনার Telegram chat id সেট করুন।');
}

function verifyWebhookSecret(headerValue) {
  if (!WEBHOOK_SECRET) return false; // secret সেট না থাকলে কোনো request-ই গ্রহণযোগ্য না
  if (!headerValue) return false;
  const a = Buffer.from(String(headerValue));
  const b = Buffer.from(WEBHOOK_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const GITHUB_OWNER = 'fotontohasan-dot';
const GITHUB_REPO = 'livo-backen';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const conversations = {};

// GitHub-এ commit করার আগে admin-এর explicit "হ্যাঁ" লাগবে — ভুল/দুর্ঘটনাক্রমে
// deploy হয়ে যাওয়া ঠেকাতে। chatId ধরে pending action রাখা হয়, ৫ মিনিট পর মেয়াদ শেষ।
const pendingActions = {};
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

const SYSTEM_PROMPT = `তুমি Livo-র AI Assistant। Livo একটি অনলাইন গেমিং প্ল্যাটফর্ম Node.js/Express দিয়ে তৈরি।
তুমি বাংলায় কথা বলবে এবং Livo-র admin Mahmud-কে সাহায্য করবে।

তুমি করতে পারবে:
- Livo-র কোড সম্পর্কে সাহায্য করা
- Bug fix করতে সাহায্য করা
- নতুন feature এর পরামর্শ দেওয়া
- GitHub repository থেকে ফাইল দেখা ও edit করা

যখন কেউ কোনো ফাইল edit করতে বলবে, তখন এই format এ respond করো:
GITHUB_ACTION: edit_file
FILE: ফাইলের নাম (যেমন: app.js)
CONTENT: সম্পূর্ণ নতুন কোড এখানে

যখন কেউ কোনো ফাইল দেখতে চাইবে:
GITHUB_ACTION: read_file
FILE: ফাইলের নাম

সবসময় বাংলায় উত্তর দাও।`;

// Telegram API helper
async function telegramAPI(method, data) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return response.json();
}

// GitHub: ফাইল পড়া
async function githubReadFile(filePath) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });
  const data = await response.json();
  if (data.content) {
    return {
      content: Buffer.from(data.content, 'base64').toString('utf8'),
      sha: data.sha
    };
  }
  return null;
}

// GitHub: ফাইল edit করা
async function githubEditFile(filePath, newContent, commitMessage) {
  // আগে SHA নিতে হবে
  const existing = await githubReadFile(filePath);
  if (!existing) return { success: false, error: 'ফাইল পাওয়া যায়নি' };

  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: commitMessage || `🤖 Bot: ${filePath} updated`,
      content: Buffer.from(newContent).toString('base64'),
      sha: existing.sha
    })
  });
  const result = await response.json();
  return result.commit ? { success: true } : { success: false, error: JSON.stringify(result) };
}

// GitHub action process করা
async function processGithubAction(responseText, chatId) {
  if (responseText.includes('GITHUB_ACTION: read_file')) {
    const fileMatch = responseText.match(/FILE: (.+)/);
    if (fileMatch) {
      const filePath = fileMatch[1].trim();
      await telegramAPI('sendMessage', {
        chat_id: chatId,
        text: `📂 *${filePath}* পড়ছি...`,
        parse_mode: 'Markdown'
      });
      const file = await githubReadFile(filePath);
      if (file) {
        const preview = file.content.substring(0, 1000);
        await telegramAPI('sendMessage', {
          chat_id: chatId,
          text: `📄 *${filePath}* (প্রথম ১০০০ অক্ষর):\n\`\`\`\n${preview}\n\`\`\``,
          parse_mode: 'Markdown'
        });
      } else {
        await telegramAPI('sendMessage', {
          chat_id: chatId,
          text: `❌ ফাইল পাওয়া যায়নি: ${filePath}`
        });
      }
    }
  } else if (responseText.includes('GITHUB_ACTION: edit_file')) {
    const fileMatch = responseText.match(/FILE: (.+)/);
    const contentMatch = responseText.match(/CONTENT: ([\s\S]+)/);
    if (fileMatch && contentMatch) {
      const filePath = fileMatch[1].trim();
      const newContent = contentMatch[1].trim();

      // সরাসরি commit না করে, আগে admin-কে দেখিয়ে "হ্যাঁ" চাওয়া হচ্ছে।
      pendingActions[chatId] = {
        filePath,
        newContent,
        expiresAt: Date.now() + CONFIRM_TIMEOUT_MS
      };

      const preview = newContent.length > 800 ? newContent.slice(0, 800) + '\n...(আরও আছে)' : newContent;
      await telegramAPI('sendMessage', {
        chat_id: chatId,
        text: `⚠️ *${filePath}* ফাইলটা এভাবে বদলাতে চাইছি:\n\`\`\`\n${preview}\n\`\`\`\n\nএটা সরাসরি GitHub-এ commit হয়ে যাবে এবং সাথে সাথে deploy শুরু হবে।\n\n✅ নিশ্চিত হলে লেখো: *হ্যাঁ*\n❌ বাতিল করতে লেখো: *না*\n\n(৫ মিনিটের মধ্যে সাড়া না দিলে এই অনুরোধ আপনা থেকেই বাতিল হয়ে যাবে)`,
        parse_mode: 'Markdown'
      });
    }
  } else {
    // Normal message
    await telegramAPI('sendMessage', {
      chat_id: chatId,
      text: responseText,
      parse_mode: 'Markdown'
    });
  }
}

// Webhook set
async function setWebhook() {
  if (!WEBHOOK_SECRET) {
    console.warn('⚠️ TELEGRAM_WEBHOOK_SECRET নেই — webhook রেজিস্টার করা হচ্ছে না, বট নিষ্ক্রিয় থাকবে।');
    return;
  }
  try {
    await telegramAPI('deleteWebhook', { drop_pending_updates: true });
    const webhookUrl = `${RENDER_URL}/telegram-webhook`;
    // secret_token পাঠানো হচ্ছে — Telegram এখন থেকে প্রতিটি request-এ
    // X-Telegram-Bot-Api-Secret-Token header-এ এই মানটা পাঠাবে, যা app.js যাচাই করবে।
    const result = await telegramAPI('setWebhook', { url: webhookUrl, secret_token: WEBHOOK_SECRET });
    console.log('🔗 Telegram Webhook set:', result.description);
  } catch (err) {
    console.error('⚠️ Telegram webhook setup skipped (network issue):', err.message);
  }
}

// Message handle করা
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage) return;

  // নিরাপত্তা: শুধু admin-এর chat থেকে আসা মেসেজ প্রসেস হবে।
  // এই বট GitHub repo-তে সরাসরি write করতে পারে, তাই অন্য কারো মেসেজে সাড়া
  // দেওয়া মানেই যে কেউ (বট খুঁজে পেলে) কোড এডিট করার সুযোগ পাওয়া।
  if (!ADMIN_CHAT_ID || String(chatId) !== String(ADMIN_CHAT_ID)) {
    console.warn(`⚠️ অননুমোদিত Telegram chat (${chatId}) থেকে মেসেজ এলো — উপেক্ষা করা হলো।`);
    return;
  }

  if (userMessage === '/start') {
    conversations[chatId] = [];
    await telegramAPI('sendMessage', {
      chat_id: chatId,
      text: '🎮 *Livo AI Assistant*\n\nআমি তোমার Livo প্ল্যাটফর্মের AI Assistant!\n\nআমি এখন GitHub থেকে ফাইল পড়তে ও edit করতে পারি! 🔥\n\nউদাহরণ:\n• "app.js দেখাও"\n• "telegram-bot.js এ নতুন feature যোগ করো"\n\n/clear - কথোপকথন মুছো',
      parse_mode: 'Markdown'
    });
    return;
  }

  if (userMessage === '/clear') {
    conversations[chatId] = [];
    await telegramAPI('sendMessage', { chat_id: chatId, text: '✅ কথোপকথন মুছে ফেলা হয়েছে!' });
    return;
  }

  // pending GitHub edit-এর জবাব (হ্যাঁ/না) এখানেই সামলানো হয়, AI-কে ডাকার প্রয়োজন নেই
  const pending = pendingActions[chatId];
  if (pending) {
    if (Date.now() > pending.expiresAt) {
      delete pendingActions[chatId];
    } else {
      const normalized = userMessage.trim().toLowerCase();
      const isYes = ['হ্যাঁ', 'হা', 'yes', 'y', 'confirm'].includes(normalized);
      const isNo = ['না', 'no', 'n', 'cancel'].includes(normalized);

      if (isYes) {
        delete pendingActions[chatId];
        await telegramAPI('sendMessage', {
          chat_id: chatId,
          text: `✏️ *${pending.filePath}* commit করছি...`,
          parse_mode: 'Markdown'
        });
        const result = await githubEditFile(pending.filePath, pending.newContent, `🤖 Bot: ${pending.filePath} updated via Telegram (admin confirmed)`);
        if (result.success) {
          await telegramAPI('sendMessage', {
            chat_id: chatId,
            text: `✅ *${pending.filePath}* সফলভাবে update হয়েছে! Render এ deploy হচ্ছে...`,
            parse_mode: 'Markdown'
          });
        } else {
          await telegramAPI('sendMessage', { chat_id: chatId, text: `❌ Error: ${result.error}` });
        }
        return;
      }
      if (isNo) {
        delete pendingActions[chatId];
        await telegramAPI('sendMessage', { chat_id: chatId, text: '🚫 বাতিল করা হলো, কোনো পরিবর্তন হয়নি।' });
        return;
      }
      // অস্পষ্ট জবাব — pending অনুরোধটা মনে করিয়ে দেওয়া হচ্ছে, AI-কে ডাকা হচ্ছে না
      await telegramAPI('sendMessage', {
        chat_id: chatId,
        text: `⏳ *${pending.filePath}*-এর পরিবর্তন এখনো নিশ্চিত হয়নি। "হ্যাঁ" বা "না" লেখো।`,
        parse_mode: 'Markdown'
      });
      return;
    }
  }

  if (!conversations[chatId]) conversations[chatId] = [];

  await telegramAPI('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    conversations[chatId].push({ role: 'user', content: userMessage });

    if (conversations[chatId].length > 10) {
      conversations[chatId] = conversations[chatId].slice(-10);
    }

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId]
    });

    const assistantMessage = response.content[0].text;
    conversations[chatId].push({ role: 'assistant', content: assistantMessage });

    await processGithubAction(assistantMessage, chatId);

  } catch (error) {
    console.error('Error:', error);
    await telegramAPI('sendMessage', {
      chat_id: chatId,
      text: '❌ সমস্যা হয়েছে, আবার চেষ্টা করো।'
    });
  }
}

setWebhook();
module.exports = { handleMessage, verifyWebhookSecret };
