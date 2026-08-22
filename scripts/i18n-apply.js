#!/usr/bin/env node
// scripts/i18n-apply.js
// ---------------------------------------------------------------------------
// একটা ম্যাপিং ফাইল নিয়ে EJS টেমপ্লেটে হার্ডকোড করা বাংলা টেক্সটকে `<%= t.key %>`-তে
// বদলে দেয় এবং locales/bn.json ও locales/en.json-এ key যোগ করে।
//
// ম্যাপিং ফরম্যাট (JSON):
//   { "views/foo.ejs": [ ["হোম", "nav_home", "Home"], ... ] }
//
// নিরাপত্তা:
//   • শুধু ঠিক ওই স্ট্রিংটাই বদলায় (exact match), fuzzy কিছু করে না।
//   • <script>, <style> ও EJS লজিক ব্লক স্পর্শ করে না — সেখানে বদলালে কোড ভাঙত।
//   • placeholder/title/alt/aria-label অ্যাট্রিবিউটেও কাজ করে।
//   • কোনো স্ট্রিং না মিললে সেটা রিপোর্ট করে, নীরবে এড়িয়ে যায় না।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function protectedRanges(src) {
  const ranges = [];
  const push = (re) => {
    for (const m of src.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  };
  push(/<script[\s\S]*?<\/script>/gi);
  push(/<style[\s\S]*?<\/style>/gi);
  push(/<%[\s\S]*?%>/g);
  return ranges;
}

function inProtected(ranges, idx) {
  return ranges.some(([a, b]) => idx >= a && idx < b);
}

function replaceOutsideProtected(src, needle, replacement) {
  const ranges = protectedRanges(src);
  let out = '';
  let i = 0;
  let count = 0;
  while (i < src.length) {
    const at = src.indexOf(needle, i);
    if (at === -1) { out += src.slice(i); break; }
    if (inProtected(ranges, at)) {
      out += src.slice(i, at + needle.length);
      i = at + needle.length;
      continue;
    }
    out += src.slice(i, at) + replacement;
    i = at + needle.length;
    count += 1;
  }
  return { out, count };
}

function main() {
  const mapFile = process.argv[2];
  if (!mapFile) {
    console.error('usage: node scripts/i18n-apply.js <mapping.json>');
    process.exit(1);
  }
  const mapping = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  const bnPath = path.join(ROOT, 'locales', 'bn.json');
  const enPath = path.join(ROOT, 'locales', 'en.json');
  const bn = JSON.parse(fs.readFileSync(bnPath, 'utf8'));
  const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));

  let replaced = 0;
  let added = 0;
  const misses = [];
  const conflicts = [];

  for (const [file, entries] of Object.entries(mapping)) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) { misses.push(`${file}: FILE NOT FOUND`); continue; }
    let src = fs.readFileSync(full, 'utf8');

    for (const [text, key, english] of entries) {
      // একই key আগে ভিন্ন মানে ব্যবহৃত হয়ে থাকলে চুপচাপ ওভাররাইট করা হয় না
      if (key in bn && bn[key] !== text) conflicts.push(`${key}: "${bn[key]}" vs "${text}"`);
      if (!(key in bn)) { bn[key] = text; added += 1; }
      if (!(key in en)) en[key] = english;

      let hit = 0;
      // ১) এলিমেন্টের ভেতরের টেক্সট
      for (const [needle, repl] of [
        [`>${text}<`, `><%= t.${key} %><`],
        [`> ${text} <`, `> <%= t.${key} %> <`],
        [`placeholder="${text}"`, `placeholder="<%= t.${key} %>"`],
        [`title="${text}"`, `title="<%= t.${key} %>"`],
        [`alt="${text}"`, `alt="<%= t.${key} %>"`],
        [`aria-label="${text}"`, `aria-label="<%= t.${key} %>"`]
      ]) {
        const r = replaceOutsideProtected(src, needle, repl);
        if (r.count) { src = r.out; hit += r.count; }
      }
      if (!hit) misses.push(`${file}: no match for "${text.slice(0, 40)}"`);
      else replaced += hit;
    }
    fs.writeFileSync(full, src);
  }

  fs.writeFileSync(bnPath, JSON.stringify(bn, null, 2) + '\n');
  fs.writeFileSync(enPath, JSON.stringify(en, null, 2) + '\n');

  console.log(`replaced=${replaced} keysAdded=${added} misses=${misses.length} conflicts=${conflicts.length}`);
  misses.slice(0, 25).forEach((m) => console.log('  MISS ' + m));
  conflicts.slice(0, 10).forEach((c) => console.log('  CONFLICT ' + c));
}

main();
