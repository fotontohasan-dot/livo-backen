// বুটে Redis maxmemory-policy সতর্কতা — চার ক্ষেত্র: noeviction, allkeys-lru, CONFIG নিষিদ্ধ, একই URL।
// আসল Redis লাগে না: ক্লায়েন্ট ইনজেক্ট করা হয়। সতর্কতায় URL/সিক্রেট যে যায় না সেটাও যাচাই হয়।
const { checkRedisEvictionPolicy } = require('../../services/redisEvictionCheck');

const SESSION_URL = 'redis://:sessSecret123@sess-host.internal:6379';
const CACHE_URL = 'redis://:cacheSecret456@cache-host.internal:6379';

function fakeClient(configImpl) {
  return {
    status: 'wait',
    connect: jest.fn().mockResolvedValue(undefined),
    config: jest.fn(configImpl),
    disconnect: jest.fn()
  };
}
function makeLogger() { return { warn: jest.fn(), log: jest.fn(), error: jest.fn() }; }
function loggedText(logger) {
  return [...logger.warn.mock.calls, ...logger.log.mock.calls, ...logger.error.mock.calls].flat().join(' ');
}

describe('checkRedisEvictionPolicy', () => {
  test('১) noeviction → কোনো সতর্কতা নেই, CONFIG GET maxmemory-policy একবার চলে, ক্লায়েন্ট বন্ধ হয়', async () => {
    const client = fakeClient(async () => ['maxmemory-policy', 'noeviction']);
    const createClient = jest.fn(() => client);
    const logger = makeLogger();

    const res = await checkRedisEvictionPolicy({ env: { REDIS_URL: SESSION_URL, CACHE_REDIS_URL: CACHE_URL }, createClient, logger });

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith(SESSION_URL); // সেশন/কিউ ক্লায়েন্ট = REDIS_URL
    expect(client.config).toHaveBeenCalledTimes(1);
    expect(client.config).toHaveBeenCalledWith('GET', 'maxmemory-policy');
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(res).toEqual({ checked: true, policy: 'noeviction', warned: [] });
  });

  test('২) allkeys-lru → সতর্কতা লগ হয়, শুধু policy-র নাম; URL/পাসওয়ার্ড/হোস্ট নয়', async () => {
    const client = fakeClient(async () => ['maxmemory-policy', 'allkeys-lru']);
    const logger = makeLogger();

    const res = await checkRedisEvictionPolicy({ env: { REDIS_URL: SESSION_URL, CACHE_REDIS_URL: CACHE_URL }, createClient: () => client, logger });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const text = loggedText(logger);
    expect(text).toContain('allkeys-lru');
    expect(text).not.toMatch(/sessSecret123|cacheSecret456|sess-host|cache-host|redis:\/\//);
    expect(res.warned).toEqual(['policy']);
    expect(res.policy).toBe('allkeys-lru');
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  test('৩) CONFIG নিষিদ্ধ/ব্যর্থ (Upstash) → নীরব; কোনো লগ নেই, throw নেই, ক্লায়েন্ট বন্ধ হয়', async () => {
    const denied = ["ERR unknown command 'config'", 'NOPERM this user has no permissions to run the config command'];
    for (const message of denied) {
      const client = fakeClient(async () => { throw new Error(message); });
      const logger = makeLogger();

      const res = await checkRedisEvictionPolicy({ env: { REDIS_URL: SESSION_URL }, createClient: () => client, logger });

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(res).toEqual({ checked: false, policy: null, warned: [] });
      expect(client.disconnect).toHaveBeenCalledTimes(1);
    }

    // সংযোগই ব্যর্থ হলেও একইভাবে নীরব
    const down = fakeClient(async () => ['maxmemory-policy', 'noeviction']);
    down.connect.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const logger = makeLogger();
    await expect(checkRedisEvictionPolicy({ env: { REDIS_URL: SESSION_URL }, createClient: () => down, logger })).resolves.toMatchObject({ checked: false });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('৪) REDIS_URL ও CACHE_REDIS_URL একই → আলাদা সতর্কতা (URL ছাড়া), এবং policy চেক আলাদাভাবে চলে', async () => {
    const client = fakeClient(async () => ['maxmemory-policy', 'noeviction']);
    const logger = makeLogger();

    const res = await checkRedisEvictionPolicy({ env: { REDIS_URL: SESSION_URL, CACHE_REDIS_URL: SESSION_URL }, createClient: () => client, logger });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const text = loggedText(logger);
    expect(text).toMatch(/REDIS_URL/);
    expect(text).toMatch(/CACHE_REDIS_URL/);
    expect(text).not.toMatch(/sessSecret123|sess-host|redis:\/\//);
    expect(res.warned).toEqual(['same-url']);
    expect(res.policy).toBe('noeviction');

    // একই URL + eviction policy → দুটো আলাদা সতর্কতা
    const lru = fakeClient(async () => ['maxmemory-policy', 'allkeys-lru']);
    const logger2 = makeLogger();
    const res2 = await checkRedisEvictionPolicy({ env: { REDIS_URL: SESSION_URL, CACHE_REDIS_URL: SESSION_URL }, createClient: () => lru, logger: logger2 });
    expect(logger2.warn).toHaveBeenCalledTimes(2);
    expect(res2.warned).toEqual(['same-url', 'policy']);
  });

  test('REDIS_URL নেই বা REDIS_ENABLED=false → কিছুই করে না (ক্লায়েন্টই বানায় না)', async () => {
    const createClient = jest.fn();
    const logger = makeLogger();
    await checkRedisEvictionPolicy({ env: {}, createClient, logger });
    await checkRedisEvictionPolicy({ env: { REDIS_URL: SESSION_URL, REDIS_ENABLED: 'false' }, createClient, logger });
    expect(createClient).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
