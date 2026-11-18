# Referral V2 — অডিট ও ডিজাইন (শুধু ডক, কোনো ফিচার কোড নেই)

ভিত্তি: `release/staging-batch-1` @ eec3bc96। পরিধি: referral, bonus, deposit, wagering, admin, migrations ও সংশ্লিষ্ট টেস্ট।
**অবস্থা: ৯ নং ধারা অনুযায়ী সংঘর্ষ পাওয়া গেছে — বাস্তবায়ন থামানো হয়েছে, PM সিদ্ধান্ত দরকার।**

## ১) টেবিল / কলাম / ইনডেক্স / কনফিগ
- `users`: `referral_code UNIQUE`, `referred_by_id → users`, `first_deposit_done` (বুলিয়ান, ব্যবহার অস্পষ্ট), `total_deposited NUMERIC(14,2)`, `coins`।
- `referrals` (migrations.js ~১৪০০): `id, referrer_id, referred_id, first_deposit_done, signup_bonus_paid, created_at`; **UNIQUE(referred_id)**; ইনডেক্স `idx_ref_referrer`, `idx_ref_referred`। কোনো status/tier/amount/deposit_id/reviewer কলাম নেই।
- `referral_commissions` (`earner_id, from_user_id, level, amount, reason, created_at`; ইনডেক্স earner_id): প্রথম-ডিপোজিট বোনাস (`level=0, reason='signup'`) ও ৩-লেভেল বেট-কমিশন একই টেবিলে মেশানো। **UNIQUE নেই।**
- `referral_contest_payouts` (UNIQUE(contest_month, rank)) — আলাদা কনটেস্ট, এই কাজের বাইরে।
- `bonuses` (`bonus_type, bonus_amount INTEGER, sports_required/done, casino_required/done, status`) — রেফারেল বোনাসের ওয়েজারিং এখানে (`bonus_type='referral'`)। `coin_transactions` লেজার, `notifications`।
- কনফিগ: টিয়ার মান ও ন্যূনতম ৫০০ **হার্ডকোড** (`services/referral.js`: `signupBonusFor()`, `MIN_DEPOSIT_FOR_BONUS`)। শুধু কমিশন % settings-এ (`referral_commission_tier{1,2,3}_percent`, `services/settings.js`)। ওয়েজারিং হার্ডকোড `services/turnover.js` RULES: `referral {sports:3, casino:0}`; `deposit {sports:5 (setting turnover_multiplier), casino:35}`।

## ২) বর্তমানে রেফারেল বোনাস
- সাইন-আপে নয়। `createReferral` শুধু সারি বানায় (ON CONFLICT DO NOTHING)।
- ডিপোজিটে: `processReferralDeposit(client, referredUserId, amount)` — `amount >= 500` হলে `UPDATE referrals SET signup_bonus_paid=true WHERE referred_id=$1 AND signup_bonus_paid=false` (atomic claim), তারপর টিয়ার = `COUNT(signup_bonus_paid=true)`।
- রেফার-করা ইউজার রেফারেল থেকে কিছু পায় না (আলাদা রেফারেল বোনাস নেই) — শুধু First Deposit Bonus (§৪)। ✔ নিয়মের সঙ্গে মেলে।
- টিয়ার মান বিদ্যমান: ১=১০০, ২–৫=২০০, ৬–১৫=৪০০, ১৬–৫০=৮০০, ৫১+=১৫০০ ✔ (সীমানা মেলে)।

## ৩) ডিপোজিট নিশ্চিত হওয়ার পথ
সবগুলো শেষে একই ফাংশন `creditApprovedDeposit(client, request)` (routes/payment.js ~৮২৩) — ভেতরে `processReferralDeposit` ডাকা হয়। তাই **একক হুক সম্ভব ও ইতিমধ্যে বিদ্যমান**।
| পথ | স্থান |
|---|---|
| অ্যাডমিন অনুমোদন (একক) | routes/admin.js ~১৮৩৫ → `creditApprovedDeposit` |
| অ্যাডমিন অনুমোদন (payment রুট/বাল্ক) | `approvePaymentRequestById` (payment.js ~৮৬৯, FOR UPDATE) |
| SSLCommerz success redirect | payment.js ~১০৮৭ (`/sslcommerz/success`) |
| SSLCommerz IPN | payment.js ~১২১১ (`/sslcommerz/ipn`) |
| bKash/Nagad/Rocket/Upay wallet callback | routes/walletCallback.js → `services/walletCallback.js reconcile()` |
| Gateway reconcile (scheduler) | services/gatewayReconcile.js ~৮৫ |
সবগুলোতে `SELECT ... FOR UPDATE` + `status='pending'` গার্ড আছে।
**রিভার্সাল/বাতিল:** শুধু pending→rejected (`rejectPaymentRequestById`, gateway fail/cancel)। **approved ডিপোজিট রিভার্স করার কোনো পথ নেই** (কোড/স্ট্যাটাস/রেফারেল অ্যাডজাস্টমেন্ট কিছুই নেই)।

## ৪) First Deposit Bonus
`creditApprovedDeposit`-এর ভেতরে, `request.want_bonus` হলে (ইউজার-অপ্ট-ইন): `bonusPercentFor(approvedCountBefore, isFriday)` (১ম=১০০%, শুক্র=৮০%, অন্য=৫০%, MAX 15000) → `coins` + `coin_transactions('deposit_bonus')` + `createBonus('deposit')`। রেফারেল কোড থেকে পুরোপুরি আলাদা কলাম/টেবিল/ওয়েজারিং — **সরাসরি সংঘর্ষ নেই**। ঝুঁকি: দুটোই একই ট্রানজ্যাকশনে; `processReferralDeposit` ভেতরে সব exception গিলে ফেলে (নিচে সংঘর্ষ ৫)।

## ৫) জালিয়াতি-শনাক্তকরণ — যা আছে/নেই
আছে: `login_logs(ip, device_fingerprint)`, `device_sessions(device_signature, browser, os)`, `bank_cards.account_number`, `payment_requests.account_number`; `duplicateDetection` ওজন: device 40, ip 25, browser 15, payment 35 (রেফারেল গেট ≥৫০)।
নেই: **ফোন-মিল সিগন্যাল** (duplicateDetection-এ phone নেই), রেফারার↔রেফার্ড সরাসরি তুলনা, পুরোনো ডেটায় ডিভাইস না থাকলে মিল।

## ৬) পরিমাণ ও মুদ্রা
`payment_requests.amount NUMERIC(14,2)` = স্টোর-কারেন্সি **BDT**; গেটওয়ে যাচাই `paymentVerification.amountMatchesRequest` (amount, `currency_amount` নয়) ও `isExpectedCurrency` (BDT)। ব্যালেন্স ১:১ কয়েন (`users.coins += amount`)। **৫০০ = ৫০০ BDT = `payment_requests.amount`-এর মান** (কয়েন-এককও একই)। বোনাস `bonuses.bonus_amount INTEGER`।

## ৭) বিদ্যমান ডেটা
**যাচাই করা হয়নি** — ডাটাবেসে সংযোগ নেওয়া হয়নি (স্টেজিং/প্রোডে রিড-অ্যাক্সেস নেই)। রান করার কোয়েরি:
```sql
SELECT COUNT(*) FILTER (WHERE signup_bonus_paid) AS paid,
       COUNT(*) FILTER (WHERE first_deposit_done AND NOT signup_bonus_paid) AS first_dep_not_paid,
       (SELECT COUNT(*) FROM bonuses WHERE bonus_type='referral' AND status='pending_review') AS pending_review
FROM referrals;
```
নিয়ম: এই paid সারিগুলো V2 backfill-এ `legacy_paid` — কোনো retroactive বোনাস নয়।

## ৮) প্রস্তাবিত স্কিমা (ডিজাইন মাত্র, বাস্তবায়িত নয়)
```sql
CREATE TABLE referral_rewards (
  id BIGSERIAL PRIMARY KEY,
  referrer_id INTEGER NOT NULL REFERENCES users(id),
  referred_user_id INTEGER NOT NULL REFERENCES users(id),
  referral_id INTEGER REFERENCES referrals(id),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending_review','paid','rejected','fraud','reversed','legacy_paid')),
  tier SMALLINT, amount INTEGER NOT NULL DEFAULT 0,
  qualifying_deposit_id INTEGER REFERENCES payment_requests(id),
  risk_score INTEGER, risk_signals JSONB,
  reviewed_by INTEGER REFERENCES users(id), reviewed_at TIMESTAMPTZ, reason TEXT,
  paid_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT referral_rewards_referred_uniq UNIQUE (referred_user_id)
);
CREATE INDEX ON referral_rewards (referrer_id, status);
CREATE TABLE referral_reward_adjustments (  -- রিভার্সাল অডিট ট্রেইল, কোনো ডিলিট নয়
  id BIGSERIAL PRIMARY KEY, reward_id BIGINT NOT NULL REFERENCES referral_rewards(id),
  kind VARCHAR(20), amount INTEGER, note TEXT, created_by INTEGER, created_at TIMESTAMPTZ DEFAULT NOW());
```
- Migration: শুধু `CREATE TABLE/INDEX IF NOT EXISTS` (additive); পুরোনো `referrals`/`referral_commissions` অপরিবর্তিত; backfill `legacy_paid`। Rollback: `DROP TABLE referral_reward_adjustments, referral_rewards` — পুরোনো কোড এগুলো পড়ে না, তাই নিরাপদ।
- কনফিগ: টিয়ার তালিকা ও ন্যূনতম পরিমাণ settings-এ (`referral_min_deposit`=500, `referral_tiers` JSON, ডিফল্ট = বর্তমান মান)।
- লক: ট্রানজ্যাকশনের শুরুতে `pg_advisory_xact_lock(hashtext('referral:'||referrer_id))` (অথবা `SELECT ... FROM users WHERE id=referrer FOR UPDATE`); তারপর `paid` গণনা → টিয়ার → `INSERT referral_rewards ... ON CONFLICT (referred_user_id) DO NOTHING` → কয়েন/লেজার/bonuses — সব একই ট্রানজ্যাকশনে।
- অ্যাডমিন পাতা: রিওয়ার্ড তালিকা (ফিল্টার status/referrer), pending_review কিউ (approve/reject + কারণ), রিভার্সাল রিভিউ, টিয়ার/ন্যূনতম সেটিংস। ইউজার পাতা: রেফারেল স্ট্যাটাস (pending/paid), পরবর্তী টিয়ার, ইতিহাস।

## ৯) সংঘর্ষ / ঝুঁকি (থামার কারণ)
1. **জালিয়াতি গেট কার্যত মৃত**: `processReferralDeposit` ডাকে `evaluateDuplicateAccount(referredUserId, {})` — ip/device/browser/accountNumber কিছুই পাঠায় না, ফলে সব finder খালি → কখনো flag হয় না। ফোন-মিল নেই। (নিয়ম: সন্দেহজনক → pending_review।)
2. **pending_review ভাঙা**: flagged হলেও `signup_bonus_paid=true` সেট হয়, `referral_commissions` ও `coin_transactions('referral_bonus')` সারি লেখা হয় (কয়েন না গেলেও), এবং ওই সারি টিয়ার গণনায় ঢোকে। অ্যাডমিন রিলিজ পথ কোথাও নেই (`bonuses.status='pending_review'` কেউ `active` করে না)। নিয়ম: pending গোনা নয়, অনুমোদনের আগে paid নয়।
3. **টিয়ার রেস**: একই রেফারারের দুই ভিন্ন রেফার্ড একসাথে ডিপোজিট করলে রেফারার-স্তরে লক নেই → একই টিয়ার/গণনা পড়তে পারে। শুধু `referred_id` স্তরে exactly-once আছে।
4. **রিভার্সাল পথ অনুপস্থিত**: approved ডিপোজিট রিভার্স হলে রেফারেল বোনাস সমন্বয়ের কোনো ব্যবস্থা নেই।
5. **error-swallow**: `processReferralDeposit` নিজের try/catch-এ ত্রুটি গিলে ফেলে, অথচ চলে কলারের ট্রানজ্যাকশনে — Postgres-এ ব্যর্থ স্টেটমেন্টের পর ট্রানজ্যাকশন aborted হয়; তখন পরের `UPDATE payment_requests` ব্যর্থ হয় ও পুরো ডিপোজিট রোলব্যাক হতে পারে (বা নীরবে বোনাস হারায়)।
6. **অডিট ট্রেইল অপর্যাপ্ত**: tier/status/qualifying_deposit/reviewer নেই; `referral_commissions` UNIQUE নেই; টিয়ার ও ন্যূনতম হার্ডকোড (নিয়মে কনফিগযোগ্য)।
7. **কপি অসঙ্গতি**: promo popup seed-এ "প্রতিটি বন্ধুর প্রথম ডিপোজিটে ৫০০ টাকা" — প্রকৃত টিয়ারের (১০০–১৫০০) সঙ্গে মেলে না (migrations.js ~১৪৩৮)।
**সিদ্ধান্ত দরকার (PM):** (ক) ফোন-মিল সিগন্যাল কোন উৎস থেকে (users.phone) এবং রেফারার↔রেফার্ড তুলনা চাই কি; (খ) পুরোনো pending_review বোনাসের (থাকলে) পরিণতি; (গ) approved ডিপোজিট রিভার্সালের ট্রিগার (অ্যাডমিন বাটন? গেটওয়ে চার্জব্যাক?) কে সংজ্ঞায়িত করবে।
