// services/telegramWebhookSetup.js
// ${RENDER_EXTERNAL_URL}/api/telegram/webhook + secret_token Telegram-এ রেজিস্টার করে।
const { telegramRequest } = require('./telegramApi');

const WEBHOOK_PATH = '/api/telegram/webhook';

async function registerWebhook() {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  const base = String(process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (!process.env.TELEGRAM_BOT_TOKEN) return { ok: false, description: 'TELEGRAM_BOT_TOKEN সেট করা নেই' };
  // Telegram শুধু A-Z a-z 0-9 _ - গ্রহণ করে
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    return { ok: false, description: 'TELEGRAM_WEBHOOK_SECRET নেই বা অবৈধ (শুধু A-Z, a-z, 0-9, _, -)' };
  }
  if (!base.startsWith('https://')) return { ok: false, description: 'RENDER_EXTERNAL_URL (https://...) সেট করা নেই' };

  const url = `${base}${WEBHOOK_PATH}`;
  const result = await telegramRequest('setWebhook', {
    url, secret_token: secret, allowed_updates: ['message', 'callback_query']
  });
  return { ...result, url };
}

module.exports = { registerWebhook, WEBHOOK_PATH };
