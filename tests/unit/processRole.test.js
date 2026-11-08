// PROCESS_ROLE পার্সিং — ডিফল্ট all, ভুল মানে স্পষ্ট এরর (নিঃশব্দে all-এ নামে না)।
const { resolveProcessRole, VALID_ROLES } = require('../../services/processRole');

describe('resolveProcessRole', () => {
  test('অনুপস্থিত/ফাঁকা হলে ডিফল্ট all (পুরনো ডিপ্লয়মেন্ট অপরিবর্তিত)', () => {
    expect(resolveProcessRole({})).toEqual({ role: 'all', runsWeb: true, runsWorker: true });
    expect(resolveProcessRole({ PROCESS_ROLE: '' }).role).toBe('all');
    expect(resolveProcessRole({ PROCESS_ROLE: '   ' }).role).toBe('all');
  });

  test('web শুধু web, worker শুধু worker', () => {
    expect(resolveProcessRole({ PROCESS_ROLE: 'web' })).toEqual({ role: 'web', runsWeb: true, runsWorker: false });
    expect(resolveProcessRole({ PROCESS_ROLE: 'worker' })).toEqual({ role: 'worker', runsWeb: false, runsWorker: true });
  });

  test('বড়/ছোট হাত ও স্পেস সহ্য করে', () => {
    expect(resolveProcessRole({ PROCESS_ROLE: ' WORKER ' }).role).toBe('worker');
  });

  test.each(['workers', 'api', 'both', 'true', '0'])('ভুল মান "%s" → throw', (bad) => {
    expect(() => resolveProcessRole({ PROCESS_ROLE: bad })).toThrow(/Invalid PROCESS_ROLE/);
  });

  test('VALID_ROLES ঠিক তিনটি', () => {
    expect([...VALID_ROLES]).toEqual(['all', 'web', 'worker']);
  });
});
