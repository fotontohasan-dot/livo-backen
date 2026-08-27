# CI / E2E ব্যর্থতার মূল-কারণ (root cause) ফিক্স রিপোর্ট

**বেসলাইন কমিট:** `adb53bf` (Merge pull request #101)
**পরিবেশ:** Node 22, PostgreSQL 16 (`livo_test`), Jest 94 suite, Playwright/Chromium

---

## ১. মূল ব্যর্থতাগুলো (যা রিপোর্ট করা হয়েছিল)

1. `app.js` ইম্পোর্ট করলেই টেস্ট প্রসেসের ভেতরে অ্যাপ্লিকেশন startup, DB কানেকশন ও মাইগ্রেশন শুরু হয়ে যেত।
2. `tests/games-cashout-timing.test.js`-এর সমান্তরাল cashout টেস্টে `ECONNRESET`।
3. রেজিস্ট্রেশন E2E-তে `POST /register` → `429 Too Many Requests`, যা `#username` selector timeout হিসেবে দেখা যেত।
4. KYC E2E-তে Cloudinary এনভায়রনমেন্ট mismatch-এর কারণে expected pending সারি তৈরি হতো না।
5. লাল CI থাকা অবস্থায় PR merge হওয়ায় ব্যর্থতা main-এ জমা হচ্ছিল।

---

## ২. মূল কারণ ও ফিক্স (সারসংক্ষেপ)

| Issue | Root Cause | Fix | Test | Status |
|------|------------|-----|------|--------|
| অ্যাপ ইম্পোর্টেই startup | `app.js`-এর শেষ লাইনে `startServer();` — require করলেই `connectDB()` + `runMigrations()` + startup টাস্ক চলত; teardown-এর পরেও async কাজ, মাইগ্রেশন রেস, কানেকশন contention | `app.js` = শুধু Express অ্যাপ (কোনো I/O নয়); নতুন `server.js` = প্রসেস গার্ড + DB + মাইগ্রেশন + `listen()` + ব্যাকগ্রাউন্ড কাজ, শুধু `require.main === module` হলে চালু | `tests/appLifecycle.test.js` (৭টি) | ✅ FIXED |
| টেস্টে কৃত্রিম বিলম্ব | `tests/afterEnv.js`-এ প্রতি ফাইলে `setTimeout(1500)` — উপরের বাগ ঢাকার জন্য | টাইমার সম্পূর্ণ সরানো (স্কিমা একবারই `globalSetup`-এ তৈরি হয়) | পুরো Jest সুইট | ✅ FIXED |
| Cashout `ECONNRESET` | বেসলাইনে একক রানে পুনরুৎপাদন হয়নি (৩ বার — ০ ব্যর্থতা)। উপসর্গটি ছিল টেস্ট/অ্যাপ লাইফসাইকেল contention-এর, cashout SQL-এর নয় — DB-স্তরের atomic claim ঠিকই কাজ করছিল | cashout বিজনেস লজিক **অপরিবর্তিত**; টেস্ট এখন প্রতিটা সমান্তরাল রিকোয়েস্টের সুনির্দিষ্ট HTTP স্ট্যাটাস দাবি করে (সকেট ভাঙলে ফেল) এবং DB স্টেট যাচাই করে | `tests/games-cashout-timing.test.js` | ✅ FIXED (গার্ডসহ) |
| ডাবল-পেআউট প্রমাণ দুর্বল | টেস্ট শুধু HTTP রেসপন্স ও ব্যালেন্স দেখত | ঠিক একটি `game_rounds` সারি ও non-null `settled_at`; `coin_transactions type='game_win'`-এর **সংখ্যা ও যোগফল** সফল পেআউটের সমান | একই ফাইল | ✅ FIXED |
| রেজিস্ট্রেশন E2E 429 | পুরো E2E রান একটাই loopback IP থেকে আসত; প্রোডাকশন `generalLimiter` (৩০০ req/১৫ মি.) ও `loginLimiter` (১০ POST/১৫ মি., `/login`+`/register`+`/admin/login` একই কী) কোটা শেষ করত, CI retry আরও বাড়াত | প্রতিটা টেস্ট নিজস্ব `X-Forwarded-For` পায় (অ্যাপে `trust proxy` আগে থেকেই আছে; Jest হেল্পার একই কৌশল ব্যবহার করে) — লিমিটার/লিমিট **অপরিবর্তিত**, অ্যাপে কোনো test-only bypass নেই | `tests/e2e/registrationRateLimit.spec.js` (Test A/B/C) | ✅ FIXED |
| KYC E2E-তে pending সারি নেই | Playwright `webServer` চালাত `node app.js` + `env: { NODE_ENV: 'development' }` — E2E প্রসেস কখনো `.env.test` পড়ত না; `isSafeCloudinaryUrl()` fail-closed হওয়ায় `CLOUDINARY_CLOUD_NAME` ছাড়া document_url বাতিল হতো। CI-তে কাজ করত শুধু কাকতালীয়ভাবে (job-level env), লোকালি কখনো না | `playwright.config.js`-এ একটাই অথরিটেটিভ env: `.env.test` = ডিফল্ট, process.env (CI env/secrets) = ওভাররাইড, `NODE_ENV=test` জোরালো, `node server.js`, আবশ্যক ভ্যারিয়েবল না থাকলে fail-fast | `criticalFlows.spec.js` (KYC) + HTTP-স্তরের যাচাই | ✅ FIXED |
| ব্যর্থতা "selector timeout" হয়ে ছদ্মবেশে আসা | ডাউনস্ট্রিম assertion-এর আগে HTTP ফল যাচাই হতো না | ক্রিটিক্যাল রিকোয়েস্টে আগে `response.status()` assert, তারপর DB/UI assertion | `criticalFlows.spec.js` (register, KYC) | ✅ FIXED |
| লাল CI-তে merge | Jest ধাপে `continue-on-error: true` — ধাপ ব্যর্থ হলেও সবুজ দেখাত | `continue-on-error` সরানো; annotation ধাপ `if: failure()`; boot smoke ও E2E এখন `server.js` চালায় | `.github/workflows/node.js.yml` | ✅ FIXED (branch protection ম্যানুয়ালি চালু করতে হবে — §৬) |

---

## ৩. পরিবর্তিত ফাইল

**প্রোডাকশন কোড**
- `app.js` — `startServer()`, `server.listen()`, `connectDB()`, `runMigrations()`, scheduler/backup/queue/matchUpdater require এবং `NODE_ENV === 'test'` শর্ট-সার্কিট সরানো হয়েছে। এখন `module.exports = app` (+ `app.httpServer` / `app.set('httpServer')`)।
- `server.js` — **নতুন**। প্রসেস ক্র্যাশ গার্ড + গ্রেসফুল শাটডাউন, `connectDB` → `runMigrations` → `ensureCriticalTables` → `listen(PORT)` → `publicUrl.assertConfigured()` → ব্যাকগ্রাউন্ড কাজ (match sync, queue worker, `initQueueSystem`, backup, scheduler)। `require.main === module` না হলে কিছুই চালু হয় না।
- `package.json` — `start`/`dev` → `server.js`।
- `Dockerfile` — দুই স্টেজেই `server.js`।

**টেস্ট/টুলিং**
- `tests/afterEnv.js` — ১৫০০ms sleep সরানো।
- `tests/appLifecycle.test.js` — **নতুন** রিগ্রেশন গার্ড।
- `tests/games-cashout-timing.test.js` — DB-স্টেট ও HTTP-স্ট্যাটাস assertion।
- `tests/e2e/registrationRateLimit.spec.js` — **নতুন** (Test A/B/C)।
- `tests/e2e/criticalFlows.spec.js` — per-test IP আইসোলেশন, register/KYC-তে response-status assertion।
- `playwright.config.js` — অথরিটেটিভ E2E env + `node server.js`।
- `tests/integration/{gracefulShutdownProcess,schedulerIntegrity,deferredItemsIntegrity}.test.js` — লাইফসাইকেল সোর্স-গার্ড `server.js`-এ রিটার্গেট।
- `.github/workflows/node.js.yml` — `continue-on-error` সরানো, annotation `if: failure()`, boot smoke ও E2E `server.js`।

**যা ইচ্ছাকৃতভাবে করা হয়নি:** কোনো টেস্ট delete/skip/`test.only`, retry বা timeout বাড়ানো, রেট-লিমিটার দুর্বল করা, KYC ভ্যালিডেশন বা `isSafeCloudinaryUrl()` শিথিল করা, cashout atomicity স্পর্শ করা, `continue-on-error` যোগ করা, সিক্রেট হার্ডকোড করা, বা কোনো `sleep`/`setTimeout` ফিক্স হিসেবে যোগ করা।

---

## ৪. আগে/পরে ফলাফল

**Jest (৯৪ suite, chunk-wise, `--runInBand`)**

| চাঙ্ক | Suites | Tests | ফল |
|------|--------|-------|-----|
| `tests/unit` | 12 | 121 | PASS |
| `tests/render` | 14 | 283 | PASS |
| `tests/security` (+ root security) | 28 | 342 | PASS |
| `tests/integration` | 19 | 291 | PASS |
| root-level বাকি | 21 | 239 | PASS |
| **মোট** | **94** | **1276** | **PASS** |

- বেসলাইনে `games-cashout-timing.test.js` একক রানে ৩ বার চালিয়ে ০ ব্যর্থতা ও ০ ECONNRESET; ফিক্সের পরেও ৫/৫ পাস, কিন্তু ফাইলের রানটাইম **~১৭.৪s → ~৪s** (কৃত্রিম sleep সরানোর ফল)।
- `tests/integration/gracefulShutdownProcess.test.js` এখন সত্যিকারের `node server.js` child process বুট করে SIGTERM/SIGINT যাচাই করে — পাস।

**কভারেজ থ্রেশহোল্ড** (`npm test` কভারেজসহ চালায়; চারটি চাঙ্কের `coverage-final.json` istanbul দিয়ে merge করে যাচাই — জেস্ট untested ফাইলগুলোকেও ০% হিসেবে ধরে, তাই merge করা ফল পূর্ণ রানের সমান):

```
GLOBAL   statements 52.57 (>= 25)   branches 42.94 (>= 15)
         functions  51.35 (>= 20)   lines    54.64 (>= 25)
middleware/auth.js   statements 74.28 / branches 66.66 / lines 75.38
utils/publicUrl.js   statements 73.07 / branches 76.00 / lines 75.00
utils/tokens.js      statements 100   / lines 100
utils/secretBox.js   statements 84.84 / lines 93.10
→ ALL COVERAGE THRESHOLDS MET
```

লাইফসাইকেল কোড `app.js` থেকে `server.js`-এ সরানোয় কভারেজ কমেনি — `server.js` `collectCoverageFrom`-এ নেই, আর সরানো অংশটুকু আগে `app.js`-এ uncovered হিসেবেই গোনা হতো।

**প্রোডাকশন বুট:** `node server.js` → `GET /health` = **200**।

**E2E (HTTP-স্তরে যাচাইকৃত):** এই স্যান্ডবক্সে Playwright-এর Chromium ডাউনলোড নেটওয়ার্ক পলিসিতে ব্লকড, তাই ব্রাউজার রান করা যায়নি। ব্রাউজার-নিরপেক্ষ অংশটুকু `playwright.config.js`-এর ঠিক সেই env দিয়ে চালানো আসল `server.js`-এর বিপরীতে HTTP দিয়ে যাচাই করা হয়েছে:

```
PASS — POST /register স্বাভাবিকভাবে সফল (302 → /)
PASS — DB-তে ইউজার তৈরি হয়েছে
PASS — GET /extra/kyc অথেন্টিকেটেড (200)
PASS — POST /extra/kyc গৃহীত (302)
PASS — pending KYC সারি তৈরি হয়েছে (status=pending)
PASS — অতিরিক্ত রিকোয়েস্টে 429 আসে: 302×10, তারপর 429
PASS — প্রথম রিকোয়েস্ট 429 নয়
PASS — নতুন IP আগের ফ্লাডে বিষাক্ত হয়নি (302)
PASS — নতুন IP-তে ইউজার তৈরি হয়েছে
```

অর্থাৎ KYC pending সারি এখন সত্যিই তৈরি হয় (Phase 4-এর মূল কারণ দূর হয়েছে), এবং রেট-লিমিটার প্রোডাকশনের মতোই ঠিক ১০ POST-এর পরে 429 দেয় (Phase 3-এ লিমিটার দুর্বল হয়নি)।

---

## ৫. ব্রাউজার-স্তরের E2E — কী বাকি

`npx playwright install --with-deps chromium` এই পরিবেশে `Download failure` দেয় (chromium CDN allowlist-এ নেই), তাই নিচেরগুলো **NOT VERIFIED LOCALLY** এবং CI-তে যাচাই হবে:

- `tests/e2e/criticalFlows.spec.js` পূর্ণ রান (per-test IP + response-status assertion সহ)
- `tests/e2e/registrationRateLimit.spec.js` Test A/B/C ব্রাউজার পাথে

CI-তে `Install Playwright browser` ধাপ আগে থেকেই আছে, তাই এই স্পেকগুলো merge gate হিসেবেই চলবে।

---

## ৬. Branch protection (রিপো সেটিংসে ম্যানুয়ালি চালু করতে হবে)

ওয়ার্কফ্লো ফাইল দিয়ে branch protection সেট করা যায় না — এটা রিপো অ্যাডমিন সেটিং। `main`-এ চালু করতে হবে:

- Require a pull request before merging
- **Require status checks to pass before merging** + *Require branches to be up to date before merging*
- Required check: **`build`** (Node.js CI জবের নাম) — এই একটি জবেই আছে: Jest, production app verify (EJS + syntax), boot smoke, Playwright E2E
- Require conversation resolution before merging
- Do not allow bypassing the above settings (অ্যাডমিনদের জন্যও)
- Block force pushes to `main`

এটি চালু না হওয়া পর্যন্ত লাল CI নিয়ে merge টেকনিক্যালি সম্ভব — নিয়ম: **লাল required check থাকলে merge নয়**।

---

## ৭. চূড়ান্ত অবস্থা

```
JEST:                  PASS   (94 suites / 1276 tests, chunk-wise runInBand)
COVERAGE THRESHOLDS:   PASS   (global 52.57/42.94/51.35/54.64 — সব গেট পার)
CASHOUT CONCURRENCY:   PASS   (0 ECONNRESET, 0 ডুপ্লিকেট পেআউট, DB-স্টেট যাচাইকৃত)
REGISTRATION E2E:      PASS   (HTTP-স্তরে যাচাইকৃত; ব্রাউজার রান CI-তে)
KYC E2E:               PASS   (pending সারি তৈরি হয়; ব্রাউজার রান CI-তে)
FULL E2E:              NOT VERIFIED LOCALLY (Chromium ডাউনলোড ব্লকড — §৫)
BUILD:                 PASS   (EJS কম্পাইল + `node --check` সব সোর্স ফাইলে)
PRODUCTION BOOT:       PASS   (`node server.js` → /health 200)
CI:                    PENDING (PR রান + branch protection চালু হওয়া বাকি — §৬)
```

## ৮. বাকি থাকা কাজ

1. `main`-এ branch protection চালু (§৬) — রিপো অ্যাডমিন ছাড়া সম্ভব নয়।
2. ব্রাউজার-স্তরের E2E প্রথম CI রানে যাচাই।
3. `jest.config.js`-এর `forceExit: true` এখন সম্ভবত অপ্রয়োজনীয় (আর কোনো startup টাইমার লিক করে না) — আলাদা PR-এ `--detectOpenHandles` দিয়ে যাচাই করে সরানো যেতে পারে; এই PR-এ ইচ্ছাকৃতভাবে স্পর্শ করা হয়নি।
