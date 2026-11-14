# K10 — অটো-সাসপেন্ড (API ডাউনে নির্ভরশীল ফিচার নিজে বন্ধ, ঠিক হলে নিজে চালু)

কোড: `services/autoSuspend.js` · অবস্থা: Postgres `integration_suspend` (web ও worker একই দেখে) · দৃশ্যমানতা: অ্যাডমিন → Integrations Status।
**কখনো সাসপেন্ড হয় না:** `payment:*` (SSLCommerz), `wallet:*` (bKash/Nagad… callback)। এই মডিউল সেটেলমেন্ট/পেআউট/ডিপোজিট/উইথড্র/ওয়ালেট কোডে ঢোকেই না (টেস্টে সোর্স-স্তরে পাহারা আছে)।
**ফেইল-ওপেন:** DB/টেবিল সমস্যায় "সাসপেন্ড নেই" ধরা হয় — এই ফিচার নিজে সাইট বন্ধ করে না।

## ১. নির্ভরতার তালিকা (কোড দেখে)

| API (id) | কোন ফিচার নির্ভর করে | সাসপেন্ডে কী বন্ধ | কী কখনো বন্ধ হয় না |
|---|---|---|---|
| `sports:cricapi` (ম্যাচ `provider = cricket-cricapi`) | ক্রিকেট ম্যাচ/স্কোর/অডস সিঙ্ক (`matchUpdater`), ওই ম্যাচে নতুন বাজি (একক/লে `routes/matches.js`, অ্যাকুমুলেটর `services/accumulator.js`) | ওই ম্যাচগুলোতে **নতুন** বাজি → 503 `STALE_ODDS` (`suspended:true`) | চলমান বাজি, সেটেলমেন্ট (শুধু অ্যাডমিন-নিশ্চিত/fresh ডেটা, `dataFreshness`), পেআউট। হাতে-তৈরি ম্যাচ (provider NULL) প্রভাবিত নয় |
| `sports:rapidapi` (`football-rapidapi`) | ফুটবল ম্যাচ সিঙ্ক ও নতুন বাজি (একই পথ) | একই | একই |
| `casino:<প্রোভাইডার>` (যেমন `casino:db-games`; `games.provider` = নাম) | গেম ক্যাটালগ sync (`casinoGameSync`, scheduler), লবি (`/games`), গেম লঞ্চ (`/games/launch/:provider/:gameId`) | ওই প্রোভাইডারের গেমে লবিতে "সাময়িকভাবে বন্ধ" ও নতুন গেম শুরু আটকানো (লবি + লঞ্চ, demo সহ) | প্রোভাইডারের ওয়ালেট callback (`/provider/:p/bet|win|rollback|balance`, `routes/providerWallet.js`) — **কখনো গেট নেই**; অন্য প্রোভাইডার |
| `email` (SMTP) | OTP (`sendQueuedEmail('otp')`), ভেরিফিকেশন, পাসওয়ার্ড রিসেট, নতুন-ডিভাইস সতর্কতা | **কিছু বন্ধ করা হয় না** — অবস্থা ট্র্যাক ও প্রদর্শিত হয় | লগইন/OTP-তে আটকানো ইউজারকে লক-আউট করতে পারে, তাই ইচ্ছাকৃতভাবে গেট নেই (বাকি কাজ দেখুন) |
| `sms` | শুধু অ্যাডমিন থেকে SMS পাঠানো (`routes/admin.js`); ইউজার লগইন/OTP SMS-এ নয় | কিছু বন্ধ নয় (ট্র্যাক ও প্রদর্শন) | — |
| `payment:sslcommerz`, `wallet:*` | ডিপোজিট/IPN/ওয়ালেট callback | **সাসপেন্ডযোগ্য নয়** (ট্র্যাক হয় না, হাতেও বন্ধ করা যায় না) | সব |
| `telegram`, `cloudinary` | অ্যাডমিন অ্যালার্ট; ছবি আপলোড | সাসপেন্ডযোগ্য নয় | — |

## ২. সাসপেন্ড নিয়ম (সব env-এ; ডিফল্ট ব্র্যাকেটে)
সংকেত: (ক) circuit breaker **OPEN** (breaker নিজে ৫ টানা বা ≥৫০%/১০ কল/৩০s-এ খোলে), (খ) নিজস্ব উইন্ডো, (গ) বারবার 429। **একটা ব্যর্থতায় নয়।**

| env | মানে |
|---|---|
| `AUTO_SUSPEND_ENABLED` (true) | `false` = অটো সাসপেন্ড/রিজিউম বন্ধ (হাতের নিয়ন্ত্রণ চলে) |
| `AUTO_SUSPEND_CONSECUTIVE_FAILURES` (5) | টানা ব্যর্থতা (১০ মিনিটের বেশি ফাঁকে নয়: `AUTO_SUSPEND_CONSECUTIVE_MAX_AGE_MS`=600000) |
| `AUTO_SUSPEND_WINDOW_MS` (60000), `AUTO_SUSPEND_ERROR_RATE` (0.5), `AUTO_SUSPEND_MIN_REQUESTS` (10) | উইন্ডোতে ব্যর্থতার হার |
| `AUTO_SUSPEND_RATE_LIMIT_HITS` (3) | উইন্ডোতে 429 সংখ্যা |
| `AUTO_SUSPEND_ON_BREAKER_OPEN` (true) | breaker OPEN-কে সংকেত ধরা |
| `AUTO_SUSPEND_RESUME_SUCCESSES` (3) | নিজে খুলতে টানা সফল কল |
| `AUTO_SUSPEND_MIN_SUSPEND_MS` (120000) | ন্যূনতম বন্ধ থাকার সময় (flapping ঠেকাতে) |
| `AUTO_SUSPEND_CACHE_TTL_MS` (5000), `AUTO_SUSPEND_PROBE_INTERVAL_MS` (120000 = ২ মিনিট) | ক্যাশ; probe-র ন্যূনতম ব্যবধান |

**ব্যর্থতা গোনা হয় শুধু:** টাইমআউট, নেটওয়ার্ক ত্রুটি, HTTP 5xx ও 429। **4xx গোনা হয় না** — ব্যর্থতাও না, সফলতাও না (আগে 4xx "সফল" ধরে ব্যর্থতার ধারা শূন্য করত ও নিজে-চালুর গণনায় যোগ হতো)। `Retry-After` হেডার মানা হয় না। **K9:** আলাদা রেট-লিমিট "থামার" মডিউল এই রিপোতে পাইনি; তাই 429 সরাসরি গোনা হয়। K9 এলে `autoSuspend.recordOutcome(name, false, { rateLimited: true })` ডাকলেই হবে।

## ৪. নিজে চালু হওয়া
auto-সাসপেন্ডের পর: টানা `RESUME_SUCCESSES` সফল কল **এবং** `MIN_SUSPEND_MS` পেরোনো **এবং** ওই প্রসেসের breaker closed (half-open→closed) → চালু; মাঝে ব্যর্থতা এলে ধারা শূন্য। খোলার পর ট্র্যাকার শূন্য থেকে শুরু (১টা ব্যর্থতায় আবার বন্ধ নয়)। হাতে বন্ধ করলে কখনো নিজে খোলে না। সফল কল আসে সাধারণ sync থেকে এবং worker-এর `integration_suspend_probe` জব (১ মিনিট; শুধু অটো-সাসপেন্ড থাকা **ক্যাসিনো** প্রোভাইডারে হালকা `fetchGames`)। স্পোর্টস সফল কল আসে ম্যাচ sync থেকে (ডিফল্ট ~১৫ মিনিট) — দ্রুত চাইলে অ্যাডমিন হাতে রিজিউম করুন।

## ৫. দৃশ্যমানতা
- অ্যাডমিন → Integrations Status: প্রতিটা API-র সাসপেন্ড অবস্থা, কখন থেকে, কেন (breaker/টানা ব্যর্থতা/হার/429/হাতে), মোট সাসপেন্ড সংখ্যা। বোতাম শুধু `system_diagnostics_manage` অনুমতিতে (নতুন; `system_diagnostics_view` যথেষ্ট নয়); প্রতিটা সাসপেন্ড/রিজিউম `admin_logs`-এ (`INTEGRATION_SUSPENDED/RESUMED`)।
- ইউজার বার্তা (bn/en): `auto_suspend_sports_msg`, `auto_suspend_casino_msg`, `auto_suspend_badge`।
- মেট্রিক্স: `bet420_integration_suspended{name,source}`, `bet420_integration_suspended_seconds{name}`, `bet420_integration_suspend_count{name}`; অ্যালার্ট প্রস্তাব `docs/ALERTS.md` #17–18। অবস্থা বদলালে সার্ভার লগে `[auto-suspend]` লাইন (কোনো সিক্রেট নয়)।

## ৩ (শেষ অংশ). চলমান ক্যাসিনো গেম/রাউন্ডে প্রোভাইডার ডাউন হলে কী হয় (কোড দেখে)
ওয়ালেট **seamless**: প্রোভাইডার আমাদের কাছে `bet` (ডেবিট) → `win` (ক্রেডিট) / `rollback` (ফেরত) পাঠায় (`services/wallet/index.js`, `routes/providerWallet.js`)। আমরা প্রোভাইডারকে আউটবাউন্ড কল করি না।
- **এই সিস্টেম কিছু বদলায় না:** সাসপেন্ডে callback গেট নেই; প্রোভাইডার ফিরলে `win`/`rollback` স্বাভাবিক চলে (idempotent; রোলব্যাক দুবার ফেরত দেয় না; ডেবিট ছাড়া রাউন্ডের rollback নিরীহ no-op)।
- ⚠️ **টাকা আটকানোর ঝুঁকি আছে (বিদ্যমান, K10 থেকে নয়):** প্রোভাইডার `bet` পাঠানোর পর ডাউন হয়ে `win`/`rollback` না পাঠালে ইউজারের ডেবিট হওয়া স্টেক ফেরত না আসা পর্যন্ত আটকে থাকে। কোডে এমন "পড়ে থাকা রাউন্ড" টাইমআউটে স্বয়ংক্রিয় রিফান্ড/রিকনসিলিয়েশন জব **নেই** (`provider_transactions`-এ `bet` completed থাকে)। আমি নিজে সমাধান বানাইনি — মালিকের সিদ্ধান্ত দরকার (যেমন নির্ধারিত সময় পর প্রোভাইডারের রাউন্ড-স্ট্যাটাস API দিয়ে যাচাই, বা অ্যাডমিন-রিভিউ তালিকা)।
- ইউজার লঞ্চ-পাতা (`game_sessions`, ১২০ মিনিট) ওয়ালেটে প্রভাব ফেলে না।

## বাকি / সীমাবদ্ধতা
- `email`/`sms` গেট নেই (লক-আউট ঝুঁকি); চাইলে শুধু "রিসেন্ড"/নোটিফিকেশন পাথে নরম গেট বসানো যায়।
- `sports:*` probe আছে (`sportsAPI.probeCricket/probeFootball`: শুধু-পড়া GET, ক্যাশ-বাইপাস, ক্যাশ/DB-তে লেখে না; শুধু সাসপেন্ড থাকা অবস্থায় প্রতি ২ মিনিটে একবার — কোটা-ভিত্তিক API-তে সাসপেন্ড চলাকালীন সর্বোচ্চ ৩০ কল/ঘণ্টা); ক্যাসিনো probe `fetchGames` ডকুমেন্টেশন-নিশ্চিত নয় (`TODO(DB-DOC)`)।
- সীমা প্রতি-প্রসেসে গোনা হয় (web/worker আলাদা ট্র্যাকার); অবস্থা শেয়ার্ড। K9 নেই (উপরে)।

## অনুমতি: system_diagnostics_manage
শুধু `super_admin` রোলে। migration অন্য সব রোল থেকে এটি সরায় (idempotent), আর রোল তৈরি/সম্পাদনা/ক্লোন/bulk/import — সব পথে `rbac.stripSuperAdminOnly` অন্য রোলে বসতে দেয় না। দ্রষ্টব্য: `role_key` NULL থাকা পুরোনো `role='admin'` ইউজার বিদ্যমান নিয়মে super_admin-সমতুল্য (services/rbac.js) — তারাও এটি পায়। রোল ক্যাশ TTL ৩০ সেকেন্ড।
