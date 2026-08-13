// tests/unit/referralCommissionRates.test.js
// services/settings.js মক করা হয়েছে, তাই কোনো আসল DB/Redis ছাড়াই চলে।
// যাচাই করে: /admin/settings থেকে সেট করা referral_commission_tierN_percent
// services/referral.js-এর distributeCommission()-এ আসলেই ব্যবহার হয়, এবং অবৈধ/অনুপস্থিত
// মানে নিরাপদে ডিফল্ট রেটে ফলব্যাক করে (কখনো NaN/negative রেট দিয়ে ভুল কমিশন দেয় না)।

jest.mock('../../services/settings', () => ({
  getSetting: jest.fn()
}));

const { getSetting } = require('../../services/settings');
const { getCommissionRates, DEFAULT_COMMISSION_RATES } = require('../../services/referral');

describe('services/referral: getCommissionRates', () => {
  beforeEach(() => {
    getSetting.mockReset();
  });

  test('অ্যাডমিন-সেট করা বৈধ percent মানকে fraction-এ রূপান্তর করে', async () => {
    getSetting.mockImplementation((key) => {
      const map = {
        referral_commission_tier1_percent: '5',
        referral_commission_tier2_percent: '2',
        referral_commission_tier3_percent: '1'
      };
      return Promise.resolve(map[key]);
    });

    const rates = await getCommissionRates();
    expect(rates).toEqual([0.05, 0.02, 0.01]);
  });

  test('সেটিং না থাকলে (undefined) ডিফল্ট রেটে ফলব্যাক করে', async () => {
    getSetting.mockResolvedValue(undefined);
    const rates = await getCommissionRates();
    expect(rates).toEqual(DEFAULT_COMMISSION_RATES);
  });

  test('অবৈধ (non-numeric) মানে ডিফল্ট রেটে ফলব্যাক করে', async () => {
    getSetting.mockResolvedValue('not-a-number');
    const rates = await getCommissionRates();
    expect(rates).toEqual(DEFAULT_COMMISSION_RATES);
  });

  test('রেঞ্জের বাইরে (negative বা >100) মানে ডিফল্ট রেটে ফলব্যাক করে', async () => {
    getSetting.mockImplementation((key) => {
      if (key === 'referral_commission_tier1_percent') return Promise.resolve('-5');
      if (key === 'referral_commission_tier2_percent') return Promise.resolve('150');
      return Promise.resolve('1');
    });
    const rates = await getCommissionRates();
    expect(rates[0]).toBe(DEFAULT_COMMISSION_RATES[0]); // -5 → ডিফল্ট
    expect(rates[1]).toBe(DEFAULT_COMMISSION_RATES[1]); // 150 → ডিফল্ট
    expect(rates[2]).toBe(0.01); // বৈধ মান ব্যবহার হয়
  });

  test('0% একটা বৈধ রেট (রেফারেল কমিশন সম্পূর্ণ বন্ধ করার জন্য)', async () => {
    getSetting.mockResolvedValue('0');
    const rates = await getCommissionRates();
    expect(rates).toEqual([0, 0, 0]);
  });
});
