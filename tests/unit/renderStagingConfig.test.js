// render.staging.yaml সোর্স-লেভেল গার্ড: staging production থেকে আলাদা ও নিরাপদ থাকে (Render/DB ছাড়াই চলে)।
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const yml = fs.readFileSync(path.join(ROOT, 'render.staging.yaml'), 'utf8');
const prod = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
const code = yml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // কমেন্ট বাদ

describe('render.staging.yaml', () => {
  test('production-এর কোনো সার্ভিস/DB/গ্রুপের নাম শেয়ার করে না', () => {
    for (const n of ['livo-web', 'livo-worker', 'livo-redis', 'livo-redis-cache', 'livo-postgres', 'livo-shared']) {
      expect(code).not.toMatch(new RegExp(`name:\\s*${n}\\s*$`, 'm'));
      expect(code).not.toMatch(new RegExp(`(name|fromGroup):\\s*${n}\\s*$`, 'm'));
    }
    expect(prod).not.toMatch(/staging/);
  });
  test('সব সার্ভিস staging ব্র্যাঞ্চ থেকে', () => {
    const svc = (code.match(/^\s+- type:\s*(web|worker)/gm) || []).length;
    expect((code.match(/^\s+branch:\s*staging\s*$/gm) || []).length).toBe(svc);
  });
  test('দুটো Redis: সেশন/কিউ noeviction, ক্যাশ allkeys-lru', () => {
    expect(code).toMatch(/name:\s*livo-redis-staging\n[\s\S]*?maxmemoryPolicy:\s*noeviction/);
    expect(code).toMatch(/name:\s*livo-redis-cache-staging\n[\s\S]*?maxmemoryPolicy:\s*allkeys-lru/);
  });
  test('web ×২, worker ও env গ্রুপ livo-shared-staging', () => {
    expect(code).toMatch(/name:\s*livo-web-staging[\s\S]*?numInstances:\s*2/);
    expect((code.match(/fromGroup:\s*livo-shared-staging/g) || []).length).toBe(2);
  });
  test('secret নেই: SESSION_SECRET/generateValue/আসল key কমিট করা নেই, SSLCommerz স্যান্ডবক্স', () => {
    expect(code).not.toMatch(/SESSION_SECRET/);
    expect(code).not.toMatch(/generateValue/);
    expect(code).not.toMatch(/(ghp_|sk_live|postgres:\/\/)/);
    expect(code).toMatch(/SSLCZ_IS_LIVE\n\s+value:\s*"false"/);
  });
});
