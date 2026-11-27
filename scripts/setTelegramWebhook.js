// ব্যবহার:
//   npm run telegram:webhook            → webhook রেজিস্টার
//   npm run telegram:webhook -- --info  → বর্তমান অবস্থা দেখা
require('dotenv').config();
const { registerWebhook } = require('../services/telegramWebhookSetup');
const { telegramRequest } = require('../services/telegramApi');

(async () => {
  const info = process.argv.includes('--info');
  const result = info ? await telegramRequest('getWebhookInfo') : await registerWebhook();
  if (!result.ok) {
    console.error('❌', result.description);
    process.exit(1);
  }
  console.log(info ? result.result : `✅ Webhook রেজিস্টার হয়েছে: ${result.url}`);
  process.exit(0);
})();
