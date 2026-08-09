// services/envValidator.js
// ---------------------------------------------------------------------------
// Environment Variable Validation — সার্ভার বুট হওয়ার আগেই (require('dotenv').config()
// এর ঠিক পরে) কল করা হয়। ক্রিটিক্যাল ভ্যারিয়েবল (DATABASE_URL, SESSION_SECRET) প্রোডাকশনে
// অনুপস্থিত/ভুল ফরম্যাটে থাকলে সার্ভার বুটই হয় না (fail-fast) — যাতে ভুল কনফিগারেশন নিয়ে
// সাইলেন্টলি রান হয়ে ডেটা-লস/সিকিউরিটি সমস্যা তৈরি না হয়। ডেভেলপমেন্টে শুধু warning দেয়,
// বুট আটকায় না (স্থানীয় ডেভেলপমেন্ট অভিজ্ঞতা যেন না ভাঙে)।
//
// ঐচ্ছিক ইন্টিগ্রেশন (Cloudinary, Email, SSLCommerz, VAPID, Telegram) আংশিকভাবে
// কনফিগার করা থাকলে (কিছু কী আছে, কিছু নেই) সেটা প্রায় সবসময়ই ভুল কনফিগারেশনের লক্ষণ —
// এক্ষেত্রে সার্ভার বুট আটকানো হয় না (কারণ ওই ফিচারগুলো ঐচ্ছিক), শুধু স্পষ্ট warning দেওয়া হয়।
// ---------------------------------------------------------------------------

const REQUIRED_ALWAYS = ['DATABASE_URL'];
const REQUIRED_IN_PRODUCTION = ['SESSION_SECRET'];

const OPTIONAL_GROUPS = {
  Cloudinary: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
  Email: ['EMAIL_USER', 'EMAIL_PASS'],
  SSLCommerz: ['SSLCZ_STORE_ID', 'SSLCZ_STORE_PASSWD'],
  'Web Push (VAPID)': ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
  Telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
  Redis: ['REDIS_URL'] // একা থাকলেও যথেষ্ট (REDIS_HOST/PORT ফলব্যাক আছে), তাই গ্রুপ-চেক প্রযোজ্য না — এখানে শুধু তথ্যের জন্য
};

function maskSecret(value) {
  if (!value) return '(not set)';
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '...' + value.slice(-2);
}

/** DATABASE_URL-এর ফরম্যাট বৈধ কিনা (postgres:// বা postgresql://) যাচাই করে,
 *  কিন্তু কনসোলে কখনো পুরো কানেকশন-স্ট্রিং (পাসওয়ার্ডসহ) প্রিন্ট করে না। */
function validateDatabaseUrl(url) {
  if (!url) return { valid: false, reason: 'সেট করা নেই' };
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return { valid: false, reason: 'postgres:// অথবা postgresql:// দিয়ে শুরু হতে হবে' };
  }
  return { valid: true };
}

function validateSessionSecret(secret) {
  if (!secret) return { valid: false, reason: 'সেট করা নেই' };
  if (secret.length < 32) return { valid: false, reason: 'অন্তত ৩২ ক্যারেক্টার লম্বা হওয়া উচিত (বর্তমানে দুর্বল)' };
  return { valid: true };
}

/** @returns {{ok: boolean, errors: string[], warnings: string[]}} */
function validateEnv() {
  const isProd = process.env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];

  // ---- সবসময় আবশ্যক ----
  for (const key of REQUIRED_ALWAYS) {
    if (!process.env[key]) {
      errors.push(`${key} সেট করা নেই (আবশ্যক)`);
    }
  }
  const dbCheck = validateDatabaseUrl(process.env.DATABASE_URL);
  if (process.env.DATABASE_URL && !dbCheck.valid) {
    errors.push(`DATABASE_URL ফরম্যাট সঠিক নয় — ${dbCheck.reason}`);
  }

  // ---- শুধু প্রোডাকশনে আবশ্যক ----
  if (isProd) {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!process.env[key]) {
        errors.push(`${key} প্রোডাকশনে সেট করা আবশ্যক`);
      }
    }
    const secretCheck = validateSessionSecret(process.env.SESSION_SECRET);
    if (process.env.SESSION_SECRET && !secretCheck.valid) {
      errors.push(`SESSION_SECRET দুর্বল — ${secretCheck.reason}`);
    }
  } else {
    const secretCheck = validateSessionSecret(process.env.SESSION_SECRET);
    if (process.env.SESSION_SECRET && !secretCheck.valid) {
      warnings.push(`SESSION_SECRET দুর্বল — ${secretCheck.reason} (ডেভেলপমেন্টে সতর্কতা মাত্র)`);
    }
  }

  // ---- ঐচ্ছিক ইন্টিগ্রেশন গ্রুপ — আংশিক কনফিগার থাকলে warning ----
  for (const [name, keys] of Object.entries(OPTIONAL_GROUPS)) {
    if (keys.length < 2) continue; // একক-কী গ্রুপে আংশিকতার প্রশ্ন নেই
    const present = keys.filter(k => !!process.env[k]);
    if (present.length > 0 && present.length < keys.length) {
      const missing = keys.filter(k => !process.env[k]);
      warnings.push(`${name}: আংশিক কনফিগার করা — অনুপস্থিত: ${missing.join(', ')} (এই ইন্টিগ্রেশন কাজ নাও করতে পারে)`);
    }
  }

  // ---- প্রোডাকশনে Redis কনফিগার করা না থাকলে warning (fail-fast নয়, শুধু সতর্কতা) ----
  // Redis ছাড়াও অ্যাপ চলবে (cache/rate-limit স্বয়ংক্রিয়ভাবে in-memory/DB ফলব্যাকে যায়),
  // কিন্তু একাধিক ইনস্ট্যান্স/কন্টেইনার চললে rate-limit কাউন্টার শেয়ার্ড থাকে না এবং
  // ক্যাশ প্রতি-ইনস্ট্যান্স আলাদা থাকে — তাই প্রোডাকশন অপারেটরকে সতর্ক করা হয়।
  if (isProd) {
    const redisEnabled = String(process.env.REDIS_ENABLED || 'true').toLowerCase() !== 'false';
    const hasRedisConfig = !!(process.env.REDIS_URL || process.env.REDIS_HOST);
    if (!redisEnabled) {
      warnings.push('Redis: REDIS_ENABLED=false — প্রোডাকশনে cache ও rate-limit in-memory/DB ফলব্যাকে চলবে (একাধিক ইনস্ট্যান্স থাকলে rate-limit শেয়ার্ড থাকবে না)');
    } else if (!hasRedisConfig) {
      warnings.push('Redis: REDIS_URL/REDIS_HOST কোনোটাই সেট করা নেই — প্রোডাকশনে cache ও rate-limit in-memory/DB ফলব্যাকে চলবে (একাধিক ইনস্ট্যান্স থাকলে rate-limit শেয়ার্ড থাকবে না)');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** app.js বুটের শুরুতে কল করা হয়। প্রোডাকশনে error থাকলে process.exit(1)। */
function runStartupValidation() {
  const isProd = process.env.NODE_ENV === 'production';
  const { ok, errors, warnings } = validateEnv();

  if (warnings.length > 0) {
    console.warn('⚠️ Environment Variable সতর্কতা:');
    warnings.forEach(w => console.warn('   - ' + w));
  }

  if (!ok) {
    console.error('❌ Environment Variable ভ্যালিডেশন ব্যর্থ:');
    errors.forEach(e => console.error('   - ' + e));
    if (isProd) {
      console.error('❌ প্রোডাকশনে এই ত্রুটিগুলো ঠিক না করা পর্যন্ত সার্ভার বুট হবে না।');
      process.exit(1);
    } else {
      console.warn('⚠️ ডেভেলপমেন্ট মোড — সার্ভার তবুও চালু হচ্ছে, কিন্তু উপরের সমস্যাগুলো ঠিক করা উচিত।');
    }
  } else {
    console.log('✅ Environment Variable ভ্যালিডেশন সফল');
  }

  return { ok, errors, warnings };
}

module.exports = { validateEnv, runStartupValidation, maskSecret };
