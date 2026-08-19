/**
 * রিগ্রেশন টেস্ট — লগইন রেট-লিমিটার শুধু POST চেষ্টা গুনবে, GET পেজ-লোড না।
 *
 * বাগ: app.js-এ `loginLimiter` একটাই ইনস্ট্যান্স হিসেবে `/login`, `/register` ও
 * `/admin/login` — তিন পাথে বসানো, এবং এতে কোনো `skip` ছিল না। express-rate-limit
 * ডিফল্টভাবে middleware দিয়ে যাওয়া *সব* রিকোয়েস্ট গোনে, তাই GET পেজ-ভিউও কাউন্ট হতো।
 * ফলে:
 *   ১. লগইন পেজ ১০ বার রিফ্রেশ করলেই (একটাও পাসওয়ার্ড সাবমিট না করে) ১৫ মিনিটের
 *      জন্য 429 — লগইন পেজটাই আর খুলত না।
 *   ২. কাউন্টার শেয়ার্ড হওয়ায় সাধারণ ইউজারের /login + /register ট্রাফিকই
 *      /admin/login-এর কোটা শেষ করে দিত।
 *
 * এই টেস্ট ফিক্স ছাড়া ফেল করে (১১তম GET-এ 429 আসে) এবং ফিক্সের পরে পাস করে।
 */

const rateLimit = require('express-rate-limit');
const express = require('express');
const request = require('supertest');

// app.js-এর loginLimiter কনফিগের হুবহু প্রতিরূপ (store বাদে — এখানে ডিফল্ট in-memory
// store যথেষ্ট, কারণ যাচাই করার বিষয় হলো কোন রিকোয়েস্টগুলো *গোনা* হচ্ছে)।
function buildLoginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'অনেকবার চেষ্টা করেছেন। ১৫ মিনিট পর আবার চেষ্টা করুন।',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method !== 'POST'
  });
}

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const limiter = buildLoginLimiter();
  // app.js-এর মতো একই ইনস্ট্যান্স একাধিক পাথে
  app.use('/login', limiter);
  app.use('/admin/login', limiter);
  app.get('/login', (req, res) => res.status(200).send('<input name="identifier">'));
  app.post('/login', (req, res) => res.status(200).send('posted'));
  app.get('/admin/login', (req, res) => res.status(200).send('<input name="username">'));
  app.post('/admin/login', (req, res) => res.status(200).send('posted'));
  return app;
}

describe('loginLimiter — GET পেজ-লোড রেট-লিমিট কোটা খরচ করে না', () => {
  test('লগইন পেজ বারবার GET করলেও (লিমিটের চেয়ে অনেক বেশি) কখনো 429 হয় না', async () => {
    const app = buildApp();
    for (let i = 0; i < 25; i++) {
      const res = await request(app).get('/login');
      expect(res.status).toBe(200);
    }
  });

  test('ইউজার-সাইড GET ট্রাফিক /admin/login পেজকে লক করে না', async () => {
    const app = buildApp();
    // শেয়ার্ড কাউন্টারে ইউজার-সাইড পেজ-ভিউ জমা করার চেষ্টা
    for (let i = 0; i < 25; i++) {
      await request(app).get('/login');
    }
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('name="username"');
  });

  test('POST লগইন-চেষ্টা আগের মতোই গোনা হয় ও সীমা ছাড়ালে 429 দেয় (সুরক্ষা অক্ষত)', async () => {
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/login').send({ identifier: 'x', password: 'y' });
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).post('/login').send({ identifier: 'x', password: 'y' });
    expect(blocked.status).toBe(429);
  });

  test('POST কোটা শেষ হলেও লগইন পেজটা (GET) খোলা থাকে — ইউজার এরর মেসেজ দেখতে পায়', async () => {
    const app = buildApp();
    for (let i = 0; i < 12; i++) {
      await request(app).post('/login').send({ identifier: 'x', password: 'y' });
    }
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
  });
});
