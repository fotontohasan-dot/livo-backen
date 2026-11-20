# routes/admin.js — রিপোর্টের তারিখ-গ্রুপিং/দিন-সীমা তালিকা (fix/timezone-bd-5, কাজ ২)

**"স্থান" এর সংজ্ঞা:** একটি SQL স্টেটমেন্ট বা একটি JS তারিখ-হিসাব ব্লক। একই কার্ডের "আজ/গতকাল" জোড়া ও একই `dateRange`-এর ডিফল্ট + তার কনজিউমার কোয়েরি (যেগুলো একসাথে না বদলালে জানালা অমিল হতো) ১টি স্থান।
লাইন নম্বর এই কমিটের ফাইল অনুযায়ী। ক্রম = ফাইলে যেভাবে আসে; প্রথম ৮টা ঠিক করা হয়েছে।

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

## বাকি (খোলা) — ঠিক করা হয়নি
| # | স্থান (ফাইল:লাইন) | রুট | ধরন |
|---|---|---|---|
| S9 | routes/admin.js:1401 | / | newUsersToday `created_at::date = CURRENT_DATE` |
| S10 | :1423-1426 | / | revenueTrend ১৪ দিন — দৈনিক গ্রুপিং |
| S11 | :1431-1433 | / | userGrowth ১৪ দিন — দৈনিক গ্রুপিং |
| S12 | :1673-1674 | / (loadError fallback) | toISOString().slice UTC |
| S13 | :1701, :1705, :1710, :1715 | /api/dashboard-stats | আজ ডিপোজিট/উইথড্র/P&L/গতকাল |
| S14 | :1724 | /api/dashboard-stats | newUsersToday |
| S15 | :1810, :1814 | /deposits/legacy-disabled | `::date` রেঞ্জ ফিল্টার |
| S16 | :1930, :1934 | /withdrawals/legacy-disabled | ঐ |
| S17 | :2696 | /bot-logs | `to::date + 1 day` (সীমাসহ `<=`) |
| S18 | :3057, :3061 | /bets | আজ স্টেক ও P&L |
| S19 | :3104, :3108 | /api/bets-live | ঐ |
| S20 | :3697 | /bot-monitoring | আজকের bot_activity_logs |
| S21 | :4255 | /fraud-logs | `to::date + 1 day` |
| S22 | :4356-4357, :4361, :4366, :4372, :4376 | /reports | রিপোর্ট রেঞ্জ (toISOString ডিফল্ট + `BETWEEN $1 AND $2::date+1day`) |
| S23 | :4387-4402 | /reports | **দৈনিক গ্রুপিং** (staked/payout/new users per day) |
| S24 | :4542 | /login-history | `to::date + 1 day` |
| S25 | :4699 | /api-logs | ঐ |
| S26 | :4769 | /api-logs/export.csv | ঐ |

প্রদর্শন/ফাইলনাম মাত্র (ব্যবসায়িক গ্রুপিং নয়): :3885 (রোল-এক্সপোর্ট ফাইলনামের তারিখ), :4148, :4170 (টেমপ্লেট প্রিভিউ নমুনা-তারিখ)।

## সতর্কতা (অন্তর্বর্তী অসামঞ্জস্য)
S5–S8 এখন BD দিনে, কিন্তু একই ড্যাশবোর্ডে S9 (নতুন ইউজার আজ), S10/S11 (১৪-দিনের চার্ট) ও /api/dashboard-stats (S13/S14) এখনও UTC দিনে — BD ০০:০০–০৬:০০ সময়ে এই কার্ড/চার্টগুলোর "আজ" পরস্পর মিলবে না। S9–S14 পরের ব্রাঞ্চে একসাথে ঠিক করা উচিত।
