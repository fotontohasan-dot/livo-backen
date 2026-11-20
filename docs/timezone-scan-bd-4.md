# ব্যবসায়িক-তারিখ স্ক্যান (fix/timezone-bd-4, base 2186016e)

প্যাটার্ন: getDay(), toISOString().slice/substring/split, CURRENT_DATE, ::date, date_trunc, getHours/getDate/getMonth/getFullYear, toLocaleDateString।
আকার: ছোট ≤ ১ ফাংশন/কয়েক লাইন, মাঝারি = একাধিক কোয়েরি বা শেয়ার্ড ফিল্টার, বড় = অ্যাডমিন রিপোর্ট/ড্যাশবোর্ডের ঢালাও পরিবর্তন।

## বদলানো উচিত — এই ব্রাঞ্চে ঠিক (কাজ ২)
| স্থান | আকার | অবস্থা |
|---|---|---|
| routes/payment.js:721-742 (resolveDepositDateRange), :760, :775 | ছোট | ঠিক করা হয়েছে |
| routes/profile.js:237-242 (/history), :270-275 (/stats) | ছোট | ঠিক করা হয়েছে |
| services/contest.js:24,46,53,66,72-74 | ছোট | ঠিক করা হয়েছে |

## বদলানো উচিত — এখনও খোলা
| স্থান | আকার | মন্তব্য |
|---|---|---|
| routes/admin.js (≈৬৪ স্থান): :27-41 ও :1412-1422 (চার্ট generate_series/CURRENT_DATE), :1344-1345, :1662-1663 (toISOString().slice), :1362-1390, :1690-1713, :3046-3050, :3093-3097, :3686 (created_at::date = CURRENT_DATE), :1799-1803, :1919-1923, :2685, :4244, :4531, :4688, :4758 (to::date + 1 day ফিল্টার), :4345-4391 (রিপোর্ট রেঞ্জ ও দৈনিক গ্রুপিং) | বড় | নির্দেশ অনুযায়ী ছোঁয়া হয়নি |
| services/redpacket.js:32 `(updated_at + interval '6 hours')::date` | মাঝারি | হাতে-করা +৬ঘ; AT TIME ZONE-এ আনা উচিত (DST-ঝুঁকি) |
| services/auditLog.js:150 `created_at <= to::date + 1 day` | মাঝারি | অ্যাডমিন ফিল্টার সীমানা ৬ ঘণ্টা সরে |
| routes/chat.js:365 `date_trunc('day', NOW())` | ছোট | "আজ" UTC মধ্যরাতে কাটে |
| routes/auth.js:544, :655 toLocaleDateString('bn-BD') | ছোট | শুধু প্রদর্শন; timeZone বিকল্প যোগ উচিত (হিসাব-প্রভাব নেই) |

## বদলানো উচিত নয়
- services/sportsAPI.js:150 — বাইরের API-র তারিখ (নির্দেশ অনুযায়ী)।
- services/queue.js:310 date_trunc('hour', ...) — অপারেশনাল ঘণ্টা-পরিসংখ্যান, ব্যবসায়িক দিন নয়।
- routes/profile.js:437 self-exclude `setDate(+days)` — সময়কাল-যোগ (মুহূর্ত), ক্যালেন্ডার-দিন নয়।
- scripts/loadtest/mockProvider.js, scripts/audit/audit-scan.js — টুল/মক, ব্যবসায়িক নয়।
- cashback.js:101, periodicReward.js:47, missions.js:92, coins.js:57, wheel.js:37 — আগেই BD-পরামিতি/ব্যবসায়িক দিনে; `::date` কেবল প্যারামিটার কাস্ট।
- utils/businessTime.js — সংজ্ঞাই এখানে।

---
## বাস্তব অবস্থা (fix/timezone-bd-5, কাজ ১)
| স্থান | সিদ্ধান্ত |
|---|---|
| services/redpacket.js:32 | বদলানো হয়েছে — `sqlBusinessDate(updated_at)` |
| services/auditLog.js from/to | বদলানো হয়েছে — BD দিনের শুরু `>=` / পরের দিনের শুরু `<` (from ও to দুটোই; দুটোই ৬ ঘণ্টা সরে ছিল) |
| routes/chat.js /admin/stats resolved "আজ" | বদলানো হয়েছে — `sqlBusinessDate(...) = businessToday` |
