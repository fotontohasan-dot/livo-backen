// tests/helpers/testUser.js
const crypto = require('crypto');

function uniqueSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

function buildTestUser(overrides = {}) {
  const suffix = uniqueSuffix();
  return {
    username: `qauser_${suffix}`,
    // ইচ্ছাকৃতভাবে email না দিয়ে phone ব্যবহার করা হয়েছে — email দিলে registration
    // হ্যান্ডলার verification email পাঠানোর চেষ্টা করে (services/email.js সরাসরি
    // smtp.gmail.com-এ কানেক্ট করে, যেটা টেস্ট এনভায়রনমেন্টে নেটওয়ার্ক-বন্ধ/টাইমআউট হতে
    // পারে)। রেজিস্ট্রেশন ফর্ম email/phone যেকোনো একটা দিয়েই কাজ করে, তাই এটা production
    // কোড পরিবর্তন ছাড়াই টেস্টকে নেটওয়ার্ক-নির্ভরতা থেকে মুক্ত রাখার নিরাপদ উপায়।
    phone: `019${Math.floor(10000000 + Math.random() * 89999999)}`,
    password: 'TestPass123!',
    confirmPassword: 'TestPass123!',
    ...overrides
  };
}

// GET রেসপন্সের HTML থেকে <meta name="csrf-token" content="..."> এক্সট্র্যাক্ট করে
function extractCsrfToken(html) {
  const match = /<meta\s+name="csrf-token"\s+content="([^"]*)"/i.exec(html || '');
  return match ? match[1] : null;
}

module.exports = { buildTestUser, extractCsrfToken, uniqueSuffix };
