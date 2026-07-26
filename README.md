# Livo Backend

স্পোর্টস ম্যাচ প্রেডিকশন প্ল্যাটফর্ম — Express (EJS views) + PostgreSQL ব্যাকএন্ড, সাথে একটা Next.js অংশ (`src/`) ও Telegram bot (`telegram-bot.js`)।

## চালানোর আগে

```bash
npm install
cp sports-api/.env.example sports-api/.env   # তারপর আসল key বসাও
```

রুট ডিরেক্টরিতে একটা `.env` ফাইল বানাও (এটা `.gitignore`-এ আছে, commit হবে না) এবং নিচের ভ্যারিয়েবলগুলো বসাও।

## Environment Variables

### আবশ্যক (এগুলো ছাড়া সার্ভার/ফিচার কাজ করবে না)

| Variable | কী জন্য |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string। সেট না থাকলে সার্ভার DB ছাড়া চলার চেষ্টা করবে (বেশিরভাগ ফিচার কাজ করবে না)। |
| `SESSION_SECRET` | লগইন session সাইন করতে। সেট না থাকলে প্রতি রিস্টার্টে র‍্যান্ডম সিক্রেট জেনারেট হয় — মানে সব ইউজার লগ-আউট হয়ে যাবে রিস্টার্টে। প্রোডাকশনে অবশ্যই একটা fixed, লম্বা random string দাও। |
| `PORT` | সার্ভার যে পোর্টে চলবে (Render নিজেই সেট করে দেয়, লোকালে না দিলে 3000)। |

### Payment (SSLCommerz)

| Variable | কী জন্য |
|---|---|
| `SSLCZ_STORE_ID` | SSLCommerz store ID |
| `SSLCZ_STORE_PASSWD` | SSLCommerz store password |
| `SSLCZ_IS_LIVE` | `true`/`false` — live না sandbox mode |

### ইমেইল (পাসওয়ার্ড রিসেট ইত্যাদি)

| Variable | কী জন্য |
|---|---|
| `EMAIL_USER` | পাঠানোর ইমেইল অ্যাড্রেস |
| `EMAIL_PASS` | ইমেইল অ্যাপ পাসওয়ার্ড (Gmail হলে সাধারণ পাসওয়ার্ড না, App Password ব্যবহার করো) |

### Cloudinary (ছবি আপলোড)

| Variable | কী জন্য |
|---|---|
| `CLOUDINARY_CLOUD_NAME` | Cloudinary অ্যাকাউন্ট নাম |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

### Push Notification (Web Push)

| Variable | কী জন্য |
|---|---|
| `VAPID_PUBLIC_KEY` | `web-push generate-vapid-keys` দিয়ে বানাও |
| `VAPID_PRIVATE_KEY` | উপরের কমান্ডের সাথেই পাবে |
| `VAPID_SUBJECT` | `mailto:you@example.com` ফরম্যাটে |

### Sports Data API

| Variable | কী জন্য |
|---|---|
| `API_FOOTBALL_KEY` / `FOOTBALL_API_KEY` | ফুটবল ম্যাচ ডেটার জন্য |
| `CRICKET_API_KEY` | ক্রিকেট ম্যাচ ডেটার জন্য |
| `RAPIDAPI_KEY` | RapidAPI-নির্ভর sports endpoint-এর জন্য |
| `POLL_INTERVAL_FOOTBALL` / `POLL_INTERVAL_CRICKET` | কত মিলিসেকেন্ড পরপর নতুন ডেটা পোল হবে |

### Telegram Bot (AI assistant, GitHub-এ write access সহ)

⚠️ **এই বট GitHub repo-তে সরাসরি কমিট করতে পারে — নিচের তিনটা variable ছাড়া বট চালু হবে না (ইচ্ছাকৃতভাবে fail-closed রাখা হয়েছে):**

| Variable | কী জন্য |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather থেকে পাওয়া bot token। **কখনো চ্যাটে/কোডে হার্ডকোড করে শেয়ার কোরো না — leak হলে সাথে সাথে BotFather দিয়ে revoke করো।** |
| `TELEGRAM_WEBHOOK_SECRET` | নিজে বানাও, যেমন: `openssl rand -hex 24`। Telegram-এর webhook request সত্যি Telegram থেকে এসেছে কিনা যাচাই করতে ব্যবহার হয়। |
| `TELEGRAM_ADMIN_CHAT_ID` | তোমার নিজের Telegram chat id। শুধু এই chat থেকে আসা মেসেজেই বট সাড়া দেবে। বট-কে `/start` পাঠালে বা [@userinfobot](https://t.me/userinfobot)-কে মেসেজ দিলে chat id পাওয়া যায়। |
| `ANTHROPIC_API_KEY` | বট যে AI মডেল ব্যবহার করে তার জন্য। |
| `GITHUB_TOKEN` | GitHub Personal Access Token — **শুধু এই একটা repo-তে Contents: Read & Write** পারমিশন দিয়ে fine-grained token বানানো উচিত, পুরো অ্যাকাউন্টের access দেওয়া উচিত না। |
| `RENDER_EXTERNAL_URL` | Render-এ ডিপ্লয় করা সার্ভারের পাবলিক URL (webhook রেজিস্টার করতে লাগে)। |

বট এখন যেকোনো GitHub ফাইল edit করার আগে Telegram-এ "হ্যাঁ/না" জিজ্ঞেস করে নিশ্চিত হবে — না লিখলে ৫ মিনিট পর নিজে থেকেই বাতিল হয়ে যায়।

### অন্যান্য

| Variable | কী জন্য |
|---|---|
| `SETUP_KEY` | প্রথমবার অ্যাডমিন অ্যাকাউন্ট বানানোর সেটআপ রুট সুরক্ষিত রাখতে |
| `FRONTEND_URL` | CORS/লিংক জেনারেশনে ব্যবহৃত |
| `NODE_ENV` | `production` সেট করলে cookie-তে `secure: true` চালু হয় |

## চালানো

```bash
npm start        # production
npm run dev       # nodemon দিয়ে, ডেভেলপমেন্টে
```

## নিরাপত্তা সংক্রান্ত নোট

- কোনো real API key/token/password কখনো git-এ commit করবে না বা চ্যাটে শেয়ার করবে না — leak হলে সেটাকে সাথে সাথে revoke/rotate করে ফেলা উচিত, শুধু মুছে দিলেই যথেষ্ট না।
- `.env` ফাইল সবসময় `.gitignore`-এ থাকতে হবে (আছে) এবং **কখনো `git add` করা যাবে না**।
- `npm audit` মাঝে মাঝে চালিয়ে dependency vulnerability চেক করো।
