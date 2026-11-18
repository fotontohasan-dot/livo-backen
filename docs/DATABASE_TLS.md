# ডাটাবেস TLS যাচাই (Neon / Render)

## আচরণ (db.js → `resolveSslConfig`)
| পরিবেশ | `DATABASE_SSL_INSECURE=true` হলে |
|---|---|
| প্রোডাকশন (`NODE_ENV=production`, `APP_ENV` staging নয়) | **বুট ব্যর্থ** (throw) — অ্যাপ চালু হবে না |
| staging (`APP_ENV=staging`) | শুধু সতর্কতা লগ; যাচাই বন্ধ থাকে |
| ডিফল্ট (ভ্যারিয়েবল খালি) | যাচাই চালু (প্রোডাকশন), `rejectUnauthorized: true` |

`DATABASE_SSL=false` এবং `NODE_ENV=test` সবকিছুর ওপরে — SSL বন্ধ।

## Neon
1. কানেকশন স্ট্রিংয়ে `?sslmode=verify-full` রাখুন (Neon-এর সার্টিফিকেট পাবলিক CA-সাইন্ড, তাই আলাদা CA লাগে না)।
2. `DATABASE_SSL_INSECURE` ভ্যারিয়েবলটি মুছে দিন।
3. কানেক্ট না হলে Neon ড্যাশবোর্ডের "Connection details" থেকে হোস্টনাম সঠিক কিনা মিলিয়ে নিন (হোস্ট না মিললে verify-full ব্যর্থ হয়)।

## Render PostgreSQL
1. সম্ভব হলে Internal Database URL ব্যবহার করুন।
2. External URL-এ self-signed হলে CA সার্টিফিকেট (PEM) পুরোটা `DATABASE_CA_CERT`-এ বসান (Environment → Add; নতুন লাইনসহ)। তখন `{ rejectUnauthorized: true, ca }` কাজ করে।
3. `DATABASE_SSL_INSECURE` মুছুন, ডিপ্লয় করে লগে `PostgreSQL connected` দেখুন।

## staging
staging-এ CA না দিলে যাচাই বন্ধ থাকে (সতর্কতাসহ)। `DATABASE_CA_CERT` দিলে staging-ও যাচাইসহ চলে।
