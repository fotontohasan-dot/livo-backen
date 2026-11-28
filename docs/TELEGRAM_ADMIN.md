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

### কে কী করতে পারে

| চ্যাট | পেমেন্ট বাটন, সাপোর্ট রিপ্লাই, `/pending` | AI assistant (GitHub অ্যাক্সেসসহ) |
|---|---|---|
| প্রাইভেট | অ্যাডমিন চ্যাট, **অথবা** `USER_IDS`-এ থাকা user | `CHAT_ID` ও `USER_IDS` দুটোই |
| গ্রুপ | অ্যাডমিন চ্যাট **এবং** `USER_IDS` | `CHAT_ID` ও `USER_IDS` দুটোই |

অ্যাডমিন চ্যাট = `TELEGRAM_ADMIN_CHAT_ID` (না থাকলে `TELEGRAM_CHAT_ID`)। env-এ কোনো id না থাকলে তবেই Admin প্যানেলের chat id ধরা হয়।

## Webhook রেজিস্টার

অ্যাপ বুট হলে স্বয়ংক্রিয় হয়। হাতে করতে (Render Shell):

```bash
npm run telegram:webhook            # ${RENDER_EXTERNAL_URL}/api/telegram/webhook + secret_token
npm run telegram:webhook -- --info  # বর্তমান অবস্থা
```

## ব্যবহার

- **ডিপোজিট/উইথড্র:** নোটিফিকেশনের Approve/Reject বাটন চাপুন। উইথড্র Approve করার **আগে** টাকা পাঠান।
- **সাপোর্ট:** `🎫 SUPPORT` মেসেজে Reply দিন, অথবা `/reply <userId> <উত্তর>`।
- **অপেক্ষমাণ তালিকা:** `/pending` লিখলে বাটনসহ আসে।
- **AI:** অন্য যেকোনো মেসেজের উত্তর Claude দেয়।

## জানা দরকার

- রিকোয়েস্ট থাকে `payment_requests` টেবিলে (`type` = deposit/withdraw), সাপোর্ট `chat_messages`-এ। নতুন মাইগ্রেশন লাগে না।
- Admin প্যানেলে (`/admin/telegram`) সেভ করা bot token থাকলে সেটাই ব্যবহার হয় (webhook-ও ওই বটে বসে)।
- বাটন বন্ধ থাকার কারণ (যেমন অবৈধ webhook secret) নোটিফিকেশনেই লেখা থাকে।
- অ্যাডমিন তালিকার যে কেউ RBAC ছাড়াই পেমেন্ট অনুমোদন করতে পারে। তাই তালিকা ছোট রাখুন ও Telegram-এ 2FA চালু রাখুন।
- সব অ্যাকশন `audit_logs`-এ `TELEGRAM:<userId>` নামে লেখা হয়।

## ফাইল

| ফাইল | কাজ |
|---|---|
| `routes/telegramWebhook.js` | Webhook, secret যাচাই |
| `services/telegramAdmin.js` | বাটন, সাপোর্ট রিপ্লাই, রাউটিং |
| `services/telegramNotifications.js` | অ্যাডমিন নোটিফিকেশন |
| `services/telegramAccess.js` | অনুমোদনের নিয়ম |
| `services/telegramApi.js` | `sendTelegramMessage` |
| `services/telegramWebhookSetup.js`, `scripts/setTelegramWebhook.js` | Webhook সেটআপ |
| `telegram-bot.js` | Claude AI assistant |

## লাইভ চ্যাট মেনু ও রিপোর্ট ফর্ম

- `/chat`-এ আগে ক্যাটাগরি মেনু আসে; সব অপশন লাইভ এজেন্টের কাছে যায় (ওয়েবসাইট চ্যাটে কোনো AI নেই)।
- জমা/উত্তোলন সমস্যায় ফর্ম: প্রেরকের নম্বর, রিসিভার নম্বর, ট্রানজ্যাকশন আইডি, সময় (বাংলাদেশ সময়)। উত্তোলনে প্রেরকের নম্বর ও ট্রানজ্যাকশন আইডি ঐচ্ছিক। ক্যাটাগরি ও বাধ্যতামূলক ঘর: `services/supportReports.js`।
- তথ্য `support_reports` টেবিল ও চ্যাট হিস্ট্রিতে জমা হয়, তারপর Telegram-এ যায়; নোটিফিকেশনে Reply দিলে ইউজার ওয়েবসাইটে উত্তর পান।
- ফর্ম/মেনু রিকোয়েস্টের সীমা: ইউজারপ্রতি ১০ মিনিটে ১০টি।

