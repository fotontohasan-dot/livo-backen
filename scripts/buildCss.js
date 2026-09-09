#!/usr/bin/env node
/**
 * scripts/buildCss.js
 *
 * assets/css/tailwind.src.css → public/css/tailwind.css
 *
 * ১৪টা ভিউ আগে https://cdn.tailwindcss.com লোড করত, যা Tailwind-এর নিজস্ব
 * ডকুমেন্টেশনে প্রোডাকশনের জন্য নিষিদ্ধ। এই স্ক্রিপ্ট বিল্ড টাইমে একবার
 * কম্পাইল করে একটা স্ট্যাটিক CSS ফাইল বানায়।
 *
 * Next.js ফ্রন্টএন্ডের বিল্ড (next build / src/app/globals.css) সম্পূর্ণ
 * আলাদা এবং এই স্ক্রিপ্ট সেটাকে স্পর্শ করে না।
 */
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'css', 'tailwind.src.css');
const OUT_DIR = path.join(ROOT, 'public', 'css');
const OUT = path.join(OUT_DIR, 'tailwind.css');

(async () => {
  const css = fs.readFileSync(SRC, 'utf8');
  const result = await postcss([tailwind()]).process(css, { from: SRC, to: OUT });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, result.css);

  const kb = (Buffer.byteLength(result.css) / 1024).toFixed(1);
  console.log(`✅ public/css/tailwind.css তৈরি হয়েছে (${kb} KB)`);

  // CDN-এর বিকল্প হিসেবে ফাইলটা আদৌ কাজের কিনা তার একটা মোটা দাগের যাচাই।
  // খালি বা প্রায়-খালি আউটপুট মানে @source পাথ ভুল — সেটা নীরবে পাস করলে
  // পুরো সাইট স্টাইল ছাড়া ডিপ্লয় হয়ে যেত।
  if (Buffer.byteLength(result.css) < 5000) {
    console.error('❌ আউটপুট সন্দেহজনকভাবে ছোট — @source পাথ যাচাই করুন।');
    process.exit(1);
  }
})().catch((err) => {
  console.error('❌ CSS বিল্ড ব্যর্থ:', err && err.stack ? err.stack : err);
  process.exit(1);
});
