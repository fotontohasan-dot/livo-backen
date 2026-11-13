# ওয়ালেট callback (bKash / Nagad / Rocket / Upay) — মালিকের জন্য

`POST /wallet-callback/:provider` কোড লেখার সময় আসল প্রোভাইডার ডক দেখা হয়নি। তাই নিচের **ডিফল্ট মানগুলো আন্দাজ**।
এখন প্রতিটা আন্দাজ-করা মান env দিয়ে বদলানো যায় (ডিফল্ট আগের মতোই)। প্রোডাকশনে চালুর আগে প্রতিটা ওয়ালেটের আসল
মার্চেন্ট ডক বা sandbox থেকে নিচের তথ্য নিয়ে মিলিয়ে নিন। **মিলে না গেলে ওই ওয়ালেটের callback চালু করবেন না।**

কিছু সেট না থাকলে (secret / public key) ওই ওয়ালেটের **সব callback প্রত্যাখ্যাত** হয় (fail-closed)। বুটে কোন
ওয়ালেটের secret/key নেই তা সতর্কতা হিসেবে লগে আসে (মান নয়, শুধু env-এর নাম)।

## প্রতিটা ওয়ালেটের জন্য প্রোভাইডার থেকে যা নিতে হবে

| # | তথ্য | কেন | env (`<W>` = `BKASH` / `NAGAD` / `ROCKET` / `UPAY`) |
|---|---|---|---|
| 1 | signature যে header-এ আসে | নইলে সব callback 401 | `WALLET_CALLBACK_<W>_SIG_HEADER` |
| 2 | signature অ্যালগরিদম: `hmac-sha256` বা `rsa-sha256` | কোন credential লাগবে ঠিক করে | `WALLET_CALLBACK_<W>_ALGO` |
| 3 | HMAC-এর আউটপুট `hex` না `base64` (RSA সবসময় base64) | তুলনা মেলার জন্য | `WALLET_CALLBACK_<W>_ENCODING` |
| 4 | secret (HMAC) বা public key (RSA, PEM; `.env`-এ এক লাইনে `\n` দিয়ে) | যাচাইয়ের চাবি | `WALLET_CALLBACK_<W>_SECRET` / `_PUBLIC_KEY` |
| 5 | ঠিক কোন বাইটের ওপর signature: শুধু raw body, নাকি timestamp+body | ভুল হলে সব ব্যর্থ | `WALLET_CALLBACK_<W>_SIGNED_FORMAT` = `body` বা `ts+body` |
| 6 | callback পাঠানোর IP তালিকা | IP allowlist | `WALLET_CALLBACK_<W>_IPS` (কমা-ভাগ, **হুবহু IP; CIDR চলে না**) |
| 7 | timestamp পাঠায় কিনা, কোন header-এ, সেকেন্ড না মিলিসেকেন্ড, signature-এ ঢুকেছে কিনা | replay ঠেকাতে | `WALLET_CALLBACK_<W>_TS_HEADER` (খালি = বন্ধ) |
| 8 | sandbox-এর আসল JSON নমুনা: field নাম, amount ফরম্যাট, status-এর মান, currency আছে কিনা | payload মেলাতে | নিচের `FIELD_*` ও `SUCCESS_VALUES` |
| 9 | retry নীতি (কোন status কোডে আবার পাঠায়) | 200/400/401/500 আচরণ মেলাতে | (কোডে স্থির) |

### ডিফল্ট (আন্দাজ) মান — প্রোভাইডার ডকের সাথে মেলান

| | bKash | Nagad | Rocket | Upay |
|---|---|---|---|---|
| `SIG_HEADER` | `x-bkash-signature` | `x-nd-signature` | `x-rocket-signature` | `x-upay-signature` |
| `ALGO` / `ENCODING` | hmac-sha256 / hex | rsa-sha256 / base64 | hmac-sha256 / hex | hmac-sha256 / hex |
| `SIGNED_FORMAT` | body | body | body | body |
| `TS_HEADER` | বন্ধ | বন্ধ | বন্ধ | বন্ধ |
| `FIELD_TRX_ID` | trxID, trxId, transactionId | issuerPaymentRefNo, merchantOrderId, orderId | txnId, trx_id, transactionId | transactionId, trx_id, txn_id |
| `FIELD_AMOUNT` | amount | amount | amount | amount |
| `FIELD_STATUS` | transactionStatus, status | status | status | status |
| `FIELD_CURRENCY` | currency | currency | currency | currency |
| `FIELD_PAYER` | customerMsisdn, payerAccount | clientMobileNo | sender | sender |
| `FIELD_PAYMENT_ID` | paymentID, paymentId | paymentRefId | reference | merchantTxnId |
| `SUCCESS_VALUES` (status-এর কোন মান সফল) | completed | success | success, completed, successful | success, completed, successful |

`FIELD_*` ও `SUCCESS_VALUES` কমা-ভাগ তালিকা; প্রথম যে নাম body-তে পাওয়া যায় সেটা নেওয়া হয়। `SUCCESS_VALUES` ছোট হাতের অক্ষরে তুলনা হয়।
উদাহরণ: `WALLET_CALLBACK_BKASH_FIELD_TRX_ID=trxID`.

### কোডে স্থির — env দিয়ে বদলায় না (প্রোভাইডার আলাদা হলে কোড বদলাতে হবে)
- body শুধু **JSON object**; form-encoded বা nested field (যেমন `data.amount`) পড়া হয় না, শুধু উপরের স্তরের key।
- trxId: ১–৬৪ অক্ষর, শুধু `A-Za-z0-9_-`। amount: ধনাত্মক, সর্বোচ্চ ২ দশমিক (string বা number)।
- currency না থাকলে `BDT` ধরা হয়; `BDT` ছাড়া অন্য হলে পরিমাণ-অমিল হিসেবে জমা হয় না (সেটেলমেন্ট নিয়ম, বদলানো হয়নি)।
- callback দিয়ে কোনো নতুন ডিপোজিট হয় না; ব্যবহারকারীর তোলা pending ডিপোজিটের `transaction_id` যদি callback-এর trxId-র সাথে হুবহু মেলে এবং পরিমাণ মেলে, তবেই ব্যালেন্স যোগ হয়।
- timestamp-যুক্ত `ts+body` মানে timestamp-এর লেখা সরাসরি raw body-র **আগে** জোড়া (মাঝে কোনো বিভাজক নেই)। প্রোভাইডারের ফরম্যাট আলাদা হলে কোড বদলাতে হবে।

## timestamp (replay) যাচাই — ঐচ্ছিক, ডিফল্ট বন্ধ
- চালু করতে `WALLET_CALLBACK_<W>_TS_HEADER=<header নাম>` দিন। তখন header না থাকলে বা সময়ের ব্যবধান বেশি হলে 401।
- সর্বোচ্চ বয়স: `WALLET_CALLBACK_<W>_WINDOW_SECONDS`, না থাকলে `WALLET_CALLBACK_WINDOW_SECONDS`, না থাকলে ৩০০ সেকেন্ড (৫ মিনিট)। timestamp সেকেন্ড বা মিলিসেকেন্ড, দুটোই বোঝা যায়।
- **সতর্কতা:** timestamp যদি signature-এর অংশ না হয় (`SIGNED_FORMAT=body`), আক্রমণকারী পুরনো callback নতুন timestamp দিয়ে আবার পাঠাতে পারে, তাই এই যাচাই প্রায় অকেজো। প্রোভাইডার timestamp signature-এ ঢোকালে `SIGNED_FORMAT=ts+body` দিন। বুটে এই অবস্থার সতর্কতা আসে।
- timestamp বন্ধ থাকলে replay ঠেকায় শুধু "একবারই pending → approved" নিয়ম (একই callback দুইবার এলে দ্বিতীয়বার ব্যালেন্স যোগ হয় না)।

## IP allowlist ও proxy
- `_IPS` খালি থাকলে কোনো IP যাচাই হয় না, শুধু signature। থাকলে `req.ip` মিলিয়ে দেখা হয়।
- `req.ip` নির্ভর করে `TRUST_PROXY_HOPS`-এর ওপর (ডিফল্ট ১, Render-এর একটা proxy)। hop সংখ্যা ভুল হলে allowlist ভুল IP দেখবে। staging/prod-এ সত্যিকারের callback এসে লগে `ip=` দেখে নিশ্চিত হন।

## অবৈধ কনফিগ
`ALGO`, `ENCODING`, `SIGNED_FORMAT`, header বা `FIELD_*`-এ ভুল মান দিলে ওই ওয়ালেটের callback **প্রত্যাখ্যাত** হয় (ডিফল্টে নীরবে ফিরে যায় না), আর বুটে কোন env ভুল তা লগে আসে।

## চালুর আগে চেকলিস্ট (প্রতিটা ওয়ালেটের জন্য)
- [ ] ওপরের ১–৮ নম্বর তথ্য প্রোভাইডার থেকে লিখিত আকারে পাওয়া গেছে
- [ ] staging-এ sandbox callback পাঠিয়ে একটা pending ডিপোজিট সফলভাবে `credited` হয়েছে
- [ ] ভুল signature পাঠালে 401, পুরনো timestamp (চালু থাকলে) 401 পাওয়া গেছে
- [ ] IP allowlist ও `TRUST_PROXY_HOPS` লগের `ip=` দিয়ে যাচাই হয়েছে
