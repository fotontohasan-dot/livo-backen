const { freshRequest } = require('./helpers/app');

describe('API', () => {
  test('Unknown /api/* paths return 404 (no unauthenticated API surface exposed)', async () => {
    const res = await freshRequest().get('/api/matches');
    expect(res.status).toBe(404);
  });

  // এই টেস্টটা আগে ধরে নিত /api/* পুরোটাই CSRF-এক্সেম্পট (প্রিফিক্স-ভিত্তিক)।
  // সেই এক্সেম্পশন একটা টাইম-বোমা ছিল: routes/api.js-এ কেউ একটা সেশন-
  // অথেন্টিকেটেড POST যোগ করলেই সেটা নীরবে CSRF-অরক্ষিত হয়ে যেত। এখন
  // এক্সেম্পশনের শর্ত API-key হেডারের উপস্থিতি (middleware/csrf.js দ্রষ্টব্য),
  // তাই হেডার ছাড়া ব্রাউজার-সদৃশ POST যথাযথভাবেই CSRF-এ আটকায়।
  test('API key ছাড়া /api/* POST এখন CSRF-সুরক্ষিত', async () => {
    const res = await freshRequest().post('/api/some-endpoint').send({});
    expect(res.status).toBe(403);
    expect(res.body && res.body.code).toBe('CSRF_TOKEN_INVALID');
  });

  test('x-api-key হেডারসহ /api/* POST CSRF-এ আটকায় না — 404-এ পৌঁছায়', async () => {
    const res = await freshRequest()
      .post('/api/some-endpoint')
      .set('x-api-key', 'not-a-real-key')
      .send({});
    // key ভুল হলে requireApiKey() পরে 401 দেবে; অস্তিত্বহীন পাথে 404।
    // যেটা এখানে যাচাই্য: CSRF আর পথ আটকাচ্ছে না।
    expect(res.status).not.toBe(403);
    expect(res.body && res.body.code).not.toBe('CSRF_TOKEN_INVALID');
  });
});
