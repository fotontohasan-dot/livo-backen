const { normalizeRedisUrl, normalizeRedisEnv } = require('../../utils/normalizeRedisEnv');

describe('normalizeRedisUrl', () => {
  test('কোট ছাঁটে', () => expect(normalizeRedisUrl('"rediss://u:p@h.upstash.io:6379"')).toBe('rediss://u:p@h.upstash.io:6379'));
  test('%22 ছাঁটে', () => expect(normalizeRedisUrl('rediss://u:p@h.upstash.io:6379%22')).toBe('rediss://u:p@h.upstash.io:6379'));
  test('স্কিম ছাড়া upstash → rediss', () => expect(normalizeRedisUrl('//u:p@h.upstash.io:6379%22')).toBe('rediss://u:p@h.upstash.io:6379'));
  test('স্কিম ছাড়া অন্য হোস্ট → redis', () => expect(normalizeRedisUrl('u:p@red.internal:6379')).toBe('redis://u:p@red.internal:6379'));
  test('সঠিক URL অপরিবর্তিত', () => expect(normalizeRedisUrl('redis://localhost:6379')).toBe('redis://localhost:6379'));
  test('খালি মান', () => expect(normalizeRedisUrl('  ')).toBe(''));
});

describe('normalizeRedisEnv', () => {
  test('env আপডেট করে, সঠিক হলে কিছু করে না', () => {
    const env = { REDIS_URL: '"//u:p@h.upstash.io:6379"', CACHE_REDIS_URL: 'redis://x:6379' };
    expect(normalizeRedisEnv(env)).toEqual(['REDIS_URL']);
    expect(env.REDIS_URL).toBe('rediss://u:p@h.upstash.io:6379');
    expect(env.CACHE_REDIS_URL).toBe('redis://x:6379');
  });
});
