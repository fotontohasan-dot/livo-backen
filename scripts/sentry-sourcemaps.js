#!/usr/bin/env node
// scripts/sentry-sourcemaps.js
// ---------------------------------------------------------------------------
// ঐচ্ছিক সোর্স ম্যাপ আপলোড স্ক্রিপ্ট (npm run sentry:sourcemaps)।
//
// এই প্রজেক্টটা প্লেইন Node.js/EJS সার্ভার অ্যাপ — কোনো বান্ডলার/ট্রান্সপাইলার
// (webpack, esbuild, babel ইত্যাদি) ব্যবহার হয় না, তাই ডিপ্লয় করা কোড-ই আসল
// সোর্স কোড। এই অবস্থায় সোর্স ম্যাপের সত্যিকারের দরকার নেই — Sentry স্বয়ংক্রিয়ভাবেই
// সঠিক স্ট্যাক ট্রেস দেখাবে।
//
// ভবিষ্যতে যদি কখনো ফ্রন্টএন্ড বান্ডলিং/মিনিফিকেশন (webpack/esbuild/vite) যোগ করা
// হয়, তখন এই স্ক্রিপ্ট দিয়ে সোর্স ম্যাপ আপলোড করা যাবে — নিচের এনভায়রনমেন্ট
// ভ্যারিয়েবলগুলো সেট করে চালাতে হবে:
//   SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT
// এবং npm run sentry:sourcemaps কল করতে হবে।
// ---------------------------------------------------------------------------

const { execSync } = require('child_process');

const RELEASE = process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || require('../package.json').version;
const requiredEnv = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'];
const missing = requiredEnv.filter((k) => !process.env[k]);

if (missing.length > 0) {
  console.log('ℹ️ সোর্স ম্যাপ আপলোড স্কিপ করা হলো — এই ভ্যারিয়েবলগুলো সেট নেই:', missing.join(', '));
  console.log('   (এই প্রজেক্টে বান্ডলার না থাকায় এটা সাধারণত দরকারও পড়ে না।)');
  process.exit(0);
}

// বর্তমানে বান্ডল করা কোনো আউটপুট ডিরেক্টরি নেই বলে এখানে শুধু রিলিজ তৈরি +
// (ভবিষ্যতে বান্ডলার যোগ হলে) build/ ডিরেক্টরি থেকে সোর্স ম্যাপ আপলোডের কমান্ড
try {
  execSync(`npx @sentry/cli releases new ${RELEASE}`, { stdio: 'inherit' });
  execSync(`npx @sentry/cli releases set-commits ${RELEASE} --auto`, { stdio: 'inherit' });
  execSync(`npx @sentry/cli releases finalize ${RELEASE}`, { stdio: 'inherit' });
  console.log(`✅ Sentry রিলিজ ${RELEASE} তৈরি ও ফাইনালাইজ হয়েছে।`);
} catch (err) {
  console.error('❌ Sentry রিলিজ তৈরি ব্যর্থ হয়েছে:', err.message);
  process.exit(1);
}
