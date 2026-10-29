# Render-এ যা নিজে সেট করতে হবে (Dashboard → Service → Environment)

| লগ সতর্কতা | সমাধান |
|---|---|
| `DATABASE_SSL_INSECURE চালু` | ভ্যারিয়েবলটি মুছুন। কানেক্ট না হলে Render Postgres-এর CA সার্টিফিকেট `DATABASE_CA_CERT`-এ বসান, অথবা Render-এর Internal Database URL ব্যবহার করুন। মুছে ডিপ্লয় করে `PostgreSQL connected` লগ দেখুন; ব্যর্থ হলে আবার চালু করে আমাকে জানান। |
| `TELEGRAM_ADMIN_USER_IDS` নেই | আপনার Telegram numeric user id দিন (@userinfobot থেকে পাবেন)। একাধিক হলে কমা দিয়ে। |
| `REDIS_URL` নেই | Render → New → Key Value (Redis) বানিয়ে Internal URL `REDIS_URL`-এ দিন। না দিলে অ্যাপ DB ফলব্যাকে চলে (একক ইনস্ট্যান্সে সমস্যা নেই)। |
| `METRICS_TOKEN` নেই | Prometheus/মনিটরিং না চালালে ঐচ্ছিক। চালালে: `openssl rand -hex 24` দিয়ে টোকেন বানিয়ে বসান। |
| LIVE API | `LIVE_MERCHANT_CODE`, `LIVE_AES_KEY` (১৬/২৪/৩২ অক্ষর), `LIVE_MD5_KEY` দিন। `LIVE_API_ROOT` (ডিফল্ট `https://api.obothapi.com/api/merchant/`) ও `LIVE_API_VERSION` (ডিফল্ট `v2`) ঐচ্ছিক এবং Render সার্ভারের outbound IP প্ল্যাটফর্মে whitelist করান। |

## ডুপ্লিকেট TrxID
Render Shell-এ `node scripts/auditDuplicateTrxId.js` চালান (শুধু দেখায়, কিছু বদলায় না)।
