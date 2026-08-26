#!/usr/bin/env node
// scripts/i18n-scan.js
// ---------------------------------------------------------------------------
// লোকালাইজেশন স্ক্যানার — কোনো প্রোডাকশন কোড বদলায় না, শুধু রিপোর্ট করে।
//
// তিনটা জিনিস মাপে:
//   ১. locale key parity — bn.json ও en.json-এ একই key আছে কি না, আর কোনো মান
//      দুই ফাইলে হুবহু এক কি না (মানে অনুবাদ হয়নি)।
//   ২. missing key — EJS টেমপ্লেটে <%= t.foo %> লেখা আছে কিন্তু locale-এ foo নেই।
//      app.js-এর Proxy এমন ক্ষেত্রে key-এর নামটাই রেন্ডার করে দেয়, তাই ইউজার
//      "description" বা "amount"-এর মতো কাঁচা key দেখতে পায়।
//   ৩. hardcoded Bengali — টেমপ্লেটে সরাসরি বসানো বাংলা টেক্সট, যেগুলো English
//      লোকেলেও বাংলাই থেকে যায়।
//
// ব্যবহার:  node scripts/i18n-scan.js [--json]
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BENGALI = /[\u0980-\u09FF]/;

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

function loadLocales() {
  const bn = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'bn.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
  return { bn, en };
}

// EJS-এ যেসব key সত্যিই আউটপুট হিসেবে বসানো হয়েছে।
// `transactions.forEach(t => ...)`-এর মতো জায়গায় `t` একটা লুপ ভেরিয়েবল, অনুবাদ প্রক্সি নয় —
// তাই শুধু <%= t.key %> / <%= t('key') %> আকারের আউটপুট ট্যাগই গোনা হয়, এবং যেসব
// ফাইলে `t` শ্যাডো করা হয়েছে সেখানে লুপের ভেতরের অংশ বাদ দেওয়া হয়।
function usedKeys(files) {
  const used = new Map();
  const add = (k, f) => {
    if (!used.has(k)) used.set(k, new Set());
    used.get(k).add(path.relative(ROOT, f));
  };
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const shadowed = /\(\s*t\s*=>|\(\s*t\s*,|function\s*\(\s*t\s*[),]|forEach\(t\b|map\(t\b/.test(src);
    for (const m of src.matchAll(/<%[-=]\s*(?:locals\.)?t\.([A-Za-z_][A-Za-z0-9_]*)\s*%>/g)) {
      if (shadowed && /^(id|name|amount|status|description|created_at|type|label|icon|sport|body|subject|channel|lang|min|bonus|bonus_amount|entry_fee|prize_pool|participant_count|max_participants|min_turnover)$/.test(m[1])) {
        // শ্যাডো করা ফাইলে এই নামগুলো ডেটা ফিল্ড হওয়ার সম্ভাবনাই বেশি — ভুল রিপোর্ট এড়াতে বাদ
        continue;
      }
      add(m[1], f);
    }
    for (const m of src.matchAll(/<%[-=]\s*(?:locals\.)?t\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)\s*%>/g)) add(m[1], f);
  }
  return used;
}

// টেমপ্লেটের দৃশ্যমান টেক্সটে হার্ডকোড করা বাংলা। EJS লজিক, <script>, <style> এবং
// HTML কমেন্ট বাদ দেওয়া হয় — ওগুলো ইউজারের চোখে পড়ে না।
function hardcodedBengali(files) {
  const report = [];
  for (const f of files) {
    let src = fs.readFileSync(f, 'utf8');
    src = src.replace(/<%[\s\S]*?%>/g, ' ');
    src = src.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    src = src.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    src = src.replace(/<!--[\s\S]*?-->/g, ' ');

    const hits = new Set();
    for (const m of src.matchAll(/>([^<>]*)</g)) {
      const text = m[1].trim();
      if (text && BENGALI.test(text)) hits.add(text.slice(0, 80));
    }
    for (const m of src.matchAll(/(?:placeholder|title|alt|aria-label)\s*=\s*"([^"]*)"/g)) {
      if (BENGALI.test(m[1])) hits.add(m[1].slice(0, 80));
    }
    if (hits.size) report.push({ file: path.relative(ROOT, f), count: hits.size, samples: [...hits].slice(0, 3) });
  }
  return report.sort((a, b) => b.count - a.count);
}

function main() {
  const { bn, en } = loadLocales();
  const ejs = walk(path.join(ROOT, 'views'), '.ejs');

  const bnKeys = Object.keys(bn);
  const enKeys = Object.keys(en);
  const missingInEn = bnKeys.filter((k) => !(k in en));
  const missingInBn = enKeys.filter((k) => !(k in bn));
  const untranslated = bnKeys.filter((k) => k in en && bn[k] === en[k] && BENGALI.test(bn[k]) === false && bn[k].length > 2);

  const used = usedKeys(ejs);
  const missingKeys = [...used.keys()].filter((k) => !(k in bn)).sort();
  const hardcoded = hardcodedBengali(ejs);
  const hardcodedTotal = hardcoded.reduce((a, x) => a + x.count, 0);

  const result = {
    localeKeys: { bn: bnKeys.length, en: enKeys.length, missingInEn, missingInBn, untranslated },
    templates: { scanned: ejs.length, keysUsed: used.size, missingKeys },
    hardcodedBengali: { files: hardcoded.length, strings: hardcodedTotal, worst: hardcoded.slice(0, 20) }
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`locale keys      : bn=${bnKeys.length} en=${enKeys.length}`);
  console.log(`key parity       : missingInEn=${missingInEn.length} missingInBn=${missingInBn.length}`);
  console.log(`untranslated     : ${untranslated.length} ${untranslated.slice(0, 8).join(', ')}`);
  console.log(`templates scanned: ${ejs.length}, keys used: ${used.size}`);
  console.log(`MISSING KEYS     : ${missingKeys.length} ${missingKeys.slice(0, 12).join(', ')}`);
  console.log(`hardcoded Bengali: ${hardcodedTotal} strings in ${hardcoded.length} files`);
  for (const h of hardcoded.slice(0, 15)) console.log(`   ${String(h.count).padStart(4)}  ${h.file}`);
}

if (require.main === module) main();
module.exports = { loadLocales, usedKeys, hardcodedBengali, walk };
