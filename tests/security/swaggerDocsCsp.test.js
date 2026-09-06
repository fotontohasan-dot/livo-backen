const http = require('http');
const request = require('supertest');

// PHASE 1 রিগ্রেশন গার্ড।
//
// আগে /api/docs mount-এ `res.removeHeader('Content-Security-Policy')` ছিল,
// ফলে Swagger UI-এর পাতাগুলো কোনো CSP ছাড়াই যেত। এই টেস্ট নিশ্চিত করে যে
// হেডারটা থাকে এবং সেখানে গুরুত্বপূর্ণ directive গুলো এখনো কড়া।
//
// আগের সংস্করণ helpers/app.js ব্যবহার করত, কিন্তু ডিফল্ট মোডে anonymous
// রিকোয়েস্ট Swagger পেজে পৌঁছায়ই না (আগে ৩০২, এখন ৪০৪) — অর্থাৎ টেস্টটা
// scoped CSP নয়, global CSP মাপছিল। তিনটে assertion তাই নিরর্থকভাবে পাস
// করত আর script-src-এরটা global CDN allowlist দেখে ফেল করত।
//
// এখন API_DOCS_ACCESS=public দিয়ে আলাদা ইনস্ট্যান্স বুট করা হয়, যাতে আসল
// Swagger রেসপন্সটাই পরীক্ষা করা যায়। প্রথম assertion-টাই প্রমাণ করে যে
// পেজটা সত্যিই সার্ভ হয়েছে — নইলে বাকিগুলোর কোনো অর্থ নেই।

let server;
let res;

beforeAll(async () => {
  const saved = process.env.API_DOCS_ACCESS;
  process.env.API_DOCS_ACCESS = 'public';
  let expressApp;
  jest.isolateModules(() => { expressApp = require('../../app.js'); });
  if (saved === undefined) delete process.env.API_DOCS_ACCESS;
  else process.env.API_DOCS_ACCESS = saved;

  server = http.createServer(expressApp).listen(0);
  res = await request(server).get('/api/docs/');
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

describe('Swagger UI (/api/docs) CSP', () => {
  it('Swagger পেজটা সত্যিই সার্ভ হয়েছে (নইলে নিচের CSP assertion অর্থহীন)', () => {
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/swagger-ui/i);
  });

  it('CSP হেডার সরানো হয় না', () => {
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('objectSrc / baseUri / formAction / frameAncestors কড়া থাকে', () => {
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    // scoped নীতিতে 'none' — global নীতির 'self'-এর চেয়ে কড়া। দুটোই গ্রহণযোগ্য,
    // কিন্তু এর বাইরে কিছু (যেমন কোনো origin) নয়।
    expect(csp).toMatch(/frame-ancestors '(none|self)'/);
  });

  it('বাইরের origin থেকে script লোড করার অনুমতি দেয় না', () => {
    const csp = res.headers['content-security-policy'];
    const scriptSrc = (csp.split(';').find((d) => d.trim().startsWith('script-src')) || '').trim();
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).not.toMatch(/https?:\/\//);
  });

  it('docs.json-এ সাইটের সাধারণ CSP বহাল থাকে', async () => {
    const json = await request(server).get('/api/docs.json');
    expect(json.status).toBe(200);
    expect(json.headers['content-security-policy']).toBeDefined();
  });
});
