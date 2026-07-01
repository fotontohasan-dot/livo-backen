const Anthropic = require('@anthropic-ai/sdk');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://livo-backen.onrender.com';

const GITHUB_OWNER = 'fotontohasan-dot';
const GITHUB_REPO = 'livo-backen';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const conversations = {};

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
      await telegramAPI('sendMessage', {
        chat_id: chatId,
        text: `✏️ *${filePath}* edit করছি...`,
        parse_mode: 'Markdown'
      });
      const result = await githubEditFile(filePath, newContent, `🤖 Bot: ${filePath} updated via Telegram`);
      if (result.success) {
        await telegramAPI('sendMessage', {
          chat_id: chatId,
          text: `✅ *${filePath}* সফলভাবে update হয়েছে! Render এ deploy হচ্ছে...`,
          parse_mode: 'Markdown'
        });
      } else {
        await telegramAPI('sendMessage', {
          chat_id: chatId,
          text: `❌ Error: ${result.error}`
        });
      }
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
  try {
    await telegramAPI('deleteWebhook', { drop_pending_updates: true });
    const webhookUrl = `${RENDER_URL}/telegram-webhook`;
    const result = await telegramAPI('setWebhook', { url: webhookUrl });
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
module.exports = { handleMessage };
