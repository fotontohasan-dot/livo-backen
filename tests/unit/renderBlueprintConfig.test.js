// render.yaml + Redis ভাগ + migration lock — সোর্স-লেভেল গার্ড (Render ও DB ছাড়াই চলে)।
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('render.yaml Blueprint', () => {
  const yml = read('render.yaml');
  test('deprecated redis/env ফরম্যাট নেই', () => {
    expect(yml).not.toMatch(/^\s*env:\s*node/m);
    expect(yml).not.toMatch(/type:\s*redis\b/);
    expect(yml).not.toMatch(/^redis:/m);
  });
  test('web ও worker দুটোই livo-shared গ্রুপ পায়', () => {
    expect((yml.match(/fromGroup:\s*livo-shared/g) || []).length).toBe(2);
    expect(yml).toMatch(/envVarGroups:\s*\n\s*-\s*name:\s*livo-shared/);
  });
  test('দুটো keyvalue: সেশন/কিউ noeviction, ক্যাশ allkeys-lru, ipAllowList আছে', () => {
    expect(yml).toMatch(/name:\s*livo-redis\n[\s\S]*?maxmemoryPolicy:\s*noeviction/);
    expect(yml).toMatch(/name:\s*livo-redis-cache\n[\s\S]*?maxmemoryPolicy:\s*allkeys-lru/);
    expect((yml.match(/ipAllowList:/g) || []).length).toBe(2);
  });
  test('সব env value স্ট্রিং, সিক্রেট কমিট করা নেই', () => {
    expect(yml).not.toMatch(/^\s+value:\s*\d+\s*(#.*)?$/m);
    expect(yml).not.toMatch(/generateValue/);
  });
});

describe('Redis ভাগ', () => {
  test('cache.js CACHE_REDIS_URL পড়ে, REDIS_URL-এ ফলব্যাক', () => {
    expect(read('services/cache.js')).toMatch(/process\.env\.CACHE_REDIS_URL \|\| process\.env\.REDIS_URL/);
  });
  test('সেশন ও কিউ শুধু REDIS_URL ব্যবহার করে', () => {
    expect(read('app.js')).not.toMatch(/CACHE_REDIS_URL/);
    expect(read('queues/connection.js')).not.toMatch(/CACHE_REDIS_URL/);
  });
});

describe('Migration advisory lock', () => {
  const src = read('migrations.js');
  test('pg_advisory_lock নেয় ও ছাড়ে, dedicated কানেকশনে', () => {
    expect(src).toMatch(/pg_try_advisory_lock\(\$1/);
    expect(src).toMatch(/pg_advisory_unlock\(\$1/);
    expect(src).toMatch(/client\.release\(discard/);
  });
  test('ফেল-ক্লোজড আচরণ অক্ষুণ্ণ: শেষ catch-এ throw err', () => {
    const tail = src.slice(src.lastIndexOf('} catch (err) {'));
    expect(tail).toMatch(/throw err;/);
  });
});
