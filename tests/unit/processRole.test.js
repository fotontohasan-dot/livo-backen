// Test D (unit) — PROCESS_ROLE রেজল্যুশন। কোনো I/O নেই।
const { resolveProcessRole, runsWeb, runsWorker, VALID_ROLES } = require('../../services/processRole');

describe('resolveProcessRole', () => {
  test('সেট না থাকলে all (backward-compatible)', () => {
    expect(resolveProcessRole({})).toBe('all');
  });

  test.each(['all', 'web', 'worker'])('বৈধ মান %s গ্রহণ করে', (role) => {
    expect(resolveProcessRole({ PROCESS_ROLE: role })).toBe(role);
  });

  test('case ও whitespace সহনশীল', () => {
    expect(resolveProcessRole({ PROCESS_ROLE: '  Worker ' })).toBe('worker');
  });

  test.each(['', 'bogus', 'web,worker', 'api', '1'])('অবৈধ মান %p-তে পরিষ্কার error', (bad) => {
    expect(() => resolveProcessRole({ PROCESS_ROLE: bad })).toThrow(/অবৈধ PROCESS_ROLE/);
  });

  test('role → কোন কাজ চলে', () => {
    expect(VALID_ROLES).toEqual(['all', 'web', 'worker']);
    expect([runsWeb('all'), runsWeb('web'), runsWeb('worker')]).toEqual([true, true, false]);
    expect([runsWorker('all'), runsWorker('web'), runsWorker('worker')]).toEqual([true, false, true]);
  });
});
