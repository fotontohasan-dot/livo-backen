// tests/unit/casinoProviders.test.js
// ---------------------------------------------------------------------------
// PHASE 3 — অ্যাডাপ্টার রেজিস্ট্রি ও normalize লেয়ার।
//
// এখানে মূলত একটাই দাবি যাচাই হচ্ছে, কিন্তু সেটাই পুরো ফেজের ভিত্তি:
// **credential-ই একমাত্র সুইচ**। .env-এ PROVIDER_<NAME>_* বসালে অ্যাডাপ্টার
// সক্রিয় হয়, সরালে নিষ্ক্রিয় — কোনো কোড, কোনো DB ফ্ল্যাগ, কোনো ডিপ্লয়
// পরিবর্তন লাগে না।
//
// নেটওয়ার্ক বা DB ছাড়া চলে।
// ---------------------------------------------------------------------------

const { normalize, normalizeAll } = require('../../services/casinoProviders/normalizedGame');

const MOCK_ENV = {
  PROVIDER_MOCK_CASINO_API_URL: 'https://example.invalid',
  PROVIDER_MOCK_CASINO_AGENT_ID: 'agent-x',
  PROVIDER_MOCK_CASINO_SECRET: 'secret-x'
};

function withMockEnv(fn) {
  Object.assign(process.env, MOCK_ENV);
  try { return fn(); }
  finally { Object.keys(MOCK_ENV).forEach(k => delete process.env[k]); }
}

describe('normalizedGame', () => {
  test('providerGameId বা name ছাড়া গেম বাদ যায়', () => {
    expect(normalize({ name: 'X' })).toBeNull();
    expect(normalize({ providerGameId: 'a' })).toBeNull();
    expect(normalize(null)).toBeNull();
  });

  test('ঐচ্ছিক ফিল্ড না থাকলেও গেমটা টেকে', () => {
    const g = normalize({ providerGameId: 'a1', name: 'Game A' });
    expect(g.category).toBe('other');
    expect(g.thumbnailUrl).toBeNull();
    expect(g.isActive).toBe(true);
    expect(g.isMobile).toBe(true);
    expect(g.hasDemo).toBe(false);
  });

  test('RTP ভগ্নাংশ ও পার্সেন্ট — দুই রূপেই ঠিকভাবে আসে', () => {
    expect(normalize({ providerGameId: 'a', name: 'A', rtp: 0.965 }).rtp).toBe(96.5);
    expect(normalize({ providerGameId: 'a', name: 'A', rtp: 96.5 }).rtp).toBe(96.5);
    // অস্বাভাবিক মান বাদ — NUMERIC(5,2)-এ ঢোকানোর চেষ্টায় sync ভাঙা উচিত নয়
    expect(normalize({ providerGameId: 'a', name: 'A', rtp: 5000 }).rtp).toBeNull();
    expect(normalize({ providerGameId: 'a', name: 'A', rtp: 'x' }).rtp).toBeNull();
  });

  test('normalizeAll অবৈধ এন্ট্রি বাদ দেয়, বাকিগুলো রাখে', () => {
    const out = normalizeAll([
      { providerGameId: 'a', name: 'A' },
      { name: 'no id' },
      null,
      { providerGameId: 'b', name: 'B' }
    ]);
    expect(out.map(g => g.providerGameId)).toEqual(['a', 'b']);
  });
});

describe('casino provider registry', () => {
  // প্রতিটা টেস্টে রেজিস্ট্রি নতুন করে লোড — module cache-এ আগের env আটকে
  // থাকলে "credential-ই একমাত্র সুইচ" দাবিটা যাচাই করাই যেত না।
  function freshRegistry() {
    jest.resetModules();
    return require('../../services/casinoProviders');
  }

  afterEach(() => {
    delete process.env.CASINO_PROVIDERS;
    delete process.env.CASINO_SYNC_INTERVAL_MINUTES;
    Object.keys(MOCK_ENV).forEach(k => delete process.env[k]);
  });

  test('credential ছাড়া কোনো প্রোভাইডার সক্রিয় নয়', () => {
    expect(freshRegistry().getEnabledProviders()).toHaveLength(0);
  });

  test('credential বসালেই প্রোভাইডার সক্রিয় হয় — কোনো কোড পরিবর্তন ছাড়াই', () => {
    withMockEnv(() => {
      const enabled = freshRegistry().getEnabledProviders();
      expect(enabled.map(a => a.name)).toContain('mock-casino');
    });
  });

  test('credential সরালে প্রোভাইডার আবার নিষ্ক্রিয়', () => {
    withMockEnv(() => freshRegistry().getEnabledProviders());
    expect(freshRegistry().getEnabledProviders()).toHaveLength(0);
  });

  test('CASINO_PROVIDERS allow-list তালিকার বাইরের প্রোভাইডার বাদ দেয়', () => {
    withMockEnv(() => {
      process.env.CASINO_PROVIDERS = 'some-other-provider';
      expect(freshRegistry().getEnabledProviders()).toHaveLength(0);
    });
  });

  test('অস্বাভাবিক ছোট sync ইন্টারভাল ডিফল্টে ফিরে যায়', () => {
    const reg = freshRegistry();
    process.env.CASINO_SYNC_INTERVAL_MINUTES = '1';
    expect(reg.getSyncIntervalMs()).toBe(360 * 60 * 1000);
    process.env.CASINO_SYNC_INTERVAL_MINUTES = '30';
    expect(reg.getSyncIntervalMs()).toBe(30 * 60 * 1000);
  });

  test('প্রতিটা অ্যাডাপ্টার সম্পূর্ণ ইন্টারফেস এক্সপোর্ট করে', () => {
    const reg = freshRegistry();
    const REQUIRED = ['isEnabled', 'fetchGames', 'getLaunchUrl', 'verifySignature',
                      'parseWalletRequest', 'formatWalletResponse', 'formatError'];
    for (const adapter of reg.ADAPTERS) {
      expect(typeof adapter.name).toBe('string');
      for (const fn of REQUIRED) {
        expect(typeof adapter[fn]).toBe('function');
      }
    }
  });

  test('mock অ্যাডাপ্টারের fetchGames normalizedGame আকার দেয়', async () => {
    await withMockEnv(async () => {
      const reg = freshRegistry();
      const adapter = reg.get('mock-casino');
      const games = await adapter.fetchGames();
      expect(games.length).toBeGreaterThan(0);
      games.forEach(g => {
        expect(typeof g.providerGameId).toBe('string');
        expect(typeof g.name).toBe('string');
        expect(typeof g.category).toBe('string');
      });
    });
  });
});
