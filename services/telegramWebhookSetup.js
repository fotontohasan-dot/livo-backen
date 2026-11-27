// services/telegramWebhookSetup.js
// ${RENDER_EXTERNAL_URL}/api/telegram/webhook + secret_token Telegram-এ রেজিস্টার করে।
const { telegramRequest, getBotToken } = require('./telegramApi');

const WEBHOOK_PATH = '/api/telegram/webhook';

let lastFailure = null;

const secretValue = () => process.env.TELEGRAM_WEBHOOK_SECRET || '';
const baseUrl = () => String(process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');

/** env-এর যে ভুলে webhook কাজই করতে পারে না; সব ঠিক থাকলে null। */
function configProblem() {
  // Telegram শুধু A-Z a-z 0-9 _ - গ্রহণ করে
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secretValue())) {
    return 'TELEGRAM_WEBHOOK_SECRET নেই বা অবৈধ (শুধু A-Z, a-z, 0-9, _, -)';
  }
  return null;
}

const webhookRegistrationFailure = () => lastFailure;

async function registerWebhook() {
  const fail = (description) => { lastFailure = description; return { ok: false, description }; };
  if (!(await getBotToken())) return fail('TELEGRAM_BOT_TOKEN সেট করা নেই');
  if (configProblem()) return fail(configProblem());
  if (!baseUrl().startsWith('https://')) return fail('RENDER_EXTERNAL_URL (https://...) সেট করা নেই');

  const url = `${baseUrl()}${WEBHOOK_PATH}`;
  const result = await telegramRequest('setWebhook', {
    url, secret_token: secretValue(), allowed_updates: ['message', 'callback_query']
  });
  lastFailure = result.ok ? null : result.description;
  return { ...result, url };
}

module.exports = { registerWebhook, configProblem, webhookRegistrationFailure, WEBHOOK_PATH };
