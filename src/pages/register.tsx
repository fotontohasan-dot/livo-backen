'use client';

// =============================================
// এই Next.js অংশ (src/) প্রোডাকশন ট্র্যাফিক সার্ভ করে না (দেখুন README.md — "প্রোডাকশনে
// কোনটা চলে")। এখানে আগে src/pages/api/register.ts নামে একটা আলাদা রেজিস্ট্রেশন backend
// ছিল যেটাতে routes/auth.js-এর /register-এর কোনো নিরাপত্তা নিয়ন্ত্রণ ছিল না — CSRF,
// রেট-লিমিট, IP ব্লকলিস্ট, bot/CAPTCHA/honeypot, fraudDetection.scanRegistration(),
// duplicateDetection.evaluateDuplicateAccount(), রেফারেল abuse protection, ইমেইল
// ভেরিফিকেশন, ডিভাইস/অডিট লগিং — কিছুই না। ওই route এখন সরিয়ে ফেলা হয়েছে এবং
// routes/auth.js-এর /register-ই একমাত্র registration path — তাই এই পেজটা সরাসরি
// সেখানেই পাঠিয়ে দেয়।
// =============================================

import { useEffect } from 'react';

export default function RegisterPage() {
  useEffect(() => {
    window.location.replace('/register');
  }, []);

  return null;
}
