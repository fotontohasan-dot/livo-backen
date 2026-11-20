# বাজির ওপর ৩-ধাপ রেফারেল কমিশন বন্ধ + First Deposit Bonus concurrency পরীক্ষা

## কাজ ১ — কী বদলেছে
- `services/settings.js` DEFAULTS: `referral_commission_tier1/2/3_percent` = `0` (আগে 2.5/1.5/0.8)।
- `services/referral.js`: `DEFAULT_COMMISSION_RATES = [0,0,0]`; `distributeCommission` তিন হারই ০ হলে ট্রানজ্যাকশন না খুলেই ফেরে → কমিশন-সারি/ব্যালেন্স যোগ নেই।
- `migrations.js`: নতুন DB-তে tier1/2/3 = `'0'` সিড (`ON CONFLICT DO NOTHING` — বিদ্যমান সেভ-করা মান অপরিবর্তিত)।
- আগে থেকেই মাস্টার সুইচ `referral_bet_commission_enabled` (সিড `false`) ছিল; সেটা অপরিবর্তিত।

## বিদ্যমান DB-তে যেখানে বদলাতে হবে (migration দিয়ে জোর করে বদলানো হয়নি)
প্রোডাকশন/স্টেজিং `site_settings` টেবিলে (অ্যাডমিন পরিবর্তন করে থাকলে সেই মান থাকবে):
```sql
SELECT key, value FROM site_settings WHERE key IN
 ('referral_commission_tier1_percent','referral_commission_tier2_percent','referral_commission_tier3_percent','referral_bet_commission_enabled');
-- দরকারে ম্যানুয়ালি (অনুমোদন নিয়ে): UPDATE site_settings SET value='0' WHERE key LIKE 'referral_commission_tier%_percent';
```
`referral_bet_commission_enabled` `false` থাকলেও কমিশন যায় না; ০/০/০ হলে সুইচ `true` হলেও যায় না।

## ইউজার/অ্যাডমিন UI-তে ৩-ধাপ কমিশনের উল্লেখ (বদলানো হয়নি)
- `locales/bn.json` ও `locales/en.json` — `ref_tagline` (লাইন ~2438): "…আজীবন কমিশন (২.৫% / ১.৫% / ০.৮%)"; ইউজারের `views/profile/referral.ejs:74` এ দেখায়।
- একই দুই ফাইলে `referral_terms` (লাইন ~648): একই টেক্সট (বর্তমানে কোনো view-এ ব্যবহার পাওয়া যায়নি)।
- `views/profile/referral.ejs:186` ও locale `ref_commission` ("কমিশন (লেভেল {level})"): ইতিহাসে পুরোনো লেভেল-কমিশন সারি দেখাতে।
- অ্যাডমিন: `routes/admin.js` (`SETTING_KEYS` ~1085, ভ্যালিডেশন ~1238) tier কী গ্রহণ করে, কিন্তু `views/admin/settings.ejs`-এ tier১/২/৩-এর ইনপুট ফিল্ড নেই (শুধু ডিপোজিট-হার কমিশন ০.৮%)।
- নোট: `referral_loss_commission_percent` (০.৮%, ডিপোজিট সম্পূর্ণ হারলে) আলাদা বিদ্যমান ব্যবস্থা — এই কাজে স্পর্শ করা হয়নি।
- ডক: `docs/REFERRAL_CURRENT_STATE.md`, `docs/REFERRAL_V2_DESIGN.md` পুরোনো ২.৫/১.৫/০.৮ উল্লেখ করে।

## কাজ ২ — First Deposit Bonus concurrency (ফিক্স নয়, শুধু পরীক্ষা)
টেস্ট: `tests/integration/firstDepositBonusConcurrent.test.js` — একই ইউজারের দুটি pending (want_bonus) ডিপোজিট `approvePaymentRequestById` দিয়ে `Promise.all`-এ ১২ ট্রায়াল।
- ফল: **পাস** — প্রতি ট্রায়ালে বোনাস `[1000, 800]` (একটি ১০০%, অন্যটি শুক্রবার ৮০%); দুটো ১০০% কখনো নয়।
- কারণ: `creditApprovedDeposit`-এ `UPDATE users SET coins=…` (ইউজার-সারি লক) বোনাস-হার পড়ার (`approvedDepositCount`) আগে চলে, ফলে দ্বিতীয় ট্রানজ্যাকশন প্রথমটির COMMIT পর্যন্ত অপেক্ষা করে এবং কমিট-হওয়া approved ডিপোজিট দেখে।
- টেস্ট ফাঁকা নয় তার প্রমাণ: /tmp-এ কোডের কপিতে (কমিটে নেই) count-পড়া লকের আগে আনলে ১২/১২ ট্রায়ালে `[1000,1000]` → টেস্ট ফেল।
- ঝুঁকি (ফিক্স নয়, প্রস্তাব): সুরক্ষাটা অন্তর্নিহিত — কেউ ক্রম বদলালে/লক সরালে ফেটে যাবে। প্রস্তাবিত: count পড়ার আগে স্পষ্ট `SELECT id FROM users WHERE id=$1 FOR UPDATE` (বা `pg_advisory_xact_lock(user_id)`) বসানো। এই টেস্ট সেটা পাহারা দেবে।
