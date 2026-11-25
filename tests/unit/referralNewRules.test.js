// নতুন রেফারেল নিয়ম: ডিপোজিট-অঙ্ক ভিত্তিক slab (ধাপ) বোনাস ও পার্সিং (DB/Redis ছাড়া)
// ৫০০–৯৯৯=৭৫; ১,০০০–১,৯৯৯=১০০; ২,০০০–৪,৯৯৯=২০০; ৫,০০০–৯,৯৯৯=৩০০; ১০,০০০–২৯,৯৯৯=৫০০; ৩০,০০০+=১,০০০।
jest.mock('../../db', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));
jest.mock('../../services/settings', () => ({ getSetting: jest.fn() }));
jest.mock('../../services/turnover', () => ({ createBonus: jest.fn() }));

const {
  slabFor, parseSlabs, DEFAULT_SLABS, DEFAULT_MIN_DEPOSIT, DEFAULT_BONUS_CAP
} = require('../../services/referralRewards');

describe('referral: DEFAULT_SLABS ও ন্যূনতম ডিপোজিট', () => {
  test('ডিফল্ট ন্যূনতম ডিপোজিট ৫০০', () => expect(DEFAULT_MIN_DEPOSIT).toBe(500));
  test('ডিফল্ট ক্যাপ ১,০০০', () => expect(DEFAULT_BONUS_CAP).toBe(1000));
  test('DEFAULT_SLABS হুবহু ছয় ধাপ', () => {
    expect(DEFAULT_SLABS).toEqual([
      { min: 500, amount: 75 }, { min: 1000, amount: 100 }, { min: 2000, amount: 200 },
      { min: 5000, amount: 300 }, { min: 10000, amount: 500 }, { min: 30000, amount: 1000 }
    ]);
  });
  test('প্রথম ধাপের min = ন্যূনতম ডিপোজিট; min কঠোরভাবে ক্রমবর্ধমান; বোনাস অবরোহী নয়', () => {
    expect(DEFAULT_SLABS[0].min).toBe(DEFAULT_MIN_DEPOSIT);
    for (let i = 1; i < DEFAULT_SLABS.length; i++) {
      expect(DEFAULT_SLABS[i].min).toBeGreaterThan(DEFAULT_SLABS[i - 1].min);
      expect(DEFAULT_SLABS[i].amount).toBeGreaterThan(DEFAULT_SLABS[i - 1].amount);
    }
  });
  test('DEFAULT_SLABS নিজেই parseSlabs-এ বৈধ', () => expect(parseSlabs(DEFAULT_SLABS)).toEqual(DEFAULT_SLABS));
});

describe('referral: slabFor — প্রতিটি ধাপ-সীমা ও ঠিক আগে-পরের মান', () => {
  test.each([
    [499, null, null], [499.99, null, null],
    [500, 75, 1], [501, 75, 1], [999, 75, 1], [999.99, 75, 1],
    [1000, 100, 2], [1001, 100, 2], [1999, 100, 2], [1999.99, 100, 2],
    [2000, 200, 3], [2001, 200, 3], [4999, 200, 3], [4999.99, 200, 3],
    [5000, 300, 4], [5001, 300, 4], [9999, 300, 4], [9999.99, 300, 4],
    [10000, 500, 5], [10001, 500, 5], [29999, 500, 5], [29999.99, 500, 5],
    [30000, 1000, 6], [30001, 1000, 6], [50000, 1000, 6], [1000000, 1000, 6]
  ])('deposit %p → bonus %p (slab %p)', (dep, want, slab) => {
    const hit = slabFor(dep);
    if (want === null) expect(hit).toBeNull();
    else { expect(hit.amount).toBe(want); expect(hit.slab).toBe(slab); }
  });

  test('৪৯৯ → বোনাস নেই (null)', () => expect(slabFor(499)).toBeNull());
  test('ন্যূনতম ৫০০ ঠিক → প্রথম ধাপ ৭৫', () => expect(slabFor(DEFAULT_MIN_DEPOSIT)).toEqual({ slab: 1, amount: 75 }));
  test('অসংখ্য/অবৈধ ইনপুট → null', () => {
    [0, -1, -500, NaN, Infinity, 'abc', '', undefined, null].forEach(v => expect(slabFor(v)).toBeNull());
  });
  test('সংখ্যার স্ট্রিংও গৃহীত', () => expect(slabFor('1000').amount).toBe(100));

  test('ক্যাপ বোনাস সীমিত করে; ক্যাপ বড় হলে বাড়ায় না', () => {
    expect(slabFor(50000, DEFAULT_SLABS, 800).amount).toBe(800);
    expect(slabFor(30000, DEFAULT_SLABS, 1000).amount).toBe(1000);
    expect(slabFor(500, DEFAULT_SLABS, 5000).amount).toBe(75);
    expect(slabFor(5000, DEFAULT_SLABS, 150).amount).toBe(150);
    expect(slabFor(500, DEFAULT_SLABS, 50).amount).toBe(50);
  });

  test('কাস্টম slab কনফিগে সীমা মানা হয়', () => {
    const custom = [{ min: 600, amount: 50 }, { min: 2000, amount: 150 }];
    expect(slabFor(599, custom)).toBeNull();
    expect(slabFor(600, custom)).toEqual({ slab: 1, amount: 50 });
    expect(slabFor(1999, custom).amount).toBe(50);
    expect(slabFor(2000, custom)).toEqual({ slab: 2, amount: 150 });
    expect(slabFor(1e6, custom).amount).toBe(150);
  });
});

describe('referral: parseSlabs', () => {
  test('অবৈধ ইনপুট প্রত্যাখ্যাত', () => {
    expect(parseSlabs('nope')).toBeNull();
    expect(parseSlabs('not json')).toBeNull();
    expect(parseSlabs('[]')).toBeNull();
    expect(parseSlabs([])).toBeNull();
    expect(parseSlabs('{"min":500,"amount":75}')).toBeNull(); // অ্যারে নয়
    expect(parseSlabs(null)).toBeNull();
    expect(parseSlabs(undefined)).toBeNull();
    expect(parseSlabs([{ min: 1000, amount: 10 }, { min: 500, amount: 5 }])).toBeNull(); // min ক্রমবর্ধমান নয়
    expect(parseSlabs([{ min: 500, amount: 10 }, { min: 500, amount: 20 }])).toBeNull(); // সমান min
    expect(parseSlabs([{ min: 500, amount: -1 }])).toBeNull(); // ঋণাত্মক বোনাস
    expect(parseSlabs([{ min: 0, amount: 5 }])).toBeNull(); // min ≤ ০
    expect(parseSlabs([{ min: -5, amount: 5 }])).toBeNull();
    expect(parseSlabs([{ min: 'x', amount: 5 }])).toBeNull();
    expect(parseSlabs([{ min: 500, amount: 'x' }])).toBeNull();
    expect(parseSlabs([null])).toBeNull();
  });
  test('বৈধ JSON স্ট্রিং গৃহীত', () => {
    expect(parseSlabs('[{"min":500,"amount":75}]')).toEqual([{ min: 500, amount: 75 }]);
    expect(parseSlabs('[{"min":600,"amount":50},{"min":2000,"amount":150}]'))
      .toEqual([{ min: 600, amount: 50 }, { min: 2000, amount: 150 }]);
  });
  test('বৈধ অ্যারে গৃহীত ও সংখ্যায় স্বাভাবিকীকৃত; বোনাস ০ বৈধ', () => {
    expect(parseSlabs([{ min: '500', amount: '75' }])).toEqual([{ min: 500, amount: 75 }]);
    expect(parseSlabs([{ min: 500, amount: 0 }])).toEqual([{ min: 500, amount: 0 }]);
  });
});
