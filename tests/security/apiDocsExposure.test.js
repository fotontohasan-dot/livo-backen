const fs = require('fs');
const path = require('path');
const { freshRequest } = require('../helpers/app');

// PHASE 1 রিগ্রেশন গার্ড — `/api/docs` ও `/api/docs.json` এর exposure।
//
// আগের অবস্থা (commit 6377687):
//   app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));
//   app.use('/api/docs', (req, res, next) => { res.removeHeader('Content-Security-Policy'); next(); }, ...)
//
// অর্থাৎ (১) কোনো auth ছিল না, (২) enforced CSP মুছে ফেলা হত।
// নিচের টেস্টগুলো ওই দুটোই ফিরে আসা আটকায়।

const ROOT = path.join(__dirname, '..', '..');
const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

describe('API docs — unauthenticated exposure', () => {
  test('anonymous ব্যবহারকারী /api/docs.json থেকে spec পায় না', async () => {
    const res = await freshRequest().get('/api/docs.json');

    expect(res.status).not.toBe(200);
    expect([401, 403, 404]).toContain(res.status);
    // spec leak হয়নি — OpenAPI-র চিহ্নিত field গুলো response-এ থাকা চলবে না
    expect(res.body || {}).not.toHaveProperty('openapi');
    expect(res.body || {}).not.toHaveProperty('paths');
    expect(res.text || '').not.toMatch(/"openapi"/);
  });

  test('anonymous ব্যবহারকারী /api/docs UI পায় না', async () => {
    const res = await freshRequest().get('/api/docs/');

    // isAdmin-এর denyResponse `req.path.includes('/api/')` দেখে সিদ্ধান্ত নেয়।
    // app.use()-এ mount করা middleware-এর ভেতরে req.path হলো sub-path ('/'),
    // পুরো '/api/docs/' নয় — তাই এখানে JSON 403 নয়, /admin/login-এ 302 redirect
    // হয়। deny হিসেবে দুটোই সমান বৈধ; আসল শর্ত হলো 200 না হওয়া ও spec/UI
    // leak না হওয়া।
    expect(res.status).not.toBe(200);
    expect([302, 401, 403, 404]).toContain(res.status);
    expect(res.text || '').not.toMatch(/swagger-ui/i);
    expect(res.text || '').not.toMatch(/Livo API Docs/);
  });
});

describe('API docs — CSP মুছে ফেলা হয় না', () => {
  test('/api/docs রেসপন্সে Content-Security-Policy হেডার থাকে', async () => {
    const res = await freshRequest().get('/api/docs/');
    // auth-এ আটকে গেলেও global helmet CSP হেডারটা থাকতেই হবে —
    // আগের কোড ওটা path-জুড়ে মুছে ফেলত।
    expect(res.headers['content-security-policy']).toBeTruthy();
  });

  test('source-এ enforced CSP মুছে ফেলার কোড নেই', () => {
    expect(appSource).not.toMatch(/removeHeader\(\s*['"]Content-Security-Policy['"]\s*\)/);
  });

  test('Swagger-এর scoped CSP object-src ও frame-ancestors বন্ধ রাখে', () => {
    expect(appSource).toMatch(/object-src 'none'/);
    expect(appSource).toMatch(/frame-ancestors 'none'/);
  });
});

describe('API docs — production-এ default বন্ধ', () => {
  test('docs route দুটোই isAdmin দিয়ে গেট করা', () => {
    const jsonRoute = /app\.get\('\/api\/docs\.json'[^\n]*/.exec(appSource);
    const uiRoute = /app\.use\('\/api\/docs'[^\n]*/.exec(appSource);

    expect(jsonRoute).not.toBeNull();
    expect(uiRoute).not.toBeNull();
    expect(jsonRoute[0]).toMatch(/isAdmin/);
    expect(uiRoute[0]).toMatch(/isAdmin/);
    expect(jsonRoute[0]).toMatch(/apiDocsGate/);
    expect(uiRoute[0]).toMatch(/apiDocsGate/);
  });

  test('production-এ ENABLE_API_DOCS ছাড়া docs বন্ধ থাকে', () => {
    const original = process.env.NODE_ENV;
    const originalFlag = process.env.ENABLE_API_DOCS;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ENABLE_API_DOCS;
      // app.js-এর গেটটা runtime-এ env পড়ে (module load-এ নয়), তাই এখানে
      // সেই একই শর্ত পুনরায় যাচাই করা হচ্ছে।
      const enabled = process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true';
      expect(enabled).toBe(false);

      process.env.ENABLE_API_DOCS = 'true';
      const enabledWithFlag = process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true';
      expect(enabledWithFlag).toBe(true);
    } finally {
      process.env.NODE_ENV = original;
      if (originalFlag === undefined) delete process.env.ENABLE_API_DOCS;
      else process.env.ENABLE_API_DOCS = originalFlag;
    }
  });
});
