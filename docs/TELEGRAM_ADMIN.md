# Telegram অ্যাডমিন অপারেশন

## Environment Variables (Render)

| নাম | বিবরণ |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather থেকে পাওয়া টোকেন |
| `TELEGRAM_WEBHOOK_SECRET` | শুধু `A-Z a-z 0-9 _ -` (যেমন `openssl rand -hex 24`) |
| `TELEGRAM_ADMIN_CHAT_ID` | নোটিফিকেশন ও কমান্ডের চ্যাট |
| `TELEGRAM_ADMIN_USER_IDS` | অনুমোদিত numeric user id, কমা দিয়ে |
| `ANTHROPIC_API_KEY` | AI assistant |
| `ANTHROPIC_MODEL` | ঐচ্ছিক |
| `RENDER_EXTERNAL_URL` | Render নিজে সেট করে |

`CHAT_ID` ও `USER_IDS` **দুটোই** মিলতে হয়। প্রাইভেট চ্যাটে দুটোর মান একই।

## Webhook রেজিস্টার

অ্যাপ বুট হলে স্বয়ংক্রিয় হয়। হাতে করতে (Render Shell):

```bash
npm run telegram:webhook            # ${RENDER_EXTERNAL_URL}/api/telegram/webhook + secret_token
npm run telegram:webhook -- --info  # বর্তমান অবস্থা
```

## ব্যবহার

- **ডিপোজিট/উইথড্র:** নোটিফিকেশনের Approve/Reject বাটন চাপুন। উইথড্র Approve করার **আগে** টাকা পাঠান।
- **সাপোর্ট:** `🎫 SUPPORT` মেসেজে Reply দিন, অথবা `/reply <userId> <উত্তর>`।
- **AI:** অন্য যেকোনো মেসেজের উত্তর Claude দেয়।

## জানা দরকার

- রিকোয়েস্ট থাকে `payment_requests` টেবিলে (`type` = deposit/withdraw), সাপোর্ট `chat_messages`-এ। নতুন মাইগ্রেশন লাগে না।
- Admin প্যানেলে (`/admin/telegram`) env থেকে আলাদা bot token বা chat id সেভ করা থাকলে নোটিফিকেশন বাটন ছাড়া যায়।
- অ্যাডমিন তালিকার যে কেউ RBAC ছাড়াই পেমেন্ট অনুমোদন করতে পারে। তাই তালিকা ছোট রাখুন ও Telegram-এ 2FA চালু রাখুন।
- সব অ্যাকশন `audit_logs`-এ `TELEGRAM:<userId>` নামে লেখা হয়।

## ফাইল

| ফাইল | কাজ |
|---|---|
| `routes/telegramWebhook.js` | Webhook, secret যাচাই |
| `services/telegramAdmin.js` | বাটন, সাপোর্ট রিপ্লাই, রাউটিং |
| `services/telegramNotifications.js` | অ্যাডমিন নোটিফিকেশন |
| `services/telegramApi.js` | `sendTelegramMessage` |
| `services/telegramWebhookSetup.js`, `scripts/setTelegramWebhook.js` | Webhook সেটআপ |
| `telegram-bot.js` | Claude AI assistant |
