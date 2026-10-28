describe('db-games adapter', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; jest.resetModules(); });

  test('env ছাড়া বন্ধ থাকে', () => {
    delete process.env.PROVIDER_DB_GAMES_SECRET;
    expect(require('../../services/casinoProviders/dbGames').isEnabled()).toBe(false);
  });

  test('env থাকলে চালু', () => {
    Object.assign(process.env, { PROVIDER_DB_GAMES_API_URL: 'https://x.test', PROVIDER_DB_GAMES_AGENT_ID: 'M1', PROVIDER_DB_GAMES_SECRET: 's' });
    expect(require('../../services/casinoProviders/dbGames').isEnabled()).toBe(true);
  });

  test('স্বাক্ষর যাচাই: সঠিক পাস, ভুল ফেল', () => {
    process.env.PROVIDER_DB_GAMES_SECRET = 's';
    const a = require('../../services/casinoProviders/dbGames');
    const body = { merchant: 'M1', amount: 5 };
    body.sign = a._internal.sign(body);
    expect(a.verifySignature({ body, get: () => null })).toBe(true);
    expect(a.verifySignature({ body: { ...body, amount: 6 }, get: () => null })).toBe(false);
  });

  test('কারেন্সি রূপান্তর', () => {
    process.env.PROVIDER_DB_GAMES_BDT_RATE = '0.1';
    const a = require('../../services/casinoProviders/dbGames');
    expect(a._internal.toProviderAmount(100)).toBe(10);
    expect(a._internal.fromProviderAmount(10)).toBe(100);
  });
});
