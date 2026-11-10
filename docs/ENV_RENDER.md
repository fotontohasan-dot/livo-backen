# Render এনভায়রনমেন্ট ভেরিয়েবল (livo-web + livo-worker)

`render.yaml` দুটো সার্ভিসেই `livo-shared` Environment Group সংযুক্ত করে। **গ্রুপের ভেতরের মান এই রিপোতে নেই** —
মালিক Render ড্যাশবোর্ডে (Environment Groups → `livo-shared`) বসাবেন। গ্রুপটা `render.yaml`-এ ইচ্ছাকৃতভাবে
খালি: Blueprint গ্রুপে `sync: false` সমর্থন করে না, আর ফাঁকা `""` দিলে পরের sync-এ ড্যাশবোর্ডের মান মুছে
যাওয়ার ঝুঁকি থাকে।

## ⚠️ SESSION_SECRET ও এনক্রিপশন কী — বদলানো যাবে না

`utils/secretBox.js` (2FA/TOTP সিক্রেট) কী বেছে নেয় এই ক্রমে:
`SETTINGS_ENCRYPTION_KEY` → `TELEGRAM_SETTINGS_KEY` → `BACKUP_ENCRYPTION_KEY` → **`SESSION_SECRET`**।
`services/telegramConfig.js`-এও একই ধরনের ফলব্যাক চেইন আছে।

অর্থাৎ production-এ উপরের তিনটা না থাকলে DB-তে এনক্রিপ্ট করা সিক্রেটের কী = বর্তমান `SESSION_SECRET`।

- production-এর বর্তমান `SESSION_SECRET` **বদলাবেন না** — বদলালে আগের এনক্রিপ্ট করা ডেটা ডিক্রিপ্ট হবে না।
- worker-এ **হুবহু একই** মান লাগবে (গ্রুপ ব্যবহারের কারণ এটাই)।
- আগে থেকে সেট না থাকলে `SETTINGS_ENCRYPTION_KEY`-এ **নতুন** মান বসাবেন না; বসালে চেইনের শীর্ষে উঠে
  সব পুরনো ডেটা ডিক্রিপশন ভাঙবে। বসাতে হলে মান = বর্তমান `SESSION_SECRET`।
- পুরনো `SESSION_SECRET` Web-এর `generateValue` থেকে এসেছিল; `render.yaml` থেকে সেটা সরানো হয়েছে।
  generateValue শুধু সার্ভিস তৈরির সময় চলে, তাই চালু সার্ভিসের মান অপরিবর্তিত থাকে —
  তবু গ্রুপে বসানোর আগে ড্যাশবোর্ড থেকে বর্তমান মান কপি করে নিন।

## `livo-shared` গ্রুপে যা বসাবেন (web ও worker দুজনেই পড়ে)

| ভেরিয়েবল | বিবরণ |
|---|---|
| `SESSION_SECRET` | সেশন সাইনিং + এনক্রিপশন ফলব্যাক কী। উপরের সতর্কতা দেখুন। |
| `SETTINGS_ENCRYPTION_KEY` | ঐচ্ছিক; উপরের নিয়ম মানতে হবে। |
| `PUBLIC_APP_URL` | সাইটের পাবলিক URL, production-এ অবশ্যই `https://…` (ইমেইল লিংক/টিকেট verify URL)। |
| `CANONICAL_HOST` | মূল হোস্টনেম (রিডাইরেক্ট/হোস্ট যাচাই)। |
| `RAPIDAPI_KEY`, `CRICKET_API_KEY` | স্পোর্টস ফিড (worker-এর matchSync)। |
| `CASINO_PROVIDERS` | সক্রিয় ক্যাসিনো প্রোভাইডারের তালিকা (worker-এর casinoBootSync)। |
| `PROVIDER_<NAME>_*` | প্রতিটা প্রোভাইডারের `API_URL`, `AGENT_ID`, `SECRET`, `IPS`, `CURRENCY`, `BDT_RATE` (যেমন `PROVIDER_DB_GAMES_*`)। নাম ডাইনামিক — `services/casinoProviders/*`। |
| `WALLET_CALLBACK_<WALLET>_SECRET` / `_PUBLIC_KEY` / `_IPS` | ওয়ালেট callback যাচাই (`services/walletCallback.js`)। |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | ছবি আপলোড। |
| `EMAIL_USER`, `EMAIL_PASS` | SMTP ইমেইল। |
| `SMS_API_URL`, `SMS_API_KEY` | SMS গেটওয়ে। |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_ADMIN_USER_IDS`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_SETTINGS_KEY` | টেলিগ্রাম বট/অ্যালার্ট। `TELEGRAM_SETTINGS_KEY` এনক্রিপশন চেইনের অংশ — নতুন মান বসাবেন না। |

কোড থেকে পাওয়া অন্যান্য ঐচ্ছিক ভেরিয়েবল (প্রয়োজনে গ্রুপে যোগ করুন): `BACKUP_ENCRYPTION_KEY`, `SENTRY_DSN`,
`SENTRY_ENVIRONMENT`, `SENTRY_ENABLED`, `SSLCZ_STORE_ID`, `SSLCZ_STORE_PASSWD`, `SSLCZ_IS_LIVE`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `FEED_API_KEY`, `METRICS_TOKEN`,
`SPORTS_PROVIDERS`, `BUSINESS_TIMEZONE`, `ALLOWED_ORIGINS`, `MATCH_SYNC_INTERVAL_MINUTES`,
`CASINO_SYNC_INTERVAL_MINUTES`, `BACKUP_SCHEDULE_HOURS`। (এই তালিকা `process.env.*` কোড-সার্চ থেকে; সম্পূর্ণ
তালিকা পাওয়া যাবে `grep -rhoE "process\.env\.[A-Z0-9_]+"` দিয়ে।)

## সার্ভিস-নির্দিষ্ট (গ্রুপে নয়, `render.yaml`-এ)

| ভেরিয়েবল | কোথায় | বিবরণ |
|---|---|---|
| `REDIS_URL` | web + worker | `livo-redis` (**noeviction**) — সেশন, BullMQ, Socket.IO adapter। |
| `CACHE_REDIS_URL` | web + worker | `livo-redis-cache` (**allkeys-lru**) — ক্যাশ + রেট-লিমিট। না থাকলে `REDIS_URL`-এ ফলব্যাক। |
| `DATABASE_URL` | web + worker | `livo-postgres` থেকে স্বয়ংক্রিয়। |
| `DB_POOL_MAX` | web=`10`, worker=`5` | মোট স্থির ২৫; ডিপ্লয় ওভারল্যাপে ~৫০ — ১০০ সীমার ভেতরে। |
| `TRUST_PROXY_HOPS` | web | **মালিককে জানাতে হবে**: Cloudflare + Render হলে `2`, শুধু Render হলে `1`। ড্যাশবোর্ডে বসান। |

## TRUST_PROXY_HOPS যাচাই (staging)

ভুল মান বসালে `req.ip` প্রক্সির IP হয়ে যায় (সবার রেট-লিমিট একসাথে) বা স্পুফ করা `X-Forwarded-For` গৃহীত হয়।
সেট করার পর আলাদা নেটওয়ার্ক/মোবাইল ডেটা থেকে একটা টেস্ট এন্ডপয়েন্ট (যেখান থেকে `req.ip` দেখা যায়) কল করে
নিজের আসল IP-র সাথে মিলান।

## ঐচ্ছিক টিউনিং ভেরিয়েবল (Step 2) — ডিফল্ট ঠিক আছে, না বসালেও চলে

| ভেরিয়েবল | ডিফল্ট | বিবরণ |
|---|---|---|
| `REDIS_RETRY_BASE_MS` / `REDIS_RETRY_CAP_MS` | `500` / `30000` | ক্যাশ Redis রিকানেক্ট backoff (দ্বিগুণ হয়ে ক্যাপে থামে, অনির্দিষ্টকাল রিট্রাই)। |
| `CACHE_FALLTHROUGH_CONCURRENCY` | `4` | Redis ডাউনে একসাথে সর্বোচ্চ কতগুলো ক্যাশ-মিস DB-তে যাবে (DB_POOL_MAX-এর অর্ধেকের কম রাখুন)। |
| `CACHE_FALLTHROUGH_QUEUE_MAX` | `1000` | অপেক্ষমাণ সারির সীমা; ছাড়ালে রিকোয়েস্ট shed হয়। |
| `CACHE_LOCAL_FALLBACK_TTL_SECONDS` / `CACHE_LOCAL_FALLBACK_MAX` | `5` / `500` | শুধু Redis ডাউনে ব্যবহৃত ছোট in-process ক্যাশ। |
| `API_LOG_MAX_PENDING` | `500` | API লগ enqueue-এর সীমা; ছাড়ালে লগ ফেলে দেওয়া হয় ও গোনা হয় (রিকোয়েস্ট আটকায় না)। |
| `READY_TIMEOUT_MS` | `1500` | `/ready`-র DB `SELECT 1` ও Redis `PING` টাইমআউট। |

**নোট:** `/ready` এখন Redis `PING` সাড়া না দিলে 503 দেয়। Render-এর `healthCheckPath` `/health` (তুচ্ছ) — `/ready` শুধু বাইরের প্রোব/মনিটরের জন্য।
