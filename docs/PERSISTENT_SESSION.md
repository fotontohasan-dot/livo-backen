# স্থায়ী সেশন ও Silent Token Refresh

ব্যবহারকারী বারবার লগইন না করেই নিরবচ্ছিন্ন থাকবে — কিন্তু চুরি হওয়া কুকি যেন অনির্দিষ্টকাল কাজ না করে।

## দুই স্তর

| স্তর | কুকি | মেয়াদ | নোট |
|---|---|---|---|
| সেশন | `connect.sid` (express-session) | rolling ৩০ দিন | HttpOnly, Secure (prod), SameSite=Lax — আগের মতোই |
| রিফ্রেশ | `livo_rt` | sliding ৬০ দিন, family সর্বোচ্চ ১৮০ দিন | HttpOnly, Secure (prod), SameSite=Lax, প্রতিবার রোটেট |

## কীভাবে কাজ করে

1. **লগইন/রেজিস্টার** → `completeLogin` / `/register` রিফ্রেশ টোকেন ইস্যু করে (`middleware/persistentSession.js → issueForLogin`)।
2. **সেশন হারালে** (কুকি মোছা, মেয়াদ শেষ, Redis flush, ডিপ্লয়) → রিফ্রেশ কুকি থাকলে পরের **GET/HEAD** রিকোয়েস্টেই সেশন নিঃশব্দে পুনরুদ্ধার হয়।
3. **Silent refresh** → সেশন বৈধ থাকলেও টোকেন প্রতি ২৪ ঘণ্টায় (মেয়াদ ফুরানোর অনেক আগে) ব্যাকএন্ডে নিঃশব্দে রোটেট হয়। ব্রাউজারে `public/js/session-keepalive.js` প্রতি ২০ মিনিটে `POST /auth/refresh` পাঠায় (CSRF-সুরক্ষিত); এতে সেশন কুকির rolling মেয়াদও বাড়ে। ডিপ্লয়ের আগে লগইন করা পুরনো সেশনে টোকেন না থাকলে এই কলেই ইস্যু হয়ে যায়।
4. **লগআউট** → পুরো token family বাতিল + কুকি মোছা।

## নিরাপত্তা সিদ্ধান্ত

- DB-তে শুধু SHA-256 হ্যাশ (`refresh_tokens.token_hash`); আসল টোকেন কেবল HttpOnly কুকিতে — JS পড়তে পারে না।
- **Rotation + reuse detection:** রোটেট হওয়া টোকেন grace window (`REFRESH_REUSE_GRACE_SECONDS`, ডিফল্ট ১০s)-এর পরে আবার এলে পুরো family বাতিল ও ওই সেশন ধ্বংস। grace window আছে কারণ প্যারালাল রিকোয়েস্ট একই পুরনো কুকি নিয়ে আসতে পারে।
- **অ্যাডমিনের জন্য রিফ্রেশ টোকেন নেই** — অ্যাডমিনের 2FA বাধ্যতামূলক, কুকি দিয়ে সেটা এড়ানো যেত।
- রিস্টোরের সময় ব্যান / সেলফ-এক্সক্লুশন / অস্তিত্ব সরাসরি DB থেকে যাচাই (ক্যাশ নয়)।
- রিস্টোর শুধু GET/HEAD — state-changing রিকোয়েস্ট কুকি-নির্ভর রিস্টোরে চলে না।
- কুকির টোকেন সেশনের ইউজারের না হলে (একই ব্রাউজারে ইউজার বদল) বাতিল করা হয়।
- যেখানে সেশন বাতিল হয় সেখানে টোকেনও বাতিল: লগআউট, পাসওয়ার্ড রিসেট, পাসওয়ার্ড পরিবর্তন / "অন্য সব ডিভাইস থেকে লগআউট", নির্দিষ্ট ডিভাইস বাতিল (`services/deviceTracking.js`)।

## কনফিগ (`.env.example`)

`PERSISTENT_SESSION_ENABLED`, `REFRESH_TOKEN_TTL_DAYS`, `REFRESH_TOKEN_FAMILY_MAX_DAYS`, `REFRESH_ROTATE_AFTER_HOURS`, `REFRESH_REUSE_GRACE_SECONDS`।
জরুরি অবস্থায় `PERSISTENT_SESSION_ENABLED=false` দিলে ফিচারটি পুরো বন্ধ হয়ে আগের আচরণে ফেরে (বিদ্যমান টোকেন নিষ্ক্রিয় থাকে)।

## ফাইল

- `services/refreshTokens.js` — ইস্যু / রোটেট / বাতিল (ট্রানজ্যাকশন + `FOR UPDATE`)
- `middleware/persistentSession.js` — রিস্টোর মিডলওয়্যার + `POST /auth/refresh`
- `migrations.js` — `refresh_tokens` টেবিল (`IF NOT EXISTS`, নিরাপদে পুনরায় চালানো যায়)
- `public/js/session-keepalive.js` — ক্লায়েন্টের নিঃশব্দ ping
- টেস্ট: `tests/persistentSession.test.js` (ইউনিট), `tests/persistentSession.integration.test.js` (HTTP + Postgres)

## অ্যাডমিন: পাসওয়ার্ড বাদ, ২FA সবসময়

অ্যাডমিন সেশন শেষ হলে `/admin`-এ গেলে ইউজারনেম-পাসওয়ার্ড লাগে না; সরাসরি ২FA কোড পেজে যায়, কোড দিলেই ঢোকে।

| | ইউজার | অ্যাডমিন |
|---|---|---|
| কুকি | `livo_rt` | `livo_art` |
| Path / SameSite | `/` / Lax | `/admin` / **Strict** |
| মেয়াদ (sliding / absolute) | ৬০ / ১৮০ দিন | ৩০ / ৯০ দিন |
| রিস্টোরের ফল | সরাসরি লগইন | **শুধু `pending2FA`** — ২FA কোড ছাড়া কিছুই খোলে না |
| ইস্যু হয় | লগইন/রেজিস্টারে | ২FA সফল হওয়ার পর |

- রিস্টোরের সময় যাচাই: role=admin, ban/delete নয়, **২FA এখনো চালু** (বন্ধ করলে remember অচল)।
- `refresh_tokens.kind` (`user`/`admin`): একটা kind-এর টোকেন অন্যটার কুকিতে কাজ করে না।
- বাতিল হয়: অ্যাডমিন লগআউট, পাসওয়ার্ড বদল, রিকভারি রুট (`ADMIN_RESET_TOKEN`), ব্যান, reuse শনাক্ত।
- কনফিগ: `ADMIN_REMEMBER_TTL_DAYS`, `ADMIN_REMEMBER_FAMILY_MAX_DAYS`।

## ইউজারনেম/পাসওয়ার্ড অটো-ফিল

সার্ভার কখনো পাসওয়ার্ড সংরক্ষণ বা ফেরত দেয় না। ফর্ম ভরে দেয় ব্রাউজার/পাসওয়ার্ড ম্যানেজার (প্রথমবার "Save password" চাপলে)।
সেজন্য ফর্মে `autocomplete="username"`, `autocomplete="current-password"` (ইউজার ও অ্যাডমিন দুই লগইনেই) এবং ২FA ফিল্ডে `autocomplete="one-time-code"` আছে।

## লগআউট

"Logout" চাপলে ওই ডিভাইসের remember টোকেন বাতিল হয় — নইলে বাটনটার কোনো মানে থাকত না। সেশন নিজে থেকে শেষ হলে (মেয়াদ, ব্রাউজার ক্লিনআপ, ডিপ্লয়) নিঃশব্দে ফিরে আসে।
