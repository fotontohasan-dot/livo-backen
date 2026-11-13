# Staging setup (owner steps) — DRAFT, nothing created yet

## 🟢 মালিকের জন্য বাংলা চেকলিস্ট (কোড না জেনে Render ড্যাশবোর্ডে একা অনুসরণ করার জন্য)

> নিচের ইংরেজি ধাপগুলো ডেভেলপারদের জন্য লেখা। শুধু ড্যাশবোর্ড দিয়ে চালু করতে এই চেকলিস্টই যথেষ্ট — **ক্রম বদলাবেন না**।
> `staging` ব্রাঞ্চ গিটহাবে আগে থেকেই আছে; ইংরেজি ধাপ ১-এর `git branch staging …` আবার চালাতে হবে না।

**নিরাপত্তার নিয়ম:** staging-এ আসল টাকা বা আসল প্রোভাইডার কী কখনো বসাবেন না। production-এর কোনো পাসওয়ার্ড/কী এখানে কপি করবেন না।

### ধাপ ১ — সার্ভিস তৈরি (Blueprint)
- [ ] Render → **New → Blueprint** → এই রিপো বাছুন → **Branch = `staging`** → Blueprint file path = **`render.staging.yaml`**।
- [ ] আলাদা Project/Environment-এর নাম দিন **staging** (production-এর সাথে মেশাবেন না)।
- [ ] Apply চাপুন। ৬টি জিনিস তৈরি হবে: `livo-web-staging`, `livo-worker-staging`, `livo-mock-provider-staging`, দুটি Key Value (`livo-redis-staging`, `livo-redis-cache-staging`), ডাটাবেজ `livo-postgres-staging`, এবং **খালি** env গ্রুপ `livo-shared-staging`।
- ⚠️ **প্রথম ডিপ্লয় ব্যর্থ হওয়াই স্বাভাবিক** — গ্রুপ খালি, তাই `SESSION_SECRET` নেই বলে অ্যাপ ইচ্ছে করেই বুট হয় না। ঘাবড়াবেন না, ধাপ ২-৩ শেষে আবার ডিপ্লয় করবেন।

### ধাপ ২ — মক সার্ভিসের কী (`livo-mock-provider-staging` → Environment)
- [ ] `MOCK_CONTROL_KEY` = যেকোনো নতুন এলোমেলো মান (৩২+ অক্ষর; টার্মিনালে `openssl rand -hex 24`, অথবা পাসওয়ার্ড ম্যানেজার)। Save করুন।
- [ ] মক সার্ভিস **Live** হলে তার ঠিকানা কপি করুন (যেমন `https://livo-mock-provider-staging.onrender.com`) — পরের ধাপে লাগবে।

### ধাপ ৩ — env গ্রুপ `livo-shared-staging` (Dashboard → Environment Groups → গ্রুপ খুলুন)
নিচের ভেরিয়েবলগুলো ঠিক এই নামে যোগ করুন (নামের বানান হুবহু):

| # | ভেরিয়েবল | মান | বাধ্যতামূলক? |
|---|---|---|---|
| 1 | `SESSION_SECRET` | **নতুন** এলোমেলো, ৪৮+ অক্ষর (৩২-এর কম হলে অ্যাপ বুট হবে না)। production-এর মান নয়। | **হ্যাঁ** |
| 2 | `PUBLIC_APP_URL` | staging ওয়েবের পূর্ণ ঠিকানা, `https://` সহ (`livo-web-staging`-এর পাতায় দেখুন) | প্রস্তাবিত (না দিলে ইমেইলের ভেরিফাই লিংক ভাঙা হবে; বুট আটকায় না) |
| 3 | `FEED_API_KEY` | নতুন এলোমেলো, ৩২+ অক্ষর (লোড টেস্টের ফিডে লাগে; ফাঁকা রাখলে ফিড বন্ধ থাকে, বুট আটকায় না) | লোড টেস্ট করলে |
| 4 | `METRICS_TOKEN` | নতুন এলোমেলো মান (না দিলে শুধু সতর্কতা আসে) | প্রস্তাবিত |
| 5 | `CRICKET_API_KEY` | `mock` | হ্যাঁ (মক ব্যবহারে) |
| 6 | `RAPIDAPI_KEY` | `mock` | হ্যাঁ (মক ব্যবহারে) |
| 7 | `CRICKET_API_BASE_URL` | `<মক ঠিকানা>/cricket` | হ্যাঁ |
| 8 | `FOOTBALL_API_BASE_URL` | `<মক ঠিকানা>/football` | হ্যাঁ |
| 9 | `SMS_API_URL` | `<মক ঠিকানা>/sms/send` | হ্যাঁ |
| 10 | `SMS_API_KEY` | `mock` | হ্যাঁ |

- [ ] উপরের ১–১০ বসালেন → **Save Changes**।
- ⚠️ `CANONICAL_HOST` **বসাবেন না** (ফাঁকা রাখুন)। দিলে শুধু হোস্টনাম (`https://` ছাড়া) হতে হয়, আর একটু ভুল হলে সব পেজ ভুল ঠিকানায় রিডাইরেক্ট করবে।
- ⚠️ `TRUST_PROXY_HOPS`, `NODE_ENV`, `SSLCZ_IS_LIVE`, `DATABASE_URL`, `REDIS_URL` — এগুলো ফাইলেই বসানো আছে, গ্রুপে যোগ করবেন না।

**এই ভেরিয়েবলগুলো ফাঁকা রাখুন (staging-এ লাগে না):** `CASINO_PROVIDERS`, `SSLCZ_STORE_ID`, `SSLCZ_STORE_PASSWD`, bKash/Nagad/Rocket/Upay-এর সব কী, `EMAIL_USER`, `EMAIL_PASS`, `TELEGRAM_*`, `CLOUDINARY_*`, `GOOGLE_CLIENT_*`, `SENTRY_*`।
(কোনো একটা জোড়ার শুধু অর্ধেক বসালে অ্যাপ বুটে "আংশিক কনফিগার" সতর্কতা দেখায় — তাই বসালে জোড়া দুটোই, আর নইলে দুটোই ফাঁকা।)

### ধাপ ৪ — আবার ডিপ্লয় ও যাচাই
- [ ] `livo-web-staging` → **Manual Deploy → Deploy latest commit**। তারপর `livo-worker-staging`-এও একই।
- [ ] ব্রাউজারে `<staging ঠিকানা>/health` খুলুন → **200 / ok** আসতে হবে। `/ready`-ও একই।
- [ ] সমস্যা হলে `livo-web-staging` → **Logs** দেখুন: "SESSION_SECRET … আবশ্যক/দুর্বল" লেখা থাকলে ধাপ ৩-এর ১ নম্বর ঠিক করুন।
- [ ] শেষে (খরচ বাঁচাতে) কাজ শেষ হলে সব staging সার্ভিস **Suspend** বা মুছে দিন।

### নিশ্চিতকরণ: staging-এ আসল পেমেন্ট বা আসল প্রোভাইডার কী লাগে না
- **পেমেন্ট:** `SSLCZ_IS_LIVE=false` ফাইলেই স্থির (sandbox)। `SSLCZ_*` ফাঁকা রাখলে কোনো গেটওয়েই সক্রিয় হয় না; bKash/Nagad/Rocket/Upay-এর কোনো সিক্রেট লাগে না।
- **স্পোর্টস ও SMS:** `ALLOW_PROVIDER_BASE_URL_OVERRIDE=true` ফাইলেই আছে, তাই কল যায় `livo-mock-provider-staging`-এ (ফেক কী `mock`)। এই সুইচ production-এ সেট করা হয় না, আর `services/sportsAPI.js` শুধু এটি `true` হলেই বেস-URL বদলায়।
- **ক্যাসিনো:** `CASINO_PROVIDERS` ফাঁকা = কোনো ক্যাসিনো প্রোভাইডার নেই।
- **ডাটা/ক্যাশ:** আলাদা `livo-postgres-staging` ও দুটি আলাদা Key Value — production-এর সাথে কিছুই শেয়ার হয় না।

---

`render.staging.yaml` defines a staging copy of production: 2 web instances, worker, Postgres, two Key Value stores
(session/queue `noeviction`, cache `allkeys-lru`) and an optional mock provider. It deploys from a branch named `staging`.
It shares nothing with production (names, DB, Redis, env group, secrets).

## Steps
1. **Create the branch**: `git branch staging <commit of PR #258 stack>` and push it. Do not merge #254/#257/#258 into `main` yet; staging can run the stacked branch.
2. **Create the Blueprint**: Render dashboard → New → Blueprint → pick this repo, branch `staging`, Blueprint file path `render.staging.yaml`. (Use a separate Render Project/Environment named "staging" so production is never mixed in.) Check with `render blueprints validate render.staging.yaml` if you use the Render CLI; the exact YAML field names (`branch`, `autoDeploy`, `plan` IDs) follow `render.yaml` but were not validated against Render in this draft.
3. **Fill the env group `livo-shared-staging`** (Environment Groups). Use TEST values only:
   - `SESSION_SECRET`: a **new** random 48+ char value. Never copy production's.
   - `FEED_API_KEY`: new random value (used by the load test feed driver). `METRICS_TOKEN`: new random value.
   - `PUBLIC_APP_URL` / `CANONICAL_HOST`: the staging URL.
   - `CRICKET_API_KEY=mock`, `RAPIDAPI_KEY=mock`, `CRICKET_API_BASE_URL=https://livo-mock-provider-staging.onrender.com/cricket`, `FOOTBALL_API_BASE_URL=.../football`.
   - `SMS_API_URL=https://livo-mock-provider-staging.onrender.com/sms/send`, `SMS_API_KEY=mock`.
   - Casino: leave `CASINO_PROVIDERS` empty, or point `PROVIDER_<NAME>_API_URL` at `.../casino` with fake credentials.
   - Payments: leave `SSLCZ_*` empty (or SSLCommerz sandbox credentials; `SSLCZ_IS_LIVE=false` is already set). No bKash/Nagad/Rocket/Upay secrets.
   - Email/Telegram/Cloudinary/Sentry: empty, or separate test accounts. Do not reuse production tokens.
4. Set `MOCK_CONTROL_KEY` on the mock service (random). Set `TRUST_PROXY_HOPS` as in the file (1).
5. Wait for the first deploy; confirm `GET /health` and `/ready` return 200 and `/metrics` with the token works.
6. Enable pg_stat_statements: `psql "<staging external DB url>" -f scripts/loadtest/sql/enable_pg_stat_statements.sql`. First run `SHOW shared_preload_libraries;`; if it does not list `pg_stat_statements` the extension cannot collect data and Render support/plan limits need checking (not verified here). **Never run this on production without owner approval.**
   **Top-10 report (do not run yet):** after the load test, `LOADTEST_STAGING_URL=<staging url> LOADTEST_DB_URL=<staging external DB url> npm run loadtest:pgstat` prints the 10 slowest queries (total and mean execution time) and the 10 most called, plus connection counts. It is read-only, refuses any host that is not clearly staging (`scripts/loadtest/lib/guard.js`) and exits with an error if the extension is not enabled. Add `-- --watch 5` during the test for peak connections. Do not run it against production; do not commit its `results/` output.
7. Follow `scripts/loadtest/README.md`.
8. When done: delete the staging services, or suspend them, to stop billing.

## Monthly cost estimate (verify on Render's pricing page; prices below are my best knowledge and may be out of date)
Render bills per second, so a short-lived staging costs a fraction of these amounts.
| Item | Plan | Qty | ≈ USD/month |
|---|---|---|---|
| Web `livo-web-staging` | 0.5c-512mb (Starter, same as prod) | 2 | 14 |
| Worker | 0.5c-512mb | 1 | 7 |
| Mock provider | Starter | 1 | 7 |
| Key Value ×2 | 256 MB | 2 | ~20 |
| Postgres | 0.5c-1g (~Basic 1 GB) + storage | 1 | ~20 |
| **Total (full, production-like)** |  |  | **≈ $68** |

**Smaller option for functional tests only** (not for load numbers): web ×2 Starter (14) + worker (7) + Postgres smallest paid (~6–7) + free Key Value for both stores (0, small memory, so Redis-memory results are meaningless) + run the mock locally or on the generator (0) ≈ **$27–30**. Keep 2 web instances: single-instance staging hides the shared-limiter and Socket.IO adapter issues that staging exists to catch.
Free plans sleep and have tight limits, so do not use them for web/worker.

## B3. Making production deploys manual until staging passes
- `render.yaml` already has `autoDeploy: false` on `livo-web` and `livo-worker`. Confirm in the dashboard (each service → Settings → Build & Deploy → Auto-Deploy = **Off**), because a Blueprint sync can differ from the dashboard.
- Deploy production only via **Manual Deploy → Deploy a specific commit**, using the exact commit SHA that passed on staging. Write that SHA in the PR.
- Protect `main`: require PR review and the CI check; only the owner merges. Merging to `main` then deploys nothing by itself.
- Promotion flow: PR → merge to `staging` branch (auto-deploys staging) → run load test + acceptance checks → owner approves → manual deploy of that commit to production.
- Do not connect `staging` and `main` to the same Render services.
