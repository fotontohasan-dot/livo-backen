#!/usr/bin/env node
// scripts/i18n-apply2.js
// ---------------------------------------------------------------------------
// i18n-apply.js-এর সম্পূরক। ওটা শুধু পুরো টেক্সট-নোড (`>টেক্সট<`) বদলায়, কিন্তু
// বাস্তবে প্রচুর জায়গায় টেক্সট একটা inline এলিমেন্টের পাশে বসে থাকে, যেমন:
//
//     <div><i class="fas fa-wallet"></i> ওয়ালেট ও লেনদেন</div>
//     <span>প্রোফাইল সম্পূর্ণতা <b><%= x %>%</b></span>
//
// এখানে বাংলা অংশটুকু `<` বা `<%`-এর ঠিক পরে/আগে থাকে, তাই exact `>টেক্সট<`
// ম্যাচ হয় না। এই স্ক্রিপ্ট ঠিক ওই বাংলা সাবস্ট্রিংটাই বদলায়, আশেপাশের মার্কআপ
// অক্ষত রেখে।
//
// নিরাপত্তা: <script>, <style> ও <% %> ব্লকের ভেতরে কিছু বদলায় না, এবং প্রতিটা
// প্রতিস্থাপন গুনে রিপোর্ট করে — না মিললে চুপ করে থাকে না।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function protectedRanges(src) {
  const ranges = [];
  for (const re of [/<script[\s\S]*?<\/script>/gi, /<style[\s\S]*?<\/style>/gi, /<%[\s\S]*?%>/g]) {
    for (const m of src.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function replaceLiteral(src, needle, replacement) {
  const ranges = protectedRanges(src);
  const inProt = (i) => ranges.some(([a, b]) => i >= a && i < b);
  let out = '';
  let i = 0;
  let count = 0;
  while (i < src.length) {
    const at = src.indexOf(needle, i);
    if (at === -1) { out += src.slice(i); break; }
    if (inProt(at)) { out += src.slice(i, at + needle.length); i = at + needle.length; continue; }
    out += src.slice(i, at) + replacement;
    i = at + needle.length;
    count += 1;
  }
  return { out, count };
}

function main() {
  const mapping = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const bnPath = path.join(ROOT, 'locales', 'bn.json');
  const enPath = path.join(ROOT, 'locales', 'en.json');
  const bn = JSON.parse(fs.readFileSync(bnPath, 'utf8'));
  const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));

  let replaced = 0;
  let added = 0;
  const misses = [];

  for (const [file, entries] of Object.entries(mapping)) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) { misses.push(`${file}: FILE NOT FOUND`); continue; }
    let src = fs.readFileSync(full, 'utf8');

    for (const [text, key, english] of entries) {
      if (!(key in bn)) { bn[key] = text; added += 1; }
      if (!(key in en)) en[key] = english;
      const r = replaceLiteral(src, text, `<%= t.${key} %>`);
      if (r.count) { src = r.out; replaced += r.count; }
      else misses.push(`${file}: "${text.slice(0, 40)}"`);
    }
    fs.writeFileSync(full, src);
  }

  fs.writeFileSync(bnPath, JSON.stringify(bn, null, 2) + '\n');
  fs.writeFileSync(enPath, JSON.stringify(en, null, 2) + '\n');
  console.log(`replaced=${replaced} keysAdded=${added} misses=${misses.length}`);
  misses.slice(0, 25).forEach((m) => console.log('  MISS ' + m));
}

main();
