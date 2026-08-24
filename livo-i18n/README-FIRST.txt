Livo Backend — i18n লোকালাইজেশন পরিবর্তন
Commit: eea57ca90397404886963aa89bfd36c42c64b5f8

এই জিপে commit eea57ca-তে পরিবর্তিত/নতুন ৪১টা ফাইলের সম্পূর্ণ নতুন ভার্সন আছে।
ফোল্ডার স্ট্রাকচার রিপোর মতোই — জিপটা রিপোর রুটে আনজিপ করলে ফাইলগুলো
ঠিক জায়গায় বসে যাবে (পুরোনো ফাইল ওভাররাইট হবে)।

নতুন ফাইল (৩টি):
  utils/i18n.js
  tests/render/backendLocalizationIntegrity.test.js
  docs/BACKEND_LOCALIZATION.md

পরিবর্তিত (৩৮টি): app.js, locales/bn.json, locales/en.json,
  middleware/ (৬টি), routes/ (১৮টি), services/ (১১টি)

যাচাই: Jest ১১০৯ টেস্ট PASS, npm run build PASS, npm audit 0 vulnerabilities

0001-backend-i18n.patch — git am দিয়ে commit মেসেজসহ প্রয়োগ করার জন্য।
