# Turnover System V2 — Migration Plan & Test Report

## ১. কী বদলেছে
- `services/turnover.js` সম্পূর্ণ নতুন: Deposit-ভিত্তিক, `deposit_turnovers` টেবিলে (প্রতি Deposit আলাদা সারি)।
- বোনাস নিলে `(Deposit + Bonus) × turnover_multiplier`; না নিলে `Deposit × turnover_no_bonus_multiplier (১)`।
- Sports টার্নওভার বেট **settle** হওয়ার পর (জিতুক/হারুক) `services/settlement.js` ও acca settlement থেকে যোগ হয়; Casino বেট ঘটনার সময় (tx id দিয়ে ডুপ্লিকেট-প্রতিরোধ)।
- Void / Cancelled / Refund গোনা হয় না; Cash-out ডিফল্টে গোনা হয় না; Sports-এ `turnover_min_odds` প্রযোজ্য (odds অজানা হলে গোনা হয় না — fail-closed)।
- ১০০% হলে সারি `completed` হয় → উইথড্র লক নিজে থেকে খোলে। `turnover_expiry_hours > 0` হলে মেয়াদ শেষে সারি `expired`, বোনাস অংশ (ব্যালেন্সে যতটুকু আছে) কাটা, লক খোলে।
- Admin → Settings: `turnover_multiplier`, `turnover_no_bonus_multiplier`, `turnover_min_odds`, `turnover_expiry_hours`, `turnover_cashout_counts`।
- Dashboard (withdraw পপআপ + `GET /payment/withdraw/turnover-status`): Required / Completed / Remaining / Percent, Sports ও Casino আলাদা।
- Backend সুরক্ষা: `turnover_events UNIQUE(user_id, ref)` (ডুপ্লিকেট settlement), `UNIQUE(deposit_id)`, row-lock + অ্যাটমিক ইনক্রিমেন্ট, উইথড্র গেট fail-closed (আগের মতোই)।

## ২. পুরোনো ডেটা (অনুমোদন ছাড়া কিছু মোছা/বদলানো হয়নি)
- পুরোনো `bonuses` টেবিল **অক্ষত** (আর্কাইভ)। নতুন কোড সেটা আর পড়ে/লেখে না, তাই পুরোনো ও নতুন সিস্টেম একসাথে সক্রিয় থাকে না।
- ⚠️ ফলাফল: যেসব ইউজারের পুরোনো `bonuses.status='active'` আছে, তাদের উইথড্র লক Deploy-র পর আর পুরোনো সারি থেকে আসবে না।
  Deploy-র আগে সিদ্ধান্ত নিন (এই স্ক্রিপ্ট **চালানো হয়নি**, আপনার অনুমোদন লাগবে):
  ```sql
  -- বাকি থাকা active পুরোনো বোনাসকে নতুন সিস্টেমে তুলে আনা (পুরোনো সারি অপরিবর্তিত)
  INSERT INTO deposit_turnovers (user_id, source, deposit_amount, bonus_amount, multiplier, required, sports_done, casino_done, status)
  SELECT user_id, bonus_type, 0, bonus_amount, 1, GREATEST(sports_required, casino_required),
         sports_done, casino_done, 'active'
  FROM bonuses WHERE status = 'active';
  ```
- Admin → Bonuses পেজ (`routes/admin.js` `bonuses` cancel) পুরোনো টেবিলেই থাকে; নতুন সিস্টেমে এখনো admin UI নেই (Settings থেকে নিয়ম নিয়ন্ত্রণ আছে)।

## ৩. ধরে নেওয়া ডিফল্ট (আপনার স্ক্রিপ্টে মান ছিল না — Admin থেকে বদলানো যাবে)
| সেটিং | ডিফল্ট |
|---|---|
| turnover_multiplier (বোনাসসহ) | ৩ (DB-তে আগে থেকে সেট থাকা মান; নতুন DB-তে migration-এর ৩) |
| turnover_no_bonus_multiplier | ১ |
| turnover_min_odds | ১.৫ |
| turnover_expiry_hours | ০ (মেয়াদ নেই) |
| turnover_cashout_counts | ০ (গোনা হয় না) |

## ৪. পরিচিত সীমাবদ্ধতা
- Casino provider `rollback` (বেট বাতিল) হলে আগে গোনা টার্নওভার ফেরত নেওয়া হয় না (Casino বেট ঘটনার সময় গোনা হয়)।
- উইথড্র লক পুরো উইথড্র আটকায় (ইউজারপ্রতি), Deposit-ভিত্তিক আংশিক উইথড্র নয়।
- Sports Cash-out ফিচার কোডবেসে নেই; নিয়মটি সেটিং হিসেবে প্রস্তুত।

## ৫. টেস্ট রিপোর্ট
- Unit (DB ছাড়া, fake client) — `tests/unit/turnoverV2.test.js`: ফর্মুলা (বোনাস/বিনা বোনাস/admin multiplier), Void/Cancelled/Refund, Cash-out, min odds, Casino, ডুপ্লিকেট ref, একাধিক Deposit FIFO — **পাস**।
- `tests/security/turnoverIntegrity.test.js` — **পাস**।
- ❌ **Staging-এ চালানো হয়নি** এবং DB-নির্ভর integration টেস্ট (`referralBonusLock` ইত্যাদি, Postgres/Redis লাগে) এই পরিবেশে চালানো যায়নি। Staging পরীক্ষা ও Production Deploy আপনার অনুমতির অপেক্ষায়।
