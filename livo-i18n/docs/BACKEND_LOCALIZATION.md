# Backend Localization — স্কোপ ও বাদ দেওয়া স্ট্রিংয়ের নথি

এই ডকুমেন্টে ব্যাকএন্ড লোকালাইজেশনের সময় কোন স্ট্রিংগুলো i18n-এ আনা হয়েছে এবং
কোনগুলো ইচ্ছাকৃতভাবে বাদ দেওয়া হয়েছে (এবং কেন) তা লিপিবদ্ধ আছে।

## ব্যবহৃত আর্কিটেকচার

নতুন কোনো translation system তৈরি করা হয়নি। বিদ্যমান `locales/bn.json` ও
`locales/en.json` এবং `app.js`-এর ভাষা-মিডলওয়্যারই ব্যবহার হয়েছে।

তিনটি প্যাটার্ন:

| প্রসঙ্গ | প্যাটার্ন |
|---|---|
| রুট হ্যান্ডলারের ভেতরে (`req` আছে) | `req.t('key')` — আগের মতোই |
| module scope / `req` নেই (rate-limiter config) | `tr(req, 'key')` — `utils/i18n` |
| `services/*` (`req` পায় না) | `t(lang, 'key')`, রুট থেকে `req.lang` পাঠানো হয় |

`utils/i18n.js` কোনো আলাদা সিস্টেম নয় — এটা একই দুটো JSON ফাইল পড়ে, শুধু
`req` ছাড়া জায়গাতেও একই অনুবাদ পাওয়ার জন্য পাতলা helper।

ভেরিয়েবলযুক্ত মেসেজে রিপোজিটরির প্রচলিত প্যাটার্নই রাখা হয়েছে:
`req.t('key').replace('{value}', x)`; একাধিক হলে `{value1}`, `{value2}`…

## `services/*`-এ `lang` প্যারামিটার

নিচের ফাংশনগুলো এখন শেষে ঐচ্ছিক `lang = 'bn'` নেয়। ডিফল্ট `'bn'` রাখা হয়েছে
যাতে কোনো কলার বাদ পড়লেও আচরণ আগের মতোই থাকে (ফেল-সেফ, নীরব ভাঙন নয়):

`wheel.spin`, `wheel.getTodayResult`, `missions.claimMission`,
`cashback.claimCashback`, `dailyReward.claimDailyReward`,
`periodicReward.claimWeekly`, `periodicReward.claimMonthly`,
`loyalty.redeemPoints`, `freebet.claimFreeBet`, `redpacket.claimRedPacket`,
`redpacket.claimGoldenEgg`, `social.claimShare`,
`accumulator.placeAccumulator`, `adminGames.validateGame`

`routes/profile.js` ও `routes/accumulator.js`-এর ১৩টি কল-সাইটেই `req.lang` পাঠানো হয়।

## rate-limiter সংক্রান্ত সংশোধন

`rateLimit({ message: ... })` module scope-এ মূল্যায়িত হয়, ওখানে `req` থাকে না।
তাই সব limiter-এ `message` এখন ফাংশন: `(req) => tr(req, 'key')`।

সেই সঙ্গে `middleware/rateLimitFactory.js`-এ একটা বাগ ধরা পড়েছে ও সারানো হয়েছে —
`message` ফাংশন হলে আগে সেটা রিজলভ না করেই সরাসরি `res.send()`-এ যেত, ফলে 429-এর
বদলে 500 আসত (`tests/security/kyc.test.js` এটাই ধরেছিল)।

## ইচ্ছাকৃতভাবে বাদ দেওয়া (documented exclusions)

### ১. অডিট লগ — `logAdminAction()` / `logAudit()` / `audit(req, { details })`

এগুলো `admin_logs` / `audit_logs` টেবিলে persist হয়। লেখার সময় অনুবাদ করলে যে
অ্যাডমিন অ্যাকশনটা নিয়েছে তার সেশন-ভাষায় রেকর্ড জমা হতো, ফলে একই টেবিলে বাংলা ও
ইংরেজি রেকর্ড মিশে যেত এবং পুরোনো রেকর্ডের সঙ্গে অসঙ্গত হতো। এগুলো ইউজারকে
দেখানো হয় না।

### ২. `INSERT INTO notifications` — persist হওয়া নোটিফিকেশন বডি

নোটিফিকেশনের টেক্সট ডেটাবেসে জমা হয় এবং পরে প্রাপক পড়ে। লেখার সময় প্রাপকের ভাষা
জানা যায় না — `users` টেবিলে `lang` কলাম নেই (`lang` শুধু সেশনে থাকে)। সঠিক
সমাধানে হয় schema পরিবর্তন (per-user `lang`) নয়তো key + params আকারে সংরক্ষণ
দরকার, যা টাস্কের "database queries / behavior অপরিবর্তিত রাখো" শর্তের বাইরে।

প্রভাবিত: ডিপোজিট/উইথড্র বাতিলের নোটিফিকেশন বডি, ব্রডকাস্ট বডি।

### ৩. অপারেটর/ডেভেলপার-মুখী আউটপুট

| ফাইল | কারণ |
|---|---|
| `telegram-bot.js` | অ্যাডমিন-অপারেটর বট, বাংলা-only অভ্যন্তরীণ টুল |
| `services/envValidator.js` | সার্ভার স্টার্টআপ কনসোল আউটপুট |
| `services/swagger.js` | API ডকুমেন্টেশন description |
| `services/backup.js`, `services/backupManager.js` | throw করা internal error, অ্যাডমিনের কাছে generic মেসেজ হিসেবে যায় |
| `services/sms.js`, `services/sslcommerz.js`, `services/googleAuth.js`, `services/telegramConfig.js` | internal log / throw, ইউজার-ফেসিং নয় |
| `services/botDetection.js`, `services/deviceTracking.js` | internal flag reason ও অ্যাডমিন Telegram নোটিফিকেশন |
| `queues/*` | ব্যাকগ্রাউন্ড জব internal error |
| `app.js` ADMIN_RESET রুট | one-off রিকভারি রুট, plain-text অপারেটর আউটপুট |
| `services/chatbot.js` system prompt | LLM-কে দেওয়া নির্দেশ, ইউজার দেখে না (fallback মেসেজটি লোকালাইজ করা হয়েছে) |
| `migrations.js`, `services/scheduler.js`, `services/metrics.js`, `services/cache.js` | startup/ops লগ |
| `services/contentFilter.js` | ফিল্টার শব্দতালিকা — অনুবাদ করলে ফিল্টারই ভেঙে যেত |

### ৪. EJS টেমপ্লেট

`scripts/i18n-scan.js` এখনও `views/**` -এ ~৮০০ হার্ডকোড বাংলা স্ট্রিং দেখায়।
এই কাজের স্কোপ ছিল **ব্যাকএন্ড** (`req.flash`, `res.json`, `res.send`,
validation/error, service message)। টেমপ্লেট লেয়ার আলাদা কাজ।

## রিগ্রেশন গার্ড

`tests/render/backendLocalizationIntegrity.test.js` (৬৬টি টেস্ট):

- লোকালাইজ করা ৩৪টি ব্যাকএন্ড ফাইলে নতুন হার্ডকোড বাংলা ইউজার-ফেসিং লিটারেল ঢুকলে ফেল
- `bn.json` / `en.json` key parity, খালি মান, `en.json`-এ বাংলা লিকেজ
- দুই ভাষায় `{valueN}` placeholder সেট এক কি না, locale মানে কাঁচা `${...}` আছে কি না
- `utils/i18n`-এর `t` / `tr` / `langOf` আচরণ, অজানা key ও অজানা ভাষার ফলব্যাক
- service ফাংশনগুলো `lang` নেয় কি না এবং রুট `req.lang` পাঠায় কি না
- limiter কনফিগে বেয়ার `req.t(...)` ফিরে এলে ফেল (module scope-এ `req` নেই)
