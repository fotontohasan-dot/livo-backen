const live = require('../services/liveApi');

describe('services/liveApi', () => {
  const key = '1234567890abcdef'; // 16 বাইট

  test('AES encrypt/decrypt roundtrip', () => {
    const json = JSON.stringify({ loginName: 'j716testuser', timestamp: '1578662499442' });
    expect(live.decryptParams(live.encryptParams(json, key), key)).toBe(json);
  });

  test('signature হলো বড় হাতের ৩২-অক্ষরের MD5', () => {
    expect(live.sign('{"a":1}', 'k')).toMatch(/^[0-9A-F]{32}$/);
  });

  test('buildRequest তিনটি ফিল্ড দেয়', () => {
    const r = live.buildRequest({ loginName: 'x' }, { merchantCode: 'M', aesKey: key, md5Key: 'k' });
    expect(Object.keys(r).sort()).toEqual(['merchantCode', 'params', 'signature']);
  });

  test('ভুল দৈর্ঘ্যের AES key বাতিল', () => {
    expect(() => live.encryptParams('{}', 'short')).toThrow();
  });

  test('URL ডিফল্টে obothapi + v2', () => {
    delete process.env.LIVE_API_ROOT; delete process.env.LIVE_API_VERSION;
    expect(live.endpointUrl('create', { apiRoot: 'https://api.obothapi.com/api/merchant/', version: 'v2' }))
      .toBe('https://api.obothapi.com/api/merchant/create/v2');
  });

  test('loginName-এ merchantCode ছোট হাতের', () => {
    expect(live.buildLoginName('user1', { merchantCode: '272AVA' })).toBe('272avauser1');
  });
});
