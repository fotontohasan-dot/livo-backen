# routes/admin.js — রিপোর্টের তারিখ-গ্রুপিং/দিন-সীমা তালিকা (fix/timezone-bd-5, কাজ ২)

**"স্থান" এর সংজ্ঞা:** একটি SQL স্টেটমেন্ট বা একটি JS তারিখ-হিসাব ব্লক। একই কার্ডের "আজ/গতকাল" জোড়া ও একই `dateRange`-এর ডিফল্ট + তার কনজিউমার কোয়েরি (যেগুলো একসাথে না বদলালে জানালা অমিল হতো) ১টি স্থান।
লাইন নম্বর এই কমিটের ফাইল অনুযায়ী। ক্রম = ফাইলে যেভাবে আসে; S1–S8 fix/timezone-bd-5-এ, S9–S26 fix/timezone-bd-6-এ ঠিক করা হয়েছে।

**সব কলাম `TIMESTAMP` (টাইমজোনবিহীন)** — তাই `utils/businessTime.sqlBusinessDate(col, tz)` প্রযোজ্য; রেঞ্জ-ফিল্টারে `startOfDay/endOfDay` (পরের দিনের শুরু, `<`)।
**পর্যবেক্ষণ:** routes/admin.js-এ সাপ্তাহিক/মাসিক গ্রুপিং (`date_trunc('week'|'month')`, `to_char`, `EXTRACT`) নেই — শুধু দৈনিক (generate_series / `::date`) ও দিন-সীমা ফিল্টার।

## ঠিক করা হয়েছে (S1–S8) — টেস্ট: tests/regression/adminReportDayBd.test.js
| # | স্থান (এখনকার লাইন) | রুট |
|---|---|---|
| S1 | :32-37 revenue দৈনিক সিরিজ | GET /admin/api/analytics |
| S2 | :38-42 userGrowth | ঐ |
| S3 | :43-48 betStats | ঐ |
| S4 | :1350-1352 dateRange ডিফল্ট + কনজিউমার betStats/betPayout/apiUsage (BETWEEN) | GET /admin/ (ড্যাশবোর্ড) |
| S5 | আজ-ডিপোজিট (`today_deposit`) | ঐ |
| S6 | আজ-উইথড্র | ঐ |
| S7 | আজ-বেট (গণনা/স্টেক) | ঐ |
| S8 | আজ P&L + গতকাল P&L (জোড়া) | ঐ |

## ঠিক করা হয়েছে (S9–S26) — fix/timezone-bd-6; টেস্ট: tests/regression/{adminDashBd2,adminListFiltersBd,adminReportsBd}.test.js
সব ক্ষেত্রে একই BD helper (`utils/businessTime`): দৈনিক গ্রুপিং/"আজ" = `sqlBusinessDate(col, tz)` + `bt.today()`;
from/to রেঞ্জ = `[bt.startOfDay(from), bt.endOfDay(to))` (`>=` ও `<`, `BIZ_TS($n)` দিয়ে); JS-এর দিন = `bt.today()/addDays`।
| # | স্থান | রুট | কীভাবে |
|---|---|---|---|
| S9 | newUsersToday | / | sqlBizDate = আজ |
| S10 | revenueTrend ১৪ দিন | / | generate_series($1::date−13d..$1) + sqlBizDate |
| S11 | userGrowth ১৪ দিন | / | ঐ |
| S12 | loadError fallback dateRange | / | bt.today()/addDays(−29) |
| S13 | আজ ডিপোজিট/উইথড্র/P&L/গতকাল | /api/dashboard-stats | sqlBizDate = bt.today() / addDays(−1) |
| S14 | newUsersToday | /api/dashboard-stats | ঐ |
| S15 | from/to | /deposits/legacy-disabled | BD দিন-সীমা `>=`/`<` |
| S16 | from/to | /withdrawals/legacy-disabled | ঐ |
| S17 | from/to | /bot-logs | ঐ; `b.created_at` + COUNT-এ alias (নিচে ⚠) |
| S18 | আজ স্টেক ও P&L | /bets | sqlBizDate = bt.today() |
| S19 | ঐ | /api/bets-live | ঐ |
| S20 | আজকের bot_activity_logs | /bot-monitoring | ঐ |
| S21 | from/to | /fraud-logs | BD দিন-সীমা; `f.created_at` + COUNT-এ alias (নিচে ⚠) |
| S22 | রিপোর্ট রেঞ্জ (ডিফল্ট + ৪ কোয়েরি) | /reports | ডিফল্ট `bt.today()`/addDays(−30); `BETWEEN` → `>= … AND < …` BD সীমা |
| S23 | দৈনিক গ্রুপিং (ggrTrend, userTrend) | /reports | sqlBizDate = d::date |
| S24 | from/to | /login-history | BD দিন-সীমা `>=`/`<` |
| S25 | from/to | /api-logs | ঐ |
| S26 | from/to | /api-logs/export.csv | ঐ |

**বাদ দেওয়া: কিছুই নয়** — S9–S26 সবই ভেতরের (নিজস্ব DB) `TIMESTAMP` কলামের দিন-নির্ধারণ; বাইরের API-র তারিখ এর মধ্যে নেই।

**আচরণগত দুটি নোট (শুধু "কোন দিন"):**
- ⚠ S17/S21 (`/bot-logs`, `/fraud-logs`): লিস্ট কোয়েরি `users`-এর সাথে JOIN করে, আর `created_at` অযোগ্য (unqualified) ছিল — তাই `from`/`to` দিলেই
  `column reference "created_at" is ambiguous` → পেজ loadError দেখাত (ফিল্টার আদৌ কাজ করত না)। তারিখ-শর্ত বদলানোর সময় শুধু ওই কলামটি `b.`/`f.` দিয়ে যোগ্য করা হয়েছে (COUNT-এও alias); অন্য ফিল্টার/কোয়েরি অপরিবর্তিত।
- S17/S21/S24/S25/S26-এ `to`-শর্ত আগে `<= to::date + 1 day` ছিল (পরের দিনের ঠিক মধ্যরাতের সারিও ঢুকত); এখন `< পরের BD দিনের শুরু`।
- রেঞ্জে ফরম্যাট কড়া: `from`/`to` `YYYY-MM-DD` হতে হবে (HTML date input যা দেয়); `2026-3-5`-এর মতো লেনিয়েন্ট ফরম্যাটে আগে Postgres কাস্ট করত, এখন catch-এ error পেজ। অবৈধ মান আগেও error পেজ দিত।

## এখনও খোলা (উদ্দেশ্যমূলকভাবে বদলানো হয়নি)
প্রদর্শন/ফাইলনাম মাত্র (ব্যবসায়িক গ্রুপিং নয়): :3903 (রোল-এক্সপোর্ট ফাইলনামের তারিখ), :4166, :4188 (টেমপ্লেট প্রিভিউ নমুনা-তারিখ) — fix/timezone-bd-6 কমিটের লাইন অনুযায়ী।

এই তিনটি শুধু প্রদর্শন/ফাইলনামের তারিখ, ব্যবসায়িক গ্রুপিং/ফিল্টার নয়।
