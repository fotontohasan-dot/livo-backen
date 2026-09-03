# Livo Backend

স্পোর্টস ম্যাচ প্রেডিকশন প্ল্যাটফর্ম — Express (EJS views) + PostgreSQL ব্যাকএন্ড, সাথে একটা Next.js অংশ (`src/`) ও Telegram bot (`telegram-bot.js`)।

> **প্রোডাকশনে কোনটা চলে:** প্রোডাকশন সার্ভার একমাত্র Express অ্যাপ (`node app.js`) — সব পেজ
> `views/`-এর EJS টেমপ্লেট থেকে রেন্ডার হয়। `src/`-এর Next.js অংশটা এখনো ডেভেলপমেন্ট/প্রিভিউ
> পর্যায়ে; এটা কোনো প্রোডাকশন ট্র্যাফিক সার্ভ করে না, Docker ইমেজেও বিল্ড হয় না। সেজন্য
> `next`, `react`, `react-dom`, `framer-motion`, `lucide-react` — এগুলো `devDependencies`-এ
> রাখা হয়েছে, ফলে প্রোডাকশন ইমেজ (`npm ci --omit=dev`) অনেক ছোট থাকে ও কম attack surface পায়।
> `npm run build` শুধু Next অংশটার বিল্ড যাচাই করে (CI-তেও তাই), সার্ভার চালু করার জন্য দরকার নেই।

> **প্রোডাকশন অপারেশন:** ডিপ্লয়, হেলথ ভেরিফিকেশন, ব্যাকআপ/রিস্টোর, রিস্টার্ট-রিকভারি ও
> রোলব্যাকের ধাপে-ধাপে চেকলিস্ট আলাদা রানবুকে আছে — [`docs/RUNBOOK.md`](docs/RUNBOOK.md)।

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
| `ADMIN_RESET_TOKEN` | ব্রেক-গ্লাস অ্যাডমিন রিকভারি রুট (`/internal/reset-admin`) সক্রিয় করে। সেট না থাকলে রুটটা রেজিস্টারই হয় না। প্রোডাকশনে অন্তত ৩২ ক্যারেক্টার — ছোট হলে fail-closed। |
| `NEW_ADMIN_EMAIL` | রিকভারিতে যে অ্যাকাউন্টটা admin হবে। ইমেইলটা আগে থেকে থাকলে সেটাকেই promote করা হয়, না থাকলে নতুন অ্যাকাউন্ট তৈরি হয়। |
| `NEW_ADMIN_PASSWORD` | ঐ অ্যাকাউন্টের পাসওয়ার্ড (bcrypt হ্যাশ করে রাখা হয়)। **কোডে কখনো হার্ডকোড কোরো না** — env var-এ দাও, রিকভারির পরেই মুছে ফেলো। |
| `FRONTEND_URL` | CORS/লিংক জেনারেশনে ব্যবহৃত |
| `NODE_ENV` | `production` সেট করলে cookie-তে `secure: true` চালু হয় |

## প্রথম অ্যাডমিন অ্যাকাউন্ট / অ্যাডমিন রিকভারি

আলাদা কোনো সেটআপ রুট বা আলাদা অথেন্টিকেশন সিস্টেম নেই — অ্যাডমিন তৈরি ও
পাসওয়ার্ড রিকভারি দুটোই `/internal/reset-admin` দিয়ে হয় (কোড: `app.js`)।

> আগের README-তে এখানে `SETUP_KEY` নামে একটা ভ্যারিয়েবল লেখা ছিল। কোডে ওই
> নামে কিছু কখনোই ছিল না — ডকুমেন্টেশনটা ভুল ছিল, নিচেরটাই আসল ফ্লো।

**ধাপ ১ — env var সেট করো** (হোস্টের ড্যাশবোর্ডে বা `.env`-এ; কোনো মান কোডে
বা কমিটে যাবে না):

```bash
ADMIN_RESET_TOKEN=$(openssl rand -hex 24)   # >= 32 ক্যারেক্টার
NEW_ADMIN_EMAIL=you@example.com
NEW_ADMIN_PASSWORD=$(openssl rand -base64 18)
```

**ধাপ ২ — সার্ভার রিস্টার্ট করো।** `ADMIN_RESET_TOKEN` না থাকলে রুটটা
রেজিস্টার হয় না, তাই রিস্টার্ট ছাড়া কাজ করবে না।

**ধাপ ৩ — রিকভারি চালাও।** `https://<host>/internal/reset-admin`-এ গিয়ে
টোকেন বসাও ও নিশ্চিতকরণ চেকবক্স টিক করো। GET কিছুই বদলায় না, শুধু POST-এ
পরিবর্তন হয়। ব্রাউজার না থাকলে:

```bash
curl -X POST https://<host>/internal/reset-admin \
  -d "token=$ADMIN_RESET_TOKEN&confirm=yes"
```

**ধাপ ৪ — `/admin/login`-এ লগইন করো**, তারপর **তিনটা env var-ই মুছে ফেলে
আবার রিস্টার্ট করো**। তাহলে রুটটা আবার নিষ্ক্রিয় হয়ে যাবে।

আচরণ ও সুরক্ষা:

- বিদ্যমান কোনো অ্যাডমিনকে ডিমোট করা হয় না — লকআউটের ঝুঁকি নেই।
- ভুল টোকেনে `404` (রুটের অস্তিত্বই ফাঁস হয় না), নিশ্চিতকরণ ছাড়া `400`।
- ঘণ্টায় ৫টা চেষ্টার রেট লিমিট; সফল ও ব্যর্থ দুটোই `audit_logs`-এ
  (`ADMIN_RECOVERY_EXECUTED` / `ADMIN_RECOVERY_DENIED`) IP-সহ জমা হয়।
- টোকেন `timingSafeEqual` দিয়ে মেলানো হয়, আর query string-এ নেওয়া হয় না।

## চালানো

```bash
npm start        # production
npm run dev       # nodemon দিয়ে, ডেভেলপমেন্টে
```

## Docker (এক কমান্ডে পুরো সিস্টেম)

### ধাপ ১ — `.env` ফাইল তৈরি করা (Compose চালানোর আগেই আবশ্যক)

`docker-compose.yml`-এ `env_file: .env` আছে, আর `.env` ফাইলটা `.gitignore`-এ (রিপোতে কমিট
হয় না)। তাই **ফ্রেশ ক্লোনে `.env` না বানিয়ে Compose চালালে সেটা শুরুই হবে না**:

```
env file /path/to/livo-backen/.env not found
```

টেমপ্লেট থেকে কপি করে নাও, তারপর ভ্যালু বসাও:

```bash
cp .env.example .env
```

Compose চালু করতে হলে নিচের ভ্যারিয়েবলগুলো `.env`-এ **অবশ্যই** থাকতে হবে (ফাঁকা থাকলে
Compose ইচ্ছাকৃতভাবেই থেমে যাবে — দুর্বল ডিফল্ট পাসওয়ার্ড নিয়ে যেন কেউ ভুল করে প্রোডাকশনে
না ওঠে, সেজন্য এগুলোতে `${VAR:?}` required-syntax ব্যবহার করা হয়েছে):

| Variable | কী জন্য | কীভাবে বানাবে |
|---|---|---|
| `DB_PASSWORD` | PostgreSQL (`db` সার্ভিস) পাসওয়ার্ড | `openssl rand -hex 24` |
| `REDIS_PASSWORD` | Redis `requirepass` | `openssl rand -hex 24` |
| `SESSION_SECRET` | সেশন কুকি সাইনিং (অন্তত ৩২ ক্যারেক্টার) | `openssl rand -hex 32` |
| `METRICS_TOKEN` | Prometheus-কে `/metrics` স্ক্র্যাপ করতে দেয় | `openssl rand -hex 24` |
| `GRAFANA_ADMIN_PASSWORD` | Grafana অ্যাডমিন লগইন | `openssl rand -hex 16` |

এক কমান্ডে পাঁচটাই জেনারেট করে `.env`-এ যোগ করতে চাইলে:

```bash
{
  echo "DB_PASSWORD=$(openssl rand -hex 24)"
  echo "REDIS_PASSWORD=$(openssl rand -hex 24)"
  echo "SESSION_SECRET=$(openssl rand -hex 32)"
  echo "METRICS_TOKEN=$(openssl rand -hex 24)"
  echo "GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 16)"
} >> .env
```

সঠিকভাবে সেট হয়েছে কিনা যাচাই করতে (কনটেইনার চালু না করেই):

```bash
docker compose -f docker-compose.yml config >/dev/null && echo "config OK"
```

কোনোটা বাদ পড়লে এরকম মেসেজ আসবে: `required variable DB_PASSWORD is missing a value`।

### ধাপ ২ — প্রোডাকশনে চালানো

```bash
docker compose -f docker-compose.yml up -d --build
```

> ⚠️ **প্রোডাকশনে `-f docker-compose.yml` লেখাটা বাধ্যতামূলক।**
>
> এই রিপোতে `docker-compose.override.yml` ফাইলটা কমিট করা আছে (লোকাল ডেভেলপমেন্টের
> সুবিধার জন্য), আর Docker Compose কনভেনশন অনুযায়ী **override ফাইলটা `docker compose`
> কমান্ডে নিজে থেকেই যুক্ত হয়ে যায়**। অর্থাৎ শুধু `docker compose up -d --build` লিখলে
> যা হবে:
>
> - ইমেজ বিল্ড হবে `development` টার্গেট থেকে, `production` টার্গেট থেকে নয়
> - `NODE_ENV=development` হয়ে যাবে
> - সোর্স কোড bind-mount হয়ে ইমেজের কনটেন্ট ঢেকে দেবে, আর অ্যাপ চলবে `nodemon`-এ
> - `DB_PASSWORD`/`REDIS_PASSWORD`/`SESSION_SECRET`-এ override ফাইলের দুর্বল ডেভ-ডিফল্ট
>   (`changeme`, `dev-secret-change-me`) কার্যকর হবে
>
> `-f docker-compose.yml` দিলে Compose শুধু ওই একটা ফাইলই পড়ে, override সম্পূর্ণ উপেক্ষা
> করে — তাই প্রোডাকশন ইমেজ, `NODE_ENV=production` এবং আসল সিক্রেটগুলোই ব্যবহার হয়।

চালু আছে কিনা দেখতে:

```bash
docker compose -f docker-compose.yml ps
curl -f http://localhost:${PORT:-3000}/health
```

### ধাপ ৩ — লোকাল ডেভেলপমেন্টে চালানো (override সহ)

লোকাল ডেভে override ফাইলটাই কাজে লাগে — এখানে `-f` ছাড়া চালানোই উদ্দেশ্য:

```bash
docker compose up -d --build     # development টার্গেট + nodemon + live reload
```

### মনিটরিং

App, PostgreSQL, Redis চালু হবে। মনিটরিং স্ট্যাক (Prometheus + Grafana) একই কমান্ডে চালু হয়:

- Prometheus: `http://localhost:9090` — `/metrics` স্ক্র্যাপ করে (`METRICS_TOKEN` দিয়ে; টোকেন না দিলে প্রতিটা স্ক্র্যাপ 401 হবে)
- Grafana: `http://localhost:${GRAFANA_PORT:-3001}` — লগইন `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD` (`.env`-এ সেট করা বাধ্যতামূলক); "Livo" ফোল্ডারে "Livo — Application Overview" ড্যাশবোর্ড অটো-ইম্পোর্ট হয়ে থাকবে (CPU, Memory, Request Rate, Response Time, Error Rate, Redis, PostgreSQL, Queue, Active Users, API Metrics)

মনিটরিং স্ট্যাক ছাড়া শুধু app+db+redis চালাতে চাইলে:

```bash
docker compose -f docker-compose.yml up -d --build app db redis
```

## Automated Testing

এই প্রজেক্টে Jest + Supertest দিয়ে একটা সম্পূর্ণ Automated Test System আছে — Auth, Admin, Payment, Public API, Health Check ও Security-এর ইউনিট + ইন্টিগ্রেশন টেস্ট। টেস্টগুলো production কোড পরিবর্তন না করেই আসল `app.js`-কে supertest দিয়ে বুট করে একটা **আলাদা, ডিসপোজেবল টেস্ট PostgreSQL ডাটাবেজের** বিপরীতে চালায়।

### লোকালি টেস্ট চালানো

```bash
# ১) আলাদা টেস্ট ডাটাবেজ চালু করো (ডেভ/প্রোড ডাটাবেজের সাথে কোনো সম্পর্ক নেই)
docker compose -f docker-compose.test.yml up -d

# ২) টেস্ট চালাও
npm test                 # সব টেস্ট (unit + integration), সিরিয়ালি
npm run test:watch       # watch mode
npm run test:coverage    # coverage রিপোর্ট সহ (coverage/ ফোল্ডারে HTML রিপোর্ট জেনারেট হয়)

# ৩) শেষে টেস্ট ডাটাবেজ বন্ধ/পরিষ্কার করো
docker compose -f docker-compose.test.yml down -v
```

Docker না থাকলে যেকোনো লোকাল PostgreSQL ইনস্ট্যান্স ব্যবহার করা যাবে — `.env.test`-এ `DATABASE_URL` পাল্টে দাও।

### টেস্ট স্ট্রাকচার

```
tests/
  setup.js, afterEnv.js, globalSetup.js   # global jest config + migration bootstrap
  helpers/app.js    # shared supertest agent/CSRF/username helpers
  admin.test.js, api.test.js, auth.test.js, health.test.js, payment.test.js, security.test.js
  unit/             # DB ছাড়া pure/mocked ইউনিট টেস্ট (validate.js, apiKeyAuth.js)
  integration/
    backup.test.js   — Backup & Restore System পূর্ণাঙ্গ audit (দেখুন AUDIT_REPORT.md)
    profile.test.js  — প্রোফাইল রুট (balance, security, change-password)
```

বিস্তারিত টেস্ট ডকুমেন্টেশনের জন্য দেখুন `TESTING.md`।

### CI (GitHub Actions)

প্রতিটা push/PR-এ `.github/workflows/node.js.yml` একটা ephemeral PostgreSQL service কন্টেইনার চালু করে, `npm run test:coverage` রান করে, আর coverage রিপোর্ট আর্টিফ্যাক্ট হিসেবে আপলোড করে। কোনো টেস্ট ফেল করলে পুরো CI বিল্ড ফেল হয়ে যাবে (merge/deploy আটকে যাবে)।

## নিরাপত্তা সংক্রান্ত নোট

- কোনো real API key/token/password কখনো git-এ commit করবে না বা চ্যাটে শেয়ার করবে না — leak হলে সেটাকে সাথে সাথে revoke/rotate করে ফেলা উচিত, শুধু মুছে দিলেই যথেষ্ট না।
- `.env` ফাইল সবসময় `.gitignore`-এ থাকতে হবে (আছে) এবং **কখনো `git add` করা যাবে না**।
- `npm audit` মাঝে মাঝে চালিয়ে dependency vulnerability চেক করো।
