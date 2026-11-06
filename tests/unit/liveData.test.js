const { sanitizeLive } = require('../../services/liveData');

test('cricket: clamps numbers, keeps only valid ball tokens, max 2 batsmen', () => {
  const o = sanitizeLive('cricket', {
    runs: 128, wickets: 99, overs: '15.2', runRate: 8.35,
    batsmen: [{ name: 'A', runs: 50, balls: 30, fours: 5, sixes: 2, strike: true }, { name: 'B' }, { name: 'C' }],
    bowler: { name: 'X', overs: '3', runs: 20, wickets: 1 },
    balls: ['0', '1', '4', '6', 'w', '<script>', 'wd', '123']
  });
  expect(o.wickets).toBe(10);
  expect(o.batsmen).toHaveLength(2);
  expect(o.balls).toEqual(['0', '1', '4', '6', 'W', 'WD']);
});
test('football and tennis shapes', () => {
  expect(sanitizeLive('football', { clock: "67'", period: '2H', halves: [[1, 0]], momentum: 140 }).momentum).toBe(100);
  const t = sanitizeLive('tennis', { sets: [[6, 4], [3, 2]], game: ['30', '15'], server: 1 });
  expect(t.sets).toEqual([[6, 4], [3, 2]]);
  expect(t.server).toBe(1);
});
test('rejects junk and unknown sports', () => {
  expect(sanitizeLive('cricket', 'x')).toBeNull();
  expect(sanitizeLive('cricket', {})).toBeNull();
  expect(sanitizeLive('rugby', { runs: 1 })).toBeNull();
});
