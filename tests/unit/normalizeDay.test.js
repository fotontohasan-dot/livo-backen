// utils/businessTime.normalizeDay + middleware/dateRangeNormalize — তারিখ স্বয়ংক্রিয় সংশোধন
const { normalizeDay } = require('../../utils/businessTime');
const { dateRangeNormalize } = require('../../middleware/dateRangeNormalize');

describe('normalizeDay', () => {
  test.each([
    ['2026-3-5', '2026-03-05'], ['2026-03-05', '2026-03-05'], ['2026/3/5', '2026-03-05'],
    ['2026.03.5', '2026-03-05'], [' 2026-3-05 ', '2026-03-05'], ['২০২৬-০৩-০৫', '2026-03-05'],
    ['2024-02-29', '2024-02-29']
  ])('%s → %s', (inp, out) => expect(normalizeDay(inp)).toBe(out));

  test.each(['', '   ', null, undefined, 'abc', '2026-13-01', '2026-02-30', '2025-02-29', '05-03-2026', '2026-3', '26-3-5', '2026-3-5T10:00'])(
    'অচেনা/অবাস্তব %p → null', (inp) => expect(normalizeDay(inp)).toBeNull());
});

describe('dateRangeNormalize', () => {
  const run = (query) => {
    const req = { method: 'GET', query, flash: jest.fn(), t: (k) => k };
    const next = jest.fn();
    dateRangeNormalize(req, {}, next);
    return { req, next };
  };
  test('সংশোধনযোগ্য from/to ঠিক হয়, flash নেই', () => {
    const { req, next } = run({ from: '2026-3-5', to: '2026/3/9', q: 'x' });
    expect(req.query).toEqual({ from: '2026-03-05', to: '2026-03-09', q: 'x' });
    expect(req.flash).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
  test('অচেনা মান বাদ + বন্ধুত্বপূর্ণ বার্তা, বৈধটা থাকে', () => {
    const { req, next } = run({ from: 'abc', to: '2026-3-9' });
    expect(req.query).toEqual({ to: '2026-03-09' });
    expect(req.flash).toHaveBeenCalledWith('error', 'admin_date_filter_invalid');
    expect(next).toHaveBeenCalledTimes(1);
  });
  test('খালি মান বাদ যায়, বার্তা নেই', () => {
    const { req } = run({ from: '', to: '' });
    expect(req.query).toEqual({});
    expect(req.flash).not.toHaveBeenCalled();
  });
  test('from/to না থাকলে অপরিবর্তিত', () => {
    const q = { page: '2' };
    const { req } = run(q);
    expect(req.query).toBe(q);
  });
});
