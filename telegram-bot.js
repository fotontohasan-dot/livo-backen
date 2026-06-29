const Anthropic = require('@anthropic-ai/sdk');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://livo-backen.onrender.com';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const conversations = {};

const SYSTEM_PROMPT = `তুমি Livo-র AI Assistant। Livo একটি অনলাইন গেমিং প্ল্যাটফর্ম।
তুমি বাংলায় কথা বলবে এবং Livo-র admin Mahmud-কে সাহায্য করবে।
তুমি করতে পারবে:
- Livo-র কোড সম্পর্কে সাহায্য করা
- Bug fix করতে সাহায্য করা
- নতুন feature এর পরামর্শ দেওয়া
- যেকোনো প্রশ্নের উত্তর দেওয়া
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

// Set webhook on startup
async function setWebhook() {
  // First delete any old webhook/polling
  await telegramAPI('deleteWebhook', { drop_pending_updates: true });
  
  const webhookUrl = `${RENDER_URL}/telegram-webhook`;
  const result = await telegramAPI('setWebhook', { url: webhookUrl });
  console.log('🔗 Telegram Webhook set:', result.description);
}

// Handle incoming message
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage) return;

  if (userMessage === '/start') {
    conversations[chatId] = [];
    await telegramAPI('sendMessage', {
      chat_id: chatId,
      text: '🎮 *Livo AI Assistant*\n\nআমি তোমার Livo প্ল্যাটফর্মের AI Assistant!\n\nযেকোনো প্রশ্ন করো, আমি সাহায্য করবো। 😊\n\n/clear - কথোপকথন মুছে ফেলো',
      parse_mode: 'Markdown'
    });
    return;
  }

  if (userMessage === '/clear') {
    conversations[chatId] = [];
    await telegramAPI('sendMessage', {
      chat_id: chatId,
      text: '✅ কথোপকথন মুছে ফেলা হয়েছে!'
    });
    return;
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
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId]
    });

    const assistantMessage = response.content[0].text;
    conversations[chatId].push({ role: 'assistant', content: assistantMessage });

    await telegramAPI('sendMessage', {
      chat_id: chatId,
      text: assistantMessage,
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Claude API Error:', error);
    await telegramAPI('sendMessage', {
      chat_id: chatId,
      text: '❌ সমস্যা হয়েছে, আবার চেষ্টা করো।'
    });
  }
}

setWebhook();
module.exports = { handleMessage };
