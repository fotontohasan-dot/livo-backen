# বাজির ওপর ৩-ধাপ রেফারেল কমিশন — বন্ধ (ডিফল্ট ০) ও টার্নওভার ডিফল্ট ৫

## কী বদলেছে (কোডে)
| ফাইল | বদল |
|---|---|
| `services/settings.js` `DEFAULTS` | `referral_commission_tier1/2/3_percent` = `'0'` (আগে 2.5/1.5/0.8); `turnover_multiplier` = `'5'` (আগে `'3'`) |
| `services/referral.js` | `DEFAULT_COMMISSION_RATES = [0,0,0]`; `distributeCommission` তিন হারই ০ হলে `pool.connect()`/`BEGIN`-এর **আগেই** ফিরে আসে (কোনো ট্রানজ্যাকশন/সারি নয়) |
| `views/admin/settings.ejs` | ফর্মের ফলব্যাক: turnover `5`, কমিশন `0` |
| `migrations.js` | সিড `turnover_multiplier` = `'5'` (`ON CONFLICT (key) DO NOTHING`) |

কমিশন সেটিংয়ের কোনো সিড-সারি migrations-এ ছিল না; নতুন DB-তে মান আসে `DEFAULTS` থেকে (সারি না থাকলে)।

## বিদ্যমান DB-তে কী ঘটবে
- **সেভ-করা সারি থাকলে** (`site_settings`-এ key আছে): মান অপরিবর্তিত, অর্থাৎ পুরোনো হারই চলবে। জোর করে বদলানো হয়নি।
- **সারি না থাকলে** (অ্যাডমিন কখনো সেভ করেনি): নতুন ডিফল্ট `0` প্রযোজ্য, কমিশন বন্ধ হয়ে যাবে।
- `turnover_multiplier`: আগের সিড-সারি `'3'` থাকলে `DO NOTHING`-এর কারণে `3`-ই থাকবে।

## প্রোডাকশনে বন্ধ/চালু করতে কী বদলাতে হবে (অ্যাডমিন UI বা SQL)
অ্যাডমিন → সেটিংস → "রেফারেল কমিশন (মাল্টি-লেভেল, বাজির উপর)" থেকে তিন Tier-কে `0` দিন, অথবা:

```sql
-- বর্তমান মান দেখুন
SELECT key, value FROM site_settings
 WHERE key IN ('referral_commission_tier1_percent','referral_commission_tier2_percent',
               'referral_commission_tier3_percent','turnover_multiplier');

-- কমিশন সম্পূর্ণ বন্ধ (বিদ্যমান সারি থাকলে বা না থাকলে দুই ক্ষেত্রেই)
INSERT INTO site_settings (key, value) VALUES
  ('referral_commission_tier1_percent','0'),
  ('referral_commission_tier2_percent','0'),
  ('referral_commission_tier3_percent','0')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- টার্নওভার ৫ (শুধু চাইলে)
UPDATE site_settings SET value = '5' WHERE key = 'turnover_multiplier';

-- আগের হারে ফেরাতে
UPDATE site_settings SET value = '2.5' WHERE key = 'referral_commission_tier1_percent';
UPDATE site_settings SET value = '1.5' WHERE key = 'referral_commission_tier2_percent';
UPDATE site_settings SET value = '0.8' WHERE key = 'referral_commission_tier3_percent';
```
সেটিং ক্যাশ ৩০ সেকেন্ডের (Redis + মেমরি), SQL-এর পর সর্বোচ্চ ~৩০ সেকেন্ড লাগতে পারে।

## ৩-ধাপ কমিশনের UI টেক্সট (তালিকা — বদলানো হয়নি)
| কী | বাংলা/ইংরেজি | কোথায় |
|---|---|---|
| `referral_terms` (`locales/bn.json:648`, `en.json:648`) | "…আজীবন কমিশন (২.৫% / ১.৫% / ০.৮%)" | ইউজার রেফারেল শর্ত |
| `ref_tagline` (`bn.json:2438`, `en.json:2438`) | একই বাক্য, ২.৫/১.৫/০.৮% | ইউজার রেফারেল পাতার ট্যাগলাইন |
| `ref_commission` (`:2441`) | "কমিশন (লেভেল {level})" | ইউজারের কমিশন ইতিহাস |
| `adms_referral_commission` (`:2543`) | "রেফারেল কমিশন (মাল্টি-লেভেল, বাজির উপর)" | অ্যাডমিন সেটিংস শিরোনাম |
| `adms_tier1` (`:2544`) | "Tier 1 — সরাসরি রেফার (%)" | অ্যাডমিন সেটিংস ফিল্ড |
| (হার্ডকোড) `views/admin/settings.ejs:62-63` | "Tier 2 (%)", "Tier 3 (%)" | অ্যাডমিন সেটিংস ফিল্ড |

> ইউজারকে দেখানো `referral_terms`/`ref_tagline` এখনো ২.৫/১.৫/০.৮% দাবি করে, অথচ কমিশন বন্ধ। প্রোডাকশনে চালুর আগে টেক্সট বদলানো দরকার (এই কাজে বদলানো হয়নি)।
