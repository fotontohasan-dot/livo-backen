# staging-এ ক্লিনআপ `--apply` প্রমাণ (নকল ডেটা দিয়ে)

**শুধু staging।** স্ক্রিপ্ট `scripts/stagingCleanupProof.js` `APP_ENV=staging` না হলে DB খোলার আগেই থামে (exit 2)।
কোনো পাসওয়ার্ড, holder_name বা DB URL ছাপা হয় না — শুধু সংখ্যা/ফ্ল্যাগ। ওয়ালেট/সেটেলমেন্ট টেবিল ছোঁয়া হয় না (নকল ইউজারের coins = 0)।

## আগে যাচাই
Render **staging** সার্ভিসের Shell-এ ঢুকে নিশ্চিত হোন: `echo "$APP_ENV"` → `staging`। না হলে থামুন।

## ধাপ (Render Shell, staging)
1. নকল ডেটা বসান: `node scripts/stagingCleanupProof.js seed`
   → ১টি নকল ইউজার (`cleanup_proof_user`) + ২টি কার্ড: ১টির `holder_name` = ওই ইউজারের পাসওয়ার্ড-সদৃশ মান, ১টি বৈধ নাম।
2. অবস্থা: `node scripts/stagingCleanupProof.js status` → অ-ফাঁকা কার্ড = 2, `must_reset_password=false`।
3. **dry-run:** `node scripts/cleanupBankCardHolderName.js` → আক্রান্ত row ≥ 1 (staging-এ আগে থেকে আক্রান্ত row থাকলে সংখ্যা তার চেয়ে ঠিক ১ বেশি হবে)।
4. **apply:** `node scripts/cleanupBankCardHolderName.js --apply` → ব্যাকআপ টেবিল তৈরি, holder_name ফাঁকা, রিসেট ফ্ল্যাগ। বৈধ-নামের কার্ড অক্ষত থাকে।
   ⚠️ এটা staging DB-র *সব* আক্রান্ত row-এ কাজ করে, শুধু নকলটিতে নয় — staging-এ আগে থেকে থাকা আক্রান্ত row-ও ব্যাকআপ হয়ে ফাঁকা হবে।
5. **আবার dry-run:** `node scripts/cleanupBankCardHolderName.js` → `আক্রান্ত row: 0`।
6. যাচাই: `node scripts/stagingCleanupProof.js status` → ফাঁকা = 1, অ-ফাঁকা = 1 (বৈধ নাম), `must_reset_password=true`।
7. **পরিষ্কার:** `node scripts/stagingCleanupProof.js cleanup`
   → নকল ইউজার/কার্ড ও ব্যাকআপ টেবিলে নকল ইউজারের row মোছে; ব্যাকআপ টেবিল খালি হলে `DROP`। অন্য (আসল staging) row থাকলে টেবিল রাখে ও সংখ্যা জানায়।
8. `status` আবার চালালে `নকল ইউজার নেই`।

## গার্ড কীভাবে কাজ করে
- `utils/stagingGuard.isStaging()`: `APP_ENV` বা `NODE_ENV` = `staging` না হলে স্ক্রিপ্ট exit 2; `require('../db')` তার পরে লোড হয়, তাই প্রোডাকশনে DB কানেকশনই হয় না।
- টেস্ট: `tests/unit/stagingCleanupProofGuard.test.js`।
- প্রোডাকশনে এই স্ক্রিপ্ট **চালাবেন না**; আসল ক্লিনআপের নিয়ম `docs/BANK_CARD_HOLDER_NAME_CLEANUP.md`-এ।
