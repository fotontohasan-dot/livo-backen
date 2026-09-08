# Go-Live চেকলিস্ট (PHASE 5)

ক্যাসিনো প্রোভাইডার ও টিকেট মডিউল লাইভে নেওয়ার আগে এই তালিকাটা ক্রম
অনুসারে শেষ করুন। প্রতিটা আইটেমের পাশে কোথায় সেটা করতে হয় তা লেখা আছে।

---

## ১. নিরাপত্তা (ব্লকার)

- [ ] রিপো Private (GitHub → Settings → General → Danger Zone)
- [ ] git history-তে আর কোনো credential নেই — `npm run scan:secrets:history`
      পরিষ্কার (ধাপ: `docs/SECRET_HISTORY_PURGE.md`)
- [ ] CI-র `secret-scan` জব সবুজ (`.github/workflows/node.js.yml`)
- [ ] Neon DB password, Render DB password ও `SESSION_SECRET` — তিনটাই rotate করা

## ২. Environment

- [ ] `.env`-এ sandbox → production credential
- [ ] প্রতিটা প্রোভাইডারের জন্য `PROVIDER_<NAME>_API_URL`, `_AGENT_ID`,
      `_SECRET`, `_IPS` — চারটাই সেট
- [ ] **`PROVIDER_<NAME>_IPS` অবশ্যই দিন।** প্রোডাকশনে খালি রাখলে সেই
      প্রোভাইডারের সব কলব্যাক প্রত্যাখ্যাত হবে (fail-closed —
      `middleware/providerAuth.js`)। এটা ইচ্ছাকৃত: "সেট করতে ভুলে গেছি" আর
      "সবাইকে অনুমতি" এক জিনিস নয়।
- [ ] `WALLET_CALLBACK_BASE_URL` ও `PUBLIC_APP_URL` — https, প্রকৃত ডোমেইন
- [ ] `CLOUDINARY_*` সেট (গেম থাম্বনেইল ও টিকেট QR-এর CDN)

## ৩. প্রোভাইডারের দিকে

- [ ] তাদের ড্যাশবোর্ডে আমাদের production callback URL বসানো:
      `https://<domain>/provider/<provider-slug>/{balance,bet,win,rollback}`
- [ ] আমাদের সার্ভারের outbound IP তাদের allow-list-এ
- [ ] তাদের callback IP আমাদের `PROVIDER_<NAME>_IPS`-এ
- [ ] প্রোভাইডারের certification / integration test পাস (অনেকে বাধ্যতামূলক করে)

## ৪. ফিচার ফ্ল্যাগ

অ্যাডমিন → Feature Management:

- [ ] `games` — ON
- [ ] `provider_wallet` — ON (ডিফল্ট বন্ধ; ওয়ালেট কলব্যাক এটার উপর নির্ভরশীল)
- [ ] `tickets` — ON (টিকেট মডিউল চালু করলে)

## ৫. যাচাই

- [ ] অ্যাডমিন → Games → Providers → **Sync Now**, তারপর গেম সংখ্যা মিলিয়ে দেখুন
- [ ] `/games` লবিতে গেম দেখা যাচ্ছে, ক্যাটাগরি ও প্রোভাইডার ট্যাব ঠিক আছে
- [ ] একটা গেম লঞ্চ করে iframe লোড হয় ও `game_sessions`-এ সারি তৈরি হয়
- [ ] প্রোভাইডারের sandbox থেকে একটা bet/win/rollback চক্র চালিয়ে
      `provider_transactions`-এ পূর্ণ trail দেখুন
- [ ] Redis cache clear (অ্যাডমিন → Cache, অথবা রিডিপ্লয়)

## ৬. মনিটরিং

- [ ] Sentry-তে `routes/providerWallet.js`-এর error rate
- [ ] ওয়ালেট এন্ডপয়েন্টের p95 latency **২০০ms-এর নিচে** — এর বেশি হলে
      প্রোভাইডার টাইমআউট ধরে rollback পাঠাতে শুরু করবে
- [ ] `provider_sync_log`-এ পরপর `failed` সারি — অ্যালার্ট
- [ ] job_queue-র dead-letter (`provider_wallet_effects`, `ticket_issue`)

---

## জানা সীমাবদ্ধতা (এখনো বাকি)

**পেমেন্ট এখনো ম্যানুয়াল।** bKash/Nagad/Rocket ডিপোজিট এখনো ইউজারের দেওয়া
`trx_id` অ্যাডমিন হাতে অনুমোদন করে (`routes/payment.js`)। ভলিউম বাড়লে এটাই
প্রথম bottleneck হবে — একজন অ্যাডমিনের অনুমোদনের গতিই সর্বোচ্চ ডিপোজিট রেট।

সমাধান: অফিসিয়াল merchant API + webhook ইন্টিগ্রেশন। কাঠামোটা ইতিমধ্যে
আছে — `payment_requests` টেবিল, `services/gatewayReconcile.js` (আটকে থাকা
ডিপোজিট মেলানোর cron) এবং SSLCommerz-এর কলব্যাক প্যাটার্ন
(`middleware/csrf.js`-এর `EXEMPT_EXACT` দেখুন)। নতুন গেটওয়ে ওই একই
প্যাটার্নেই বসবে; আলাদা কোনো সমান্তরাল ব্যবস্থা তৈরি করার দরকার নেই।

**টিকেটের এক্সটার্নাল পেমেন্ট।** টিকেট এখন ব্যালেন্স থেকে কেনা যায়
(`services/tickets.js`-এর `payWithBalance`)। গেটওয়ে দিয়ে সরাসরি কেনার জন্য
`markPaidByPaymentRequest()` হুকটা প্রস্তুত — payment অনুমোদনের হ্যান্ডলার
থেকে সেটা কল করলেই অর্ডার `paid` হয়ে টিকেট ইস্যু হয়ে যাবে।

**টিকেট প্রোভাইডার।** `services/ticketProviders/`-এ কোনো বাস্তব অ্যাডাপ্টার
নেই — ইচ্ছাকৃতভাবে। ইভেন্ট আপাতত অ্যাডমিন হাতে তৈরি করেন
(`/admin/tickets`)। অ্যাডাপ্টার যোগ হলে সেটা একই টেবিলেই লিখবে।

## যাচাই করে দেখা গেছে — কোনো পরিবর্তন লাগেনি

- **`views/admin/backups.ejs`-এর `fmtSize()`** — `AUDIT_REPORT.md`-এ ছোট
  সাইজে ক্র্যাশের কথা ছিল। কোডে ইতিমধ্যে `Number(bytes)` কনভার্শন ও
  `Number.isFinite` গার্ড আছে, তাই ১০২৪ বাইটের কম মানেও আর TypeError হয় না।
- **`sports-api/`** — মূল অ্যাপের `services/providers/`-এর সাথে ধারণাগতভাবে
  ডুপ্লিকেট, কিন্তু কোথাও ইমপোর্ট বা প্রক্সি করা হয় না।
  `sports-api/README.md`-এ ইতিমধ্যে স্পষ্ট লেখা আছে যে এটি প্রোডাকশনের অংশ
  নয়, এবং `tests/atomicityAndIntegrity.test.js` সেই নোটের উপস্থিতি যাচাই
  করে। তাই ডিলিট না করে রাখা হলো — ডিলিট করলে ওই টেস্টও ভাঙত।
