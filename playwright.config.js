// playwright.config.js
// ---------------------------------------------------------------------------
// E2E কনফিগ — এবং E2E-এর একমাত্র অথরিটেটিভ এনভায়রনমেন্ট সংজ্ঞা।
//
// আগের সমস্যা (KYC E2E ব্যর্থতার মূল কারণ):
//   webServer `node app.js` চালাত `env: { NODE_ENV: 'development' }` দিয়ে। ফলে
//   E2E সার্ভার প্রসেস কখনোই `.env.test` লোড করত না — Jest প্রসেস করত (tests/setup.js)।
//   দুই প্রসেসের কনফিগ আলাদা হয়ে যেত। routes/extra.js-এর isSafeCloudinaryUrl()
//   ফেল-ক্লোজড: CLOUDINARY_CLOUD_NAME না মিললে document_url বাতিল হয়, তাই KYC
//   সাবমিশন কোনো pending সারি তৈরি করত না। CI-তে কাজ করত শুধু কাকতালীয়ভাবে —
//   ভ্যারিয়েবলটা job-level env-এ ছিল বলে; লোকালি কখনোই না।
//
// এখন:
//   • webServer `node server.js` চালায় (প্রোডাকশনের আসল এন্ট্রিপয়েন্ট)।
//   • এনভায়রনমেন্ট এক জায়গায় তৈরি হয়: `.env.test`-এর মান ডিফল্ট, আর ইতিমধ্যে
//     সেট করা process.env (CI secrets/job env) সেগুলোর ওপর প্রাধান্য পায়।
//   • NODE_ENV=test জোর করে সেট করা হয় — Jest ও E2E একই কনফিগ দেখে।
//   • আবশ্যক ভ্যারিয়েবল না থাকলে সার্ভার চালুর আগেই স্পষ্ট বার্তা দিয়ে fail করে,
//     যাতে ভুল কনফিগ পরে "selector timeout" হয়ে ছদ্মবেশে না আসে।
//
// কোনো সিক্রেট সোর্সে হার্ডকোড করা নেই — CLOUDINARY_CLOUD_NAME শুধু একটা টেন্যান্ট
// নাম (URL যাচাইয়ের জন্য), কোনো API key/secret নয়। আসল ক্রেডেনশিয়াল দরকার হলে
// GitHub Actions secrets থেকে process.env-এ আসবে এবং এখানেই পাস হবে।
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = __dirname;
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const PORT = new URL(BASE_URL).port || '3000';

// `.env.test` = টেস্ট এনভায়রনমেন্টের ডিফল্ট উৎস (Jest-ও ঠিক এই ফাইলটাই পড়ে)।
const envTestPath = path.join(ROOT, '.env.test');
const fileEnv = fs.existsSync(envTestPath)
  ? dotenv.parse(fs.readFileSync(envTestPath))
  : {};

// ইতিমধ্যে সেট করা process.env সবসময় জেতে (CI job env / secrets), ফাইল শুধু ফাঁক পূরণ করে।
const resolved = {};
for (const [key, value] of Object.entries(fileEnv)) {
  resolved[key] = process.env[key] !== undefined ? process.env[key] : value;
}

const webServerEnv = {
  ...resolved,
  NODE_ENV: 'test',
  PORT: String(PORT),
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || BASE_URL,
  E2E_BASE_URL: BASE_URL
};

// E2E ফ্লো যেসব ভ্যারিয়েবল ছাড়া নিঃশব্দে ভুল ফল দেয় — আগেভাগেই যাচাই।
const REQUIRED = ['DATABASE_URL', 'SESSION_SECRET', 'CLOUDINARY_CLOUD_NAME'];
const missing = REQUIRED.filter((k) => !webServerEnv[k]);
if (missing.length && !process.env.E2E_SKIP_WEBSERVER) {
  throw new Error(
    `E2E এনভায়রনমেন্ট অসম্পূর্ণ — অনুপস্থিত: ${missing.join(', ')}। ` +
    `.env.test-এ দাও অথবা CI job env/secrets-এ সেট করো। ` +
    `(CLOUDINARY_CLOUD_NAME ছাড়া KYC আপলোড URL যাচাই fail-closed হয়ে যায়, ` +
    `আর টেস্ট সেটাকে ভুলভাবে "selector timeout" হিসেবে দেখায়।)`
  );
}

// টেস্ট প্রসেসেও একই মান দরকার (DB assertion ও KYC URL তৈরির জন্য)।
for (const [key, value] of Object.entries(webServerEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

module.exports = {
  testDir: './tests/e2e',
  // রিট্রাই ইচ্ছাকৃতভাবে কম — বেশি রিট্রাই ফ্লেকি টেস্ট ঢেকে দেয়, ঠিক করে না।
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60000,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: process.env.E2E_SKIP_WEBSERVER ? undefined : {
    // প্রোডাকশনের আসল এন্ট্রিপয়েন্ট — app.js এখন শুধু Express অ্যাপ এক্সপোর্ট করে,
    // নিজে থেকে listen/migration চালায় না।
    command: 'node server.js',
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: webServerEnv
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {})
      }
    }
  ]
};
