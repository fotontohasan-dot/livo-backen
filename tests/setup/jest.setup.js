// tests/setup/jest.setup.js
jest.setTimeout(30000);

// app.js বুট হওয়ার সময় প্রচুর informational console.log/console.warn প্রিন্ট করে
// (migration, redis fallback ইত্যাদি) — টেস্ট আউটপুট পরিষ্কার রাখতে সেগুলো
// প্রয়োজন ছাড়া নিরব রাখা হয়, কিন্তু console.error দৃশ্যমান থাকে যাতে আসল
// সমস্যাগুলো ধরা যায়।
const originalError = console.error;
global.__originalConsoleError = originalError;
