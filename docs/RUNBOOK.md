# Livo — প্রোডাকশন রানবুক

ডিপ্লয়, ভেরিফিকেশন, ব্যাকআপ/রিস্টোর, রিকভারি ও রোলব্যাক — এক জায়গায়।
পূর্ণ Environment Variable তালিকা ও Docker ব্যাখ্যা `README.md`-এ আছে; এই ফাইলটা
অপারেশনাল ধাপগুলোর সংক্ষিপ্ত চেকলিস্ট।

> এখানে কোনো আসল সিক্রেট নেই এবং কখনো রাখা যাবে না। সব মান `.env` থেকে আসে,
> আর `.env` কমিট করা হয় না (`.gitignore`-এ আছে)।

---

## ১. ফ্রেশ ডিপ্লয়মেন্ট

```bash
git clone <repo-url> && cd livo-backen
cp .env.example .env      # তারপর .env-এ আসল মান বসাও (নিচের ধাপ ২)
docker compose -f docker-compose.yml up -d --build
```

> ⚠️ `-f docker-compose.yml` বাদ দিলে `docker-compose.override.yml` স্বয়ংক্রিয়ভাবে যুক্ত
> হয়ে অ্যাপ **development** মোডে, nodemon-এ এবং দুর্বল ডেভ-ডিফল্ট পাসওয়ার্ড নিয়ে উঠবে।
> প্রোডাকশনে `-f` বাধ্যতামূলক।

---

## ২. আবশ্যক Environment Variables

`docker-compose.yml` এগুলো `${VAR:?}` সিনট্যাক্সে পড়ে — অর্থাৎ **সেট না থাকলে Compose
শুরুই হবে না** (fail-closed, ভুল করে ডিফল্ট পাসওয়ার্ডে চলার ঝুঁকি নেই):

| Variable | কী কাজে |
|---|---|
| `DB_PASSWORD` | PostgreSQL পাসওয়ার্ড (`DATABASE_URL`-এ ব্যবহৃত) |
| `REDIS_PASSWORD` | Redis পাসওয়ার্ড (`REDIS_URL`-এ ব্যবহৃত) |
| `SESSION_SECRET` | express-session কুকি সাইনিং |
| `METRICS_TOKEN` | `/metrics` স্ক্র্যাপ অথেন্টিকেশন (Prometheus) |
| `GRAFANA_ADMIN_PASSWORD` | Grafana অ্যাডমিন লগইন |

ঐচ্ছিক কিন্তু প্রোডাকশনে সুপারিশকৃত: `PORT` (ডিফল্ট `3000`),
`BACKUP_SCHEDULE_HOURS` (ডিফল্ট `24`, `0` দিলে অটো-ব্যাকআপ বন্ধ),
`TELEGRAM_BOT_TOKEN` + `TELEGRAM_ADMIN_CHAT_ID` (অ্যালার্ট পেতে হলে আবশ্যক)।

চেক:

```bash
docker compose -f docker-compose.yml config >/dev/null && echo "compose config OK"
```

---

## ৩. ডাটাবেজ ইনিশিয়ালাইজেশন / মাইগ্রেশন

মাইগ্রেশন **আলাদা করে চালাতে হয় না** — `app.js` বুট হওয়ার সময় `runMigrations()` চালায়,
আর প্রতিটা স্টেটমেন্ট `IF NOT EXISTS` ভিত্তিক, তাই বারবার চললেও নিরাপদ (idempotent)।

ডিপ্লয়ের পর লগে এই লাইনগুলো দেখা উচিত:

```bash
docker compose -f docker-compose.yml logs app | grep "✅"
# ... ✅ RBAC (Role & Permission) tables ready
# ... ✅ Hot-path indexes ready
```

`❌ Migration error:` দেখলে ডিপ্লয় **সফল ধরা যাবে না** — লগ দেখে কারণ ঠিক করতে হবে।

---

## ৪. Redis

Redis ঐচ্ছিক। `REDIS_ENABLED=false` বা `REDIS_URL` না থাকলে অ্যাপ ক্র্যাশ করে না —
ক্যাশ সরাসরি DB fallback-এ চলে যায় (পারফরম্যান্স কমে, কার্যকারিতা অক্ষুণ্ণ থাকে)।

```bash
docker compose -f docker-compose.yml exec redis redis-cli -a "$REDIS_PASSWORD" ping   # PONG
```

অ্যাপের দৃষ্টিতে Redis-এর অবস্থা: `/admin/cache` পেজ, অথবা প্রতি ঘণ্টার
`cache_health_check` cron জব (`/admin/cron-jobs`)।

---

## ৫. প্রোডাকশন স্ট্যাক চালু করা

```bash
docker compose -f docker-compose.yml up -d --build          # app + db + redis + monitoring
docker compose -f docker-compose.yml up -d --build app db redis   # মনিটরিং ছাড়া
docker compose -f docker-compose.yml ps
```

---

## ৬. হেলথ ভেরিফিকেশন (ডিপ্লয়ের পরেই)

```bash
curl -f http://localhost:${PORT:-3000}/health      # অ্যাপ + নির্ভরতার অবস্থা
curl -f http://localhost:${PORT:-3000}/ready       # 200 = ট্রাফিক নেওয়ার জন্য প্রস্তুত, 503 = নয়
curl -i http://localhost:${PORT:-3000}/metrics     # টোকেন ছাড়া 401 আসা **উচিত**
curl -f -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:${PORT:-3000}/metrics
```

`/ready` 503 দিলে লোড ব্যালান্সারে যুক্ত করার আগে DB/Redis কানেকশন ঠিক করতে হবে।

---

## ৭. ব্যাকআপ ভেরিফিকেশন

- অটো-ব্যাকআপ সার্ভার স্টার্টের ৫ মিনিট পর প্রথমবার, তারপর প্রতি `BACKUP_SCHEDULE_HOURS`
  ঘণ্টায় (database + uploads + config), প্রতি টাইপে সর্বশেষ ১৪টা রাখা হয়।
- **ব্যর্থ হলে** `system` ক্যাটাগরিতে একবার Telegram অ্যালার্ট যায়; সফল হলে কোনো
  নোটিফিকেশন যায় না।
- তালিকা ও স্ট্যাটাস: `/admin/backups` (permission: `backups_manage`)।

কনটেইনারে ব্যাকআপ ডিরেক্টরি লেখা যাচ্ছে কি না:

```bash
docker compose -f docker-compose.yml exec app sh -c 'touch /app/backups/.probe && rm /app/backups/.probe && echo writable'
```

ভলিউম মাউন্ট-পাথ (`/app/backups`, `/app/public/uploads`) ইমেজেই তৈরি ও `nodejs`
ইউজারের মালিকানায় দেওয়া আছে — না হলে Docker সেগুলো `root:root` বানাত এবং
নন-রুট কনটেইনার লিখতে পারত না।

---

## ৮. রিস্টোর

`/admin/backups` → নির্দিষ্ট ব্যাকআপে **Restore**।

- রিস্টোরের আগে SHA-256 checksum যাচাই হয় — ফাইল কারাপ্টেড হলে রিস্টোর বাতিল হয়।
- রিস্টোর **নন-ডেস্ট্রাক্টিভ**: বিদ্যমান রেকর্ড মুছে বা ওভাররাইট করে না, শুধু
  অনুপস্থিত রেকর্ড যোগ করে। অর্থাৎ "ভুল ডেটা মুছে দিতে" রিস্টোর কাজে আসবে না।
- ডাউনলোড করে বাইরে যাচাই করতে চাইলে: `/admin/backups/:id/download`।

---

## ৯. রিস্টার্ট / রিকভারি

```bash
docker compose -f docker-compose.yml restart app
docker compose -f docker-compose.yml logs -f app        # বুট লগ দেখো
curl -f http://localhost:${PORT:-3000}/ready            # সুস্থ হয়েছে কি না
```

- অ্যাপ কনটেইনার `db` ও `redis` **healthy** না হওয়া পর্যন্ত অপেক্ষা করে
  (`condition: service_healthy`), তাই রিস্টার্টের ক্রম নিয়ে ভাবতে হয় না।
- ডেটা `db_data` / `redis_data` / `uploads_data` / `backups_data` ভলিউমে থাকে —
  কনটেইনার রিক্রিয়েট করলেও থাকে। `docker compose down -v` **ভলিউমসহ মুছে ফেলে** —
  প্রোডাকশনে এটা চালানো যাবে না।
- অ্যাডমিন পাসওয়ার্ড হারালে: `/internal/reset-admin` (আলাদা টোকেন-গেটেড, README দ্রষ্টব্য)।

---

## ১০. রোলব্যাক

```bash
git log --oneline -10
git checkout <আগের-known-good-sha>
docker compose -f docker-compose.yml up -d --build
curl -f http://localhost:${PORT:-3000}/ready
```

⚠️ **মাইগ্রেশন রোলব্যাক হয় না।** মাইগ্রেশনগুলো শুধু যোগ করে (`CREATE TABLE/INDEX/COLUMN
IF NOT EXISTS`), কিছু ড্রপ করে না — তাই পুরনো কোডে ফিরে গেলে অতিরিক্ত কলাম/ইনডেক্স
থেকে যায়, যা নিরীহ। কিন্তু নতুন কলামের উপর নির্ভরশীল ডেটা পুরনো কোড পড়বে না।
ডেটা-ক্ষতির ঝুঁকি থাকলে রোলব্যাকের **আগে** `/admin/backups` থেকে ম্যানুয়াল ব্যাকআপ নাও।

---

## ১১. ডিপ্লয়ের পর যা যা দেখতে হবে

- [ ] `docker compose -f docker-compose.yml ps` — সব সার্ভিস `Up (healthy)`
- [ ] `/health` ও `/ready` — দুটোই 200
- [ ] `/metrics` — টোকেন ছাড়া 401, টোকেনসহ 200
- [ ] অ্যাপ লগে `❌ Migration error:` নেই
- [ ] `/admin` লগইন হয় এবং ড্যাশবোর্ড লোড হয়
- [ ] `/admin/cron-jobs` — জবগুলো seeded ও enabled
- [ ] `/admin/backups` — প্রথম শিডিউলড ব্যাকআপ (৫ মিনিট পর) `completed`
- [ ] Telegram অ্যালার্ট কনফিগার করা থাকলে `/admin/telegram` থেকে টেস্ট মেসেজ যায়
- [ ] Grafana ড্যাশবোর্ডে ডেটা আসছে (মনিটরিং স্ট্যাক চালু থাকলে)

---

## ১২. কিছু ভেঙে গেলে কোথায় দেখব

| উপসর্গ | প্রথমে দেখো |
|---|---|
| অ্যাপ উঠছে না | `docker compose -f docker-compose.yml logs app` |
| `/ready` 503 | DB/Redis কনটেইনারের health, `DATABASE_URL`/`REDIS_URL` |
| ব্যাকআপ ব্যর্থ | Telegram অ্যালার্ট, `/admin/backups` error column, ডিস্ক স্পেস |
| ৫০০ এরর বাড়ছে | `/admin/logs` (error_logs), Sentry, Grafana Error Rate |
| সাইট ধীর | Grafana Response Time, `/admin/cache` (Redis connected?) |
| লগইন/সিকিউরিটি সন্দেহ | `/admin/login-history`, `/admin/fraud-logs`, `/admin/audit-logs` |
