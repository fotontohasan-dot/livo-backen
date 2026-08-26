# Backup & Restore System — Production Readiness Audit

তারিখ: এই অডিটে `services/backupManager.js`, `services/backup.js` (পুরনো/legacy),
`routes/admin.js`-এর ব্যাকআপ রুট, `views/admin/backups.ejs`, ও `backup_history`
টেবিল কভার করা হয়েছে। যাচাই `tests/integration/backup.test.js`-এ (২২টা টেস্ট,
সব pass) স্বয়ংক্রিয়ভাবে করা হয়েছে — একটা isolated test PostgreSQL-এর বিপরীতে
সত্যিকার HTTP রিকোয়েস্ট ও সত্যিকার ফাইল-সিস্টেম অপারেশন দিয়ে।

## সারসংক্ষেপ (Verdict)

**মূল ব্যাকআপ/রিস্টোর ইঞ্জিন (`services/backupManager.js`) প্রোডাকশন-রেডি।**
Checksum-ভিত্তিক integrity verification, non-destructive restore
(`ON CONFLICT DO NOTHING`), এনক্রিপশন সাপোর্ট, error handling — সবই সঠিকভাবে
কাজ করে এবং সব ফেইলিউর কেসে ক্র্যাশ না করে স্পষ্ট error দেয়।

**একটা রিয়েল বাগ পাওয়া গেছে অ্যাডমিন UI-তে (নিচে বিস্তারিত)** — এটা ঠিক করা
হয়নি, কারণ টাস্কের নির্দেশনা অনুযায়ী কোনো existing feature/DB structure
পরিবর্তন করা যাবে না। সুপারিশ দেওয়া আছে।

---

## ১. Backup Flow Audit

| ফ্লো | ফাইল | অবস্থা |
|---|---|---|
| Database ব্যাকআপ (সব টেবিল JSON dump → gzip → checksum) | `createDatabaseBackup()` | ✅ কাজ করে |
| Uploads ব্যাকআপ (`public/uploads` → tar.gz) | `createUploadsBackup()` | ✅ কাজ করে (tar বাইনারি লাগে) |
| Config ব্যাকআপ (site_settings + env key list, কোনো secret value নয়) | `createConfigBackup()` | ✅ কাজ করে, secret leak নেই — যাচাই করা হয়েছে |
| ঐচ্ছিক AES-256-GCM এনক্রিপশন (`BACKUP_ENCRYPTION_KEY`) | `packBuffer()`/`unpackBuffer()` | ✅ ফরম্যাট সঠিক (flag byte দিয়ে এনক্রিপ্টেড/প্লেইন আলাদা করা) |
| Legacy GitHub-based daily backup (`services/backup.js`) | পুরনো সিস্টেম, `backupManager.js`-এর সাথে সম্পর্কহীন | ⚠️ শুধু `GITHUB_TOKEN`/`GITHUB_REPO` সেট থাকলেই কাজ করে — টেস্ট এনভায়রনমেন্টে ইচ্ছাকৃতভাবে স্কিপ করা হয়েছে (রিয়েল GitHub API কল এড়াতে) |

## ২. Restore Process (বাস্তবে টেস্ট করা)

- Database restore: একটা রিয়েল ইউজার তৈরি → ব্যাকআপ নেওয়া → ইউজার ডিলিট করে
  "ডেটা হারানো" সিমুলেট করা → restore চালানো → ইউজার ফিরে এসেছে কিনা যাচাই
  (রো-লেভেল পর্যন্ত)। **✅ পাস।**
- Config restore: একটা সেটিং ব্যাকআপ নেওয়া → পরে মান পরিবর্তন করা → restore
  চালানো → আসল মান ফিরে এসেছে কিনা যাচাই। **✅ পাস।**
- Restore শুধু `status='completed'` রেকর্ডে কাজ করে, `'failed'` রেকর্ড
  প্রত্যাখ্যাত হয় স্পষ্ট এরর মেসেজ সহ। **✅ পাস।**
- Restore non-destructive: বিদ্যমান রো কখনো ওভাররাইট হয় না (`ON CONFLICT DO
  NOTHING`) — ডিজাইন অনুযায়ী সঠিক আচরণ, ডেটা-লস ঝুঁকি কমায়।

## ৩. Backup File Integrity Verification

- SHA-256 checksum প্রতিটা ব্যাকআপ ফাইলের সাথে DB-তে সংরক্ষিত হয়।
- ফাইল ম্যানুয়ালি corrupt করলে (এক বাইট flip) → `verifyBackupFile()` checksum
  মিসম্যাচ ধরে ফেলে, restore সম্পূর্ণ বাতিল হয়ে যায় (আংশিক/করাপ্টেড ডেটা কখনো
  DB-তে ঢোকে না)। **✅ পাস।**
- ফাইল ডিস্ক থেকে সম্পূর্ণ মুছে গেলে → স্পষ্ট "ফাইল পাওয়া যায়নি" এরর,
  ক্র্যাশ/আনহ্যান্ডলড এক্সেপশন নেই। **✅ পাস।**
- এনক্রিপ্টেড ব্যাকআপ ভুল/অনুপস্থিত কী দিয়ে ডিক্রিপ্ট করার চেষ্টা করলে AES-GCM-এর
  নিজস্ব authTag ভেরিফিকেশন ব্যর্থ হয়ে স্পষ্ট এরর দেয় (কোড রিভিউ দিয়ে যাচাই করা,
  যেহেতু টেস্ট এনভায়রনমেন্টে এনক্রিপশন কী সেট নেই)।

## ৪. Failed Backup/Restore: Error Handling ও Logging

- `public/uploads` ফোল্ডার সাময়িকভাবে সরিয়ে নিয়ে uploads ব্যাকআপ ব্যর্থ করা
  হয়েছে — ফলাফল: `status='failed'` + `error_message` সহ **backup_history-তে
  রেকর্ড হয়** (silent failure নয়, audit trail বজায় থাকে)। **✅ পাস।**
- Restore ব্যর্থ হলে admin route (`POST /admin/backups/:id/restore`) `logAdminAction`
  ও `logAuditEvent` (category: `restore`, riskLevel: `critical`) দুটোতেই লগ করে,
  এবং ইউজারকে error message সহ রিডাইরেক্ট করে — ক্র্যাশ করে না। **✅ পাস
  (কোড রিভিউ + HTTP টেস্ট)।**

## ৫. Backup History, Status, Restore History

- `listBackups()` নতুন-থেকে-পুরনো ক্রমে রিটার্ন করে, `type` দিয়ে ফিল্টার করা যায়।
  **✅ পাস।**
- `restored_at` কলাম সফল রিস্টোরের পর সঠিকভাবে আপডেট হয় (Restore History)।
  **✅ পাস।**
- `deleteBackup()` DB রেকর্ড ও ডিস্ক ফাইল উভয়ই মুছে দেয়। **✅ পাস।**

## ৬. Manual vs Automatic Backup

- Manual (`source='manual'`, অ্যাডমিন প্যানেল থেকে) ও Scheduled
  (`source='scheduled'`, `scheduleAutoBackup()` থেকে) — দুটোই একই আন্ডারলাইং
  ফাংশন ব্যবহার করে, `source` কলাম দিয়ে আলাদা করা যায় (audit trail-এর জন্য
  গুরুত্বপূর্ণ)। **✅ যাচাই করা হয়েছে।**
- `scheduleAutoBackup()` কল করলে ক্র্যাশ করে না এবং দ্বিতীয়বার কল করলে দ্বিতীয়
  ইন্টারভাল বসে না (`scheduleHandle` গার্ড)। বাস্তবে ২৪ ঘণ্টা পরপর
  চলা—নিজস্বভাবে (রিয়েল টাইমে অপেক্ষা করে) যাচাই করা সম্ভব নয়, তাই কোড রিভিউ +
  আচরণগত (idempotency) টেস্ট দিয়ে confirm করা হয়েছে।
- `pruneOldScheduledBackups()` (প্রতি টাইপে সর্বোচ্চ ১৪টা scheduled ব্যাকআপ রাখে)
  export করা নেই, তাই সরাসরি ইউনিট-টেস্ট করা যায়নি; কোড রিভিউ-এ লজিক সঠিক
  পাওয়া গেছে (`OFFSET 14` দিয়ে পুরনোগুলো ডিলিট)।

---

## 🔴 আবিষ্কৃত বাগ (ঠিক করা হয়নি — প্রোডাকশন কোড পরিবর্তন নিষিদ্ধ ছিল এই টাস্কে)

### `views/admin/backups.ejs` — `fmtSize()` ক্র্যাশ করে ছোট সাইজের ব্যাকআপে

**অবস্থান:** `views/admin/backups.ejs`, লাইন ৮–১৪ (`fmtSize` ফাংশন)

**কারণ:** `backup_history.size_bytes` একটা `BIGINT` কলাম। node-postgres BIGINT-কে
JS **string** হিসেবে রিটার্ন করে (precision loss এড়াতে), number হিসেবে নয়।
`fmtSize()`-এর `while (n >= 1024 ...)` লুপ যদি একবারও না চলে (অর্থাৎ
`bytes < 1024`), তাহলে `n` তখনও সেই স্ট্রিং-ই থেকে যায়, আর
`n.toFixed(1)` কল করলে থ্রো করে:

```
TypeError: n.toFixed is not a function
```

**প্রভাব:** `/admin/backups` history পেজ **সম্পূর্ণ ক্র্যাশ করে (HTTP 500)**
যদি কোনো ব্যাকআপ রেকর্ডের `size_bytes < 1024` বাইট হয় — যেমন ছোট
config/uploads ব্যাকআপ, অথবা `status='failed'` রেকর্ড (যেখানে
`size_bytes = 0`)। অর্থাৎ প্রায় যেকোনো real-world ব্যবহারে (একটা ছোট ব্যাকআপ
বা একটাও ব্যর্থ ব্যাকআপ থাকলেই) পুরো Backup History UI ভেঙে পড়বে।

**Reproduction (স্বয়ংক্রিয়ভাবে যাচাইকৃত):** `tests/integration/backup.test.js`-এর
`[AUDIT FINDING] ...` টেস্টটা এটা reproduce করে ডকুমেন্ট করে রাখে।

**প্রস্তাবিত ফিক্স (প্রয়োগ করা হয়নি):**
```js
function fmtSize(bytes) {
  const n0 = Number(bytes); // BIGINT স্ট্রিং-কে নাম্বারে কনভার্ট করা
  if (!n0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = n0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + ' ' + units[i];
}
```
শুধু `Number(bytes)` যোগ করলেই যথেষ্ট — বাকি লজিক ঠিক আছে।

---

## Full Functional Testing — কভারেজ

`tests/integration/backup.test.js` (২২ টেস্ট, সব pass):
- Service-level: create (database/config/uploads), restore (database/config),
  checksum tampering, ফাইল-মিসিং, uploads-ফোল্ডার-মিসিং, history
  list/filter/delete, scheduled-backup marking।
- HTTP/admin-route-level: unauthenticated ব্লক, admin page render, create-via-UI,
  download (বাইট-লেভেল যাচাই), restore-via-UI (সফল ও করাপ্টেড উভয় কেস), delete-via-UI,
  non-admin ব্লক, ও উপরের ডকুমেন্টেড বাগ reproduction।

চালানো: `npm test` অথবা `npm run test:coverage` (দেখুন README.md-এর "Automated
Testing" সেকশন)।
