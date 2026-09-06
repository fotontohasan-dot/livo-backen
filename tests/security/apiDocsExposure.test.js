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
  test('docs route দুটোই apiDocsGate + apiDocsAuth দিয়ে গেট করা', () => {
    const jsonRoute = /app\.get\('\/api\/docs\.json'[^\n]*/.exec(appSource);
    const uiRoute = /app\.use\('\/api\/docs'[^\n]*/.exec(appSource);

    expect(jsonRoute).not.toBeNull();
    expect(uiRoute).not.toBeNull();
    expect(jsonRoute[0]).toMatch(/apiDocsGate/);
    expect(uiRoute[0]).toMatch(/apiDocsGate/);
    expect(jsonRoute[0]).toMatch(/apiDocsAuth/);
    expect(uiRoute[0]).toMatch(/apiDocsAuth/);
  });

  test('apiDocsAuth কেবল public মোডে শিথিল হয়, নইলে isAdminOrNotFound', () => {
    // রুট লাইনে এখন `isAdmin` লেখা নেই, তাই উপরের grep একা যথেষ্ট নয় —
    // apiDocsAuth আসলে কী তা এখানে যাচাই করা হচ্ছে, নাহলে কেউ ওটাকে
    // no-op বানিয়ে দিলে উপরের টেস্ট সবুজই থাকত।
    const decl = /const apiDocsAuth = [\s\S]{0,200}?;/.exec(appSource);
    expect(decl).not.toBeNull();
    expect(decl[0]).toMatch(/API_DOCS_ACCESS === 'public'/);
    expect(decl[0]).toMatch(/isAdminOrNotFound/);
  });

  test("production-এ স্পষ্ট অনুমতি ছাড়া docs বন্ধ (off) থাকে", () => {
    // app.js-এর নীতিটা module load-এ একবার পড়া হয়, তাই এখানে সেই একই
    // resolution যুক্তিটুকু পুনরায় যাচাই করা হচ্ছে। প্রকৃত রানটাইম আচরণ
    // (৪০৪ / ২০০) swaggerDocsAccess.test.js-এ isolateModules দিয়ে দেখা হয়।
    const resolve = (env) => {
      const raw = String(env.API_DOCS_ACCESS || '').trim().toLowerCase();
      if (raw === 'off' || raw === 'admin' || raw === 'public') return raw;
      if (env.NODE_ENV === 'production') return env.ENABLE_API_DOCS === 'true' ? 'admin' : 'off';
      return 'admin';
    };

    expect(resolve({ NODE_ENV: 'production' })).toBe('off');
    expect(resolve({ NODE_ENV: 'production', ENABLE_API_DOCS: 'true' })).toBe('admin');
    expect(resolve({ NODE_ENV: 'test' })).toBe('admin');
    expect(resolve({ NODE_ENV: 'production', API_DOCS_ACCESS: 'public' })).toBe('public');
    // অজানা মান নীতি শিথিল করে না
    expect(resolve({ NODE_ENV: 'production', API_DOCS_ACCESS: 'yes' })).toBe('off');
  });
});
