const request = require('supertest');
const { app } = require('../helpers/app');

// PHASE 1 রিগ্রেশন গার্ড।
//
// আগে /api/docs mount-এ `res.removeHeader('Content-Security-Policy')` ছিল,
// ফলে Swagger UI-এর পাতাগুলো কোনো CSP ছাড়াই যেত। এই টেস্ট নিশ্চিত করে যে
// হেডারটা থাকে এবং সেখানে গুরুত্বপূর্ণ directive গুলো এখনো কড়া।
describe('Swagger UI (/api/docs) CSP', () => {
  let res;

  beforeAll(async () => {
    res = await request(app).get('/api/docs/');
  });

  it('CSP হেডার সরানো হয় না', () => {
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  it('objectSrc / baseUri / formAction / frameAncestors কড়া থাকে', () => {
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it('বাইরের origin থেকে script লোড করার অনুমতি দেয় না', () => {
    const csp = res.headers['content-security-policy'];
    const scriptSrc = (csp.split(';').find((d) => d.trim().startsWith('script-src')) || '').trim();
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).not.toMatch(/https?:\/\//);
  });

  it('docs.json-এ সাইটের সাধারণ CSP বহাল থাকে', async () => {
    const json = await request(app).get('/api/docs.json');
    expect(json.headers['content-security-policy']).toBeDefined();
  });
});
