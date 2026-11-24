// নতুন রেফারেল নিয়ম: ডিপোজিট-অঙ্ক বোনাস ধাপ ও পার্সিং (DB/Redis ছাড়া)
jest.mock('../../db', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../../services/settings', () => ({ getSetting: jest.fn() }));
jest.mock('../../services/turnover', () => ({ createBonus: jest.fn() }));

const { bonusForDeposit, parseBands, DEFAULT_BANDS, DEFAULT_MIN_DEPOSIT } = require('../../services/referralRewards');

describe('referral: deposit-amount bonus bands', () => {
  test.each([
    [99, 0], [100, 20], [150, 20], [199, 20],
    [200, 50], [300, 50], [400, 50], [499, 50],
    [500, 75], [5000, 75]
  ])('deposit %p → bonus %p', (dep, want) => {
    expect(bonusForDeposit(dep, DEFAULT_BANDS).amount).toBe(want);
  });
  test('default min deposit is 100', () => expect(DEFAULT_MIN_DEPOSIT).toBe(100));
  test('parseBands rejects bad input', () => {
    expect(parseBands('nope')).toBeNull();
    expect(parseBands([{ min: 200, amount: 50 }, { min: 100, amount: 20 }])).toBeNull();
    expect(parseBands([{ min: 100, amount: -1 }])).toBeNull();
  });
  test('parseBands accepts valid JSON string', () => {
    expect(parseBands('[{"min":100,"amount":20}]')).toEqual([{ min: 100, amount: 20 }]);
  });
});
