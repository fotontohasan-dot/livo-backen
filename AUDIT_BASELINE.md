# AUDIT_BASELINE.md

Phase 0 — বেসলাইন। এই ধাপে **কোনো অ্যাপ্লিকেশন কোড পরিবর্তন করা হয়নি**; শুধু
বর্তমান অবস্থা যাচাই করা হয়েছে এবং অডিট ফাইন্ডিংগুলো কোডের বিপরীতে মিলিয়ে দেখা হয়েছে।

## রিপোজিটরি অবস্থা

| বিষয় | মান |
|---|---|
| Repository | `fotontohasan-dot/livo-backen` |
| Baseline branch | `main` |
| Baseline HEAD | `b84a26cc3534b91496bb3ad1781cf53d2504b99f` |
| HEAD subject | Merge pull request #91 (theme contrast fix) |
| Working tree | clean (এই ফাইল যোগ করার আগে) |

## কমান্ড

| উদ্দেশ্য | কমান্ড | মন্তব্য |
|---|---|---|
| Production start | `node app.js` | Express + EJS |
| Dev | `nodemon app.js` | |
| Test | `cross-env NODE_ENV=test jest --runInBand --coverage` | |
| Build | `next build` | **অ্যাপের রানটাইম Express, কিন্তু build স্ক্রিপ্ট Next.js** |

## CI

`.github/workflows/node.js.yml` — তিনটি ধাপ: `npm ci --legacy-peer-deps` → `npm test` → `npm run build`।

- Playwright E2E (`tests/e2e/criticalFlows.spec.js`) CI-তে চলে না
- `coverageThreshold` কোথাও কনফিগার করা নেই (`jest.config*` / `package.json` — পাওয়া যায়নি)
- Build step আসল প্রোডাকশন আর্টিফ্যাক্ট নয়

---

## ফাইন্ডিং যাচাই

নিচের প্রতিটি কোডে সরাসরি মিলিয়ে দেখা হয়েছে। **CONFIRMED** = সমস্যা এখনো বিদ্যমান।

### CONFIRMED — P0

| # | ফাইন্ডিং | প্রমাণ |
|---|---|---|
| 1 | Backup GitHub-এ যায় | `services/backup.js:37,59,138` — `api.github.com/repos/${GITHUB_REPO}/contents/${BACKUP_PATH}` |
| 2 | Reset/verify URL-এ Host header | `routes/auth.js:319`, `routes/profile.js:983,992,1210,1214`, `routes/payment.js:886` — `req.get('host')` |
| 4 | Auth fail-open | `middleware/auth.js:37-41` — DB error হলে `{ exists: true, banned: false, checkFailed: true }` রিটার্ন |
| 5 | DB TLS verification বন্ধ | `db.js:20,24` — production সহ সব পথে `{ rejectUnauthorized: false }` |

### CONFIRMED — P1

| # | ফাইন্ডিং | প্রমাণ |
|---|---|---|
| 8 | Casino ledger অসামঞ্জস্য | `routes/games.js:347,359,364` — ব্যালেন্স বদলায় `netChange`, কিন্তু লেজারে লেখা হয় `game_play(netChange)` **এবং** `casino_bet(-betAmount)`। যোগফল = `netChange − betAmount`, অর্থাৎ লেজার প্রকৃত ব্যালেন্স-পরিবর্তনের চেয়ে `betAmount` কম দেখায়। কোডের কমেন্ট দাবি করছে ইনভেরিয়েন্ট রক্ষা হয়েছে — হয়নি। Aviator পথ (`:297,312`) ঠিক আছে, কারণ সেখানে ব্যালেন্স আর লেজার দুটোই `−betAmount`। |
| 10 | জেনেরিক গেম সেটেলমেন্ট | `routes/games.js:341` — handler না থাকলে `secureRandom.chance(0.45) ? betAmount * 2 : 0` |
| 14 | Rejected transaction ID পুনঃব্যবহার | `routes/payment.js:263,287` — uniqueness শর্ত `status != 'rejected'` |
| 32 | Maintenance mode রিস্টার্টে রিসেট | `migrations.js:667-670` — `ON CONFLICT (key) DO UPDATE SET value = 'false'`। অন্য সব সেটিং `DO NOTHING` ব্যবহার করে, শুধু এটাই জোর করে `false` বসায়। |
| 34 | Fraud scan আসলে চলে না | `services/scheduler.js:89-103` — জব নিজেই `'স্কিপ করা হয়েছে...'` রিটার্ন করে |
| 43 | Service worker প্রাইভেট পেইজ ক্যাশ করে | `public/service-worker.js:88` — শুধু `/admin`, `/api`, `/socket.io` বাদ; `/profile`, `/wallet`, `/history`, `/kyc` ক্যাশ হয় |
| 44 | CSRF টোকেন cross-origin-এও যায় | `views/partials/head.ejs:100,114` — same-origin চেক নেই |
| 49-51 | CI gap | উপরের CI সেকশন দ্রষ্টব্য |

### আংশিক — আগেই ঠিক হয়েছে

| # | অবস্থা |
|---|---|
| 9 | Cashout ordering **ঠিক হয়ে গেছে**। `routes/games.js:417-450` — `settled_at` এখন atomic claim (`WHERE settled_at IS NULL ... RETURNING`), এরপর multiplier যাচাই। ডাবল-ক্যাশআউট বন্ধ। তবে রিপোর্টের একটা অংশ এখনো সত্য: premature multiplier claim হলে রাউন্ড settled হয়েই থাকে, retry সম্ভব নয় — কোডে এটি ইচ্ছাকৃত বলে ডকুমেন্ট করা। |

### যাচাই বাকি

3, 6, 7, 11-13, 15-31, 33, 35-42, 45-48, 52-55 — এখনো কোডে মিলিয়ে দেখা হয়নি।

---

## পরের ধাপের অগ্রাধিকার

আর্থিক ও ডেটা-এক্সপোজার ঝুঁকি আগে:

1. **#1** — backup GitHub-এ পাঠানো বন্ধ (ডেটা লিক)
2. **#5** — production DB TLS verification চালু
3. **#2** — `PUBLIC_APP_URL` কনফিগার করে Host header নির্ভরতা বাদ
4. **#4** — auth fail-closed
5. **#8** — ledger ইনভেরিয়েন্ট ঠিক করা + regression test
6. **#32** — maintenance mode persist
7. **#43**, **#44** — PWA cache ও CSRF scope

প্রতিটি ফিক্স আলাদা কমিটে, regression test সহ, আলাদা PR হিসেবে যাবে।
