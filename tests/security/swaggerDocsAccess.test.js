const http = require('http');
const request = require('supertest');

// PHASE 1 রিগ্রেশন গার্ড।
//
// /api/docs ও /api/docs.json কোনো প্রমাণীকরণ ছাড়াই মাউন্ট করা ছিল — যে কেউ
// প্ল্যাটফর্মের সম্পূর্ণ API surface পড়ে নিতে পারত। এখন production-এ শুধু
// admin, এবং API_DOCS_ACCESS দিয়ে স্পষ্টভাবে নিয়ন্ত্রণ করা যায়।
//
// এখানে helpers/app.js-এর শেয়ার্ড হারনেস ব্যবহার করা যায় না: নীতিটা app.js
// মডিউল-লোডের সময় একবারই পড়া হয়, তাই প্রতিটা মোডের জন্য আলাদা module
// registry-তে অ্যাপ বুট করতে হয় (jest.isolateModules)।
//
// তবে testHarnessIntegrity.test.js-এর আসল দাবিটা মানা হয়েছে — supertest-কে
// কখনো খালি express অ্যাপ দেওয়া হয় না। প্রতিটা ইনস্ট্যান্সকে নিজের
// দীর্ঘস্থায়ী listening http.Server-এ মুড়ে দেওয়া হয়, ঠিক যেভাবে
// security/internalEndpointAuth.test.js করে। এই কারণেই ফাইলটা ওই টেস্টের
// ALLOWED_DIRECT_APP_REQUIRE তালিকায় আছে।

const servers = [];

function bootWith(envPatch) {
  const saved = {};
  for (const k of Object.keys(envPatch)) {
    saved[k] = process.env[k];
    process.env[k] = envPatch[k];
  }
  let expressApp;
  jest.isolateModules(() => {
    expressApp = require('../../app.js');
  });
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  const server = http.createServer(expressApp).listen(0);
  servers.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

describe('API docs অ্যাক্সেস নিয়ন্ত্রণ', () => {
  describe('API_DOCS_ACCESS=admin (production-এর ডিফল্ট)', () => {
    let srv;
    beforeAll(() => { srv = bootWith({ API_DOCS_ACCESS: 'admin' }); });

    it('অ্যানোনিমাস ব্যবহারকারী /api/docs.json পায় না', async () => {
      expect((await request(srv).get('/api/docs.json')).status).toBe(404);
    });

    it('অ্যানোনিমাস ব্যবহারকারী /api/docs UI পায় না', async () => {
      expect((await request(srv).get('/api/docs/')).status).toBe(404);
    });

    it('404 বডিতে কোনো API স্কিমা ফাঁস হয় না', async () => {
      const res = await request(srv).get('/api/docs.json');
      expect(res.text).not.toContain('openapi');
      expect(res.text).not.toContain('paths');
    });

    it('403/401 নয় — 404, যাতে endpoint-এর অস্তিত্ব প্রকাশ না পায়', async () => {
      const res = await request(srv).get('/api/docs.json');
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });

  describe('API_DOCS_ACCESS=off', () => {
    it('সম্পূর্ণ বন্ধ থাকে', async () => {
      const srv = bootWith({ API_DOCS_ACCESS: 'off' });
      expect((await request(srv).get('/api/docs.json')).status).toBe(404);
      expect((await request(srv).get('/api/docs/')).status).toBe(404);
    });
  });

  describe('API_DOCS_ACCESS=public', () => {
    it('আগের মতোই খোলা থাকে (dev/test-এর ডিফল্ট)', async () => {
      const srv = bootWith({ API_DOCS_ACCESS: 'public' });
      const res = await request(srv).get('/api/docs.json');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('openapi');
    });
  });
});
