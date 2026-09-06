const request = require('supertest');
const { app } = require('../helpers/app');

// ==================== Phase 2: ইউজার পথের authorization ====================
//
// roadmap-এর Phase 2 ইউজার অ্যাকাউন্ট ও প্রোফাইলের একটা তালিকা দেয়। এখানে
// দুটো আলাদা প্রশ্ন যাচাই হয়:
//
//   ১. প্রতিটা লগইন-প্রয়োজনীয় পথ অননুমোদিত রিকোয়েস্টে কনটেন্ট ফাঁস করে
//      কি না। ৩০২ → /login গ্রহণযোগ্য; ২০০ নয়।
//   ২. roadmap-এর কিছু পথ কোডবেসে অন্য নামে আছে (যেমন /wallet নয়,
//      /payment/wallet)। কোনটা কোথায় — সেটা এখানে নথিভুক্ত, যাতে
//      "রুট নেই" আর "রুট অন্য নামে আছে" গুলিয়ে না যায়।
//
// এটা authorization-এর প্রথম স্তর (লগইন আছে কি না)। মালিকানা যাচাই
// (IDOR) আলাদা — tests/security/authorizationBoundary.test.js দেখুন।

// roadmap-এর নাম → কোডবেসের আসল পথ
const AUTHENTICATED_ROUTES = {
  '/profile': '/profile',
  '/profile/security': '/profile/security',
  '/profile/referral': '/profile/referral',
  '/profile/cards': '/profile/cards',
  '/profile/chat': '/profile/chat',
  '/profile/share': '/profile/share',
  '/profile/wheel': '/profile/wheel',
  '/wallet': '/payment/wallet',
  '/transactions': '/profile/transactions',
  '/rewards': '/profile/rewards',
  '/vip': '/profile/vip',
  '/deposit': '/payment/deposit',
  '/withdraw': '/payment/withdraw',
  '/notifications': '/notifications',
  '/kyc': '/extra/kyc'
};

// লগইন ছাড়াই দেখা যায় — ইচ্ছাকৃত
const PUBLIC_ROUTES = ['/login', '/register', '/leaderboard'];

describe('Phase 2 — লগইন ছাড়া সুরক্ষিত পথে কনটেন্ট যায় না', () => {
  test.each(Object.entries(AUTHENTICATED_ROUTES))(
    '%s (%s) অননুমোদিত হলে লগইনে পাঠায়',
    async (_name, route) => {
      const res = await request(app).get(route);

      // ২০০ মানে পেজের কনটেন্ট অননুমোদিত ব্যক্তিকে দেওয়া হয়েছে।
      expect(res.status).not.toBe(200);
      expect([301, 302, 401, 403]).toContain(res.status);

      if (res.status === 302 || res.status === 301) {
        // রিডাইরেক্ট গন্তব্য সাইট-অভ্যন্তরীণ হতে হবে — বাইরের হলে
        // এটা একটা ওপেন রিডাইরেক্ট হয়ে যেত।
        const loc = res.headers.location || '';
        expect(loc.startsWith('/')).toBe(true);
        expect(loc.startsWith('//')).toBe(false);
      }
    }
  );

  test('সুরক্ষিত পথের রেসপন্সে ব্যবহারকারীর ডেটা ফাঁস হয় না', async () => {
    for (const route of Object.values(AUTHENTICATED_ROUTES)) {
      const res = await request(app).get(route);
      const body = res.text || '';
      // রিডাইরেক্ট বডি ছোট হওয়ার কথা; পুরো পেজ রেন্ডার হলে সেটা ফাঁস।
      expect(body.length).toBeLessThan(2000);
    }
  });
});

describe('Phase 2 — পাবলিক পথ ইচ্ছাকৃতভাবেই খোলা', () => {
  test.each(PUBLIC_ROUTES)('%s লগইন ছাড়াই ২০০', async (route) => {
    const res = await request(app).get(route);
    expect(res.status).toBe(200);
  });
});

describe('Phase 2 — roadmap-এর পথগুলো সত্যিই বিদ্যমান', () => {
  test.each(Object.entries(AUTHENTICATED_ROUTES))(
    '%s → %s রুটটা আছে (৪০৪ নয়)',
    async (_name, route) => {
      // ৪০৪ মানে রুটটাই নেই — তখন উপরের authorization টেস্ট মিথ্যা
      // আশ্বাস দিত, কারণ ৪০৪-ও "২০০ নয়"।
      const res = await request(app).get(route);
      expect(res.status).not.toBe(404);
    }
  );
});
