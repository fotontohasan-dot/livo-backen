# git history থেকে credential মুছে ফেলা (PHASE 0)

`npm run scan:secrets:history` এখনো history-তে credential খুঁজে পায়। এই
নথিটা সেটা পরিষ্কার করার ধাপগুলো নির্দিষ্ট করে।

> **ক্রম গুরুত্বপূর্ণ:** আগে rotation, পরে rewrite। History rewrite একটা
> পরিচ্ছন্নতার কাজ — সেটা credential-কে অকেজো করে না। কেউ ইতিমধ্যে পুরনো
> মান কপি করে থাকলে rewrite তাকে থামাবে না, শুধু rotation থামাবে।

---

## ০.১ রিপো Private করা

GitHub → Settings → General → Danger Zone → Change repository visibility।

এটা কোড দিয়ে করা যায় না, এবং এটাই সবচেয়ে দ্রুত ঝুঁকি-হ্রাস। প্রোভাইডাররা
onboarding-এর সময় রিপো ও ইনফ্রা রিভিউ করে; পাবলিক রিপোতে history-তে
credential থাকলে approval আটকে যেতে পারে।

## ০.৩ Rotation (rewrite-এর আগে)

- Neon DB password
- Render DB password
- `SESSION_SECRET`

তিনটার একটাও যদি এখনো পুরনো মানেই থাকে, এখনই বদলান। `SESSION_SECRET`
বদলালে সব সক্রিয় সেশন invalid হবে — এটা প্রত্যাশিত, রক্ষণাবেক্ষণ উইন্ডোতে
করুন।

## ০.২ History rewrite

```bash
pip install git-filter-repo

# mirror clone — কাজের কপিতে filter-repo চালাবেন না
git clone --mirror https://github.com/fotontohasan-dot/livo-backen.git livo-mirror
cd livo-mirror

# ১. কখনো commit হওয়া উচিত ছিল না এমন ফাইল সম্পূর্ণ মুছে ফেলা
git filter-repo --path .env --invert-paths --force

# ২. literal মান প্রতিস্থাপন
git filter-repo --replace-text ../replacements.txt --force

git push --force --all
git push --force --tags
```

### `replacements.txt`

রিপোর **বাইরে** তৈরি করুন, প্রতিটি লাইনে একটি ম্যাপিং:

```
<পুরনো postgres connection string>==>REMOVED
<পুরনো SESSION_SECRET-এর literal মান>==>REMOVED
```

- এই ফাইলটা **কমিট করবেন না** (`.gitignore`-এ যোগ করা আছে)।
- কাজ শেষে মুছে ফেলুন — নাহলে ওটা নিজেই একটা credential ফাইল।

### rewrite-এর পরে

- সব collaborator-কে নতুন করে clone করতে হবে। পুরনো লোকাল কপি থেকে
  push করলে মুছে ফেলা commit আবার ফিরে আসে।
- খোলা PR-গুলো বন্ধ করে নতুন base থেকে আবার খুলতে হবে।
- GitHub-এর cached view-তে পুরনো commit কিছুক্ষণ থেকে যেতে পারে;
  স্থায়ীভাবে সরাতে GitHub Support-কে অনুরোধ করতে হয়।

## ০.৪ যাচাই

```bash
npm run scan:secrets:history
```

পরিষ্কার রিপোর্ট আসতে হবে। CI-তেও এটা প্রতিটা PR-এ চলে
(`.github/workflows/node.js.yml`-এর `secret-scan` জব, `fetch-depth: 0` সহ) —
সেই জব সবুজ হওয়াই চূড়ান্ত acceptance।

## ০.৬ কোডে fallback credential নেই — যাচাই

- `db.js` — `DATABASE_URL` না থাকলে throw করে, কোনো ডিফল্ট connection
  string নেই।
- `services/envValidator.js` — প্রোডাকশনে `SESSION_SECRET` বাধ্যতামূলক এবং
  দুর্বল হলে বুট আটকায়।
- `app.js` — `SESSION_SECRET` না থাকলে **র‍্যান্ডম** সিক্রেট বানায়
  (হার্ডকোড নয়) এবং সতর্কবার্তা দেয়; প্রোডাকশনে envValidator তার আগেই থামায়।
