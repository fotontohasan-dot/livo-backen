const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Initialize clients
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Store conversation history per user
const conversations = {};

// System prompt for Livo assistant
const SYSTEM_PROMPT = `তুমি Livo-র AI Assistant। Livo একটি অনলাইন গেমিং প্ল্যাটফর্ম। 
তুমি বাংলায় কথা বলবে এবং Livo-র admin Mahmud-কে সাহায্য করবে।
তুমি করতে পারবে:
- Livo-র কোড সম্পর্কে সাহায্য করা
- Bug fix করতে সাহায্য করা  
- নতুন feature এর পরামর্শ দেওয়া
- যেকোনো প্রশ্নের উত্তর দেওয়া
সবসময় বাংলায় উত্তর দাও।`;

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  bot.sendMessage(chatId, 
    '🎮 *Livo AI Assistant*\n\nআমি তোমার Livo প্ল্যাটফর্মের AI Assistant!\n\nযেকোনো প্রশ্ন করো, আমি সাহায্য করবো। 😊\n\n/clear - কথোপকথন মুছে ফেলো',
    { parse_mode: 'Markdown' }
  );
});

// /clear command
bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  conversations[chatId] = [];
  bot.sendMessage(chatId, '✅ কথোপকথন মুছে ফেলা হয়েছে!');
});

// Handle all messages
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  // Skip commands
  if (!userMessage || userMessage.startsWith('/')) return;

  // Initialize conversation history
  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  // Send typing indicator
  bot.sendChatAction(chatId, 'typing');

  try {
    // Add user message to history
    conversations[chatId].push({
      role: 'user',
      content: userMessage
    });

    // Keep only last 10 messages to save tokens
    if (conversations[chatId].length > 10) {
      conversations[chatId] = conversations[chatId].slice(-10);
    }

    // Call Anthropic API
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: conversations[chatId]
    });

    const assistantMessage = response.content[0].text;

    // Add assistant response to history
    conversations[chatId].push({
      role: 'assistant',
      content: assistantMessage
    });

    // Send response to Telegram
    await bot.sendMessage(chatId, assistantMessage, { parse_mode: 'Markdown' });

  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, '❌ সমস্যা হয়েছে, আবার চেষ্টা করো।');
  }
});

console.log('🤖 Livo Telegram Bot চালু হয়েছে!');
