// scripts/cleanupBankCardHolderName.js — DB ছাড়া ইউনিট টেস্ট (নকল pool দিয়ে)।
const { run, parseArgs, usesRedisSessions, revokeRedisSessions } = require('../../scripts/cleanupBankCardHolderName');

const SECRET = 'TopSecretHolderValue123';

function makeEnv(extra = {}) {
  return { DATABASE_URL: 'postgres://u:pw@host/db', ...extra };
}

// স্ক্যান-সারি: দুই ইউজার (7, ৯), ৩টি অবৈধ মান (অঙ্ক/চিহ্ন-যুক্ত) + ১টি বৈধ নাম (ইউজার ৭, অক্ষত থাকতে হবে)
const INVALID_ROWS = [
  { id: 1, user_id: 7, holder_name: `${SECRET}` },
  { id: 2, user_id: 9, holder_name: 'hunter2hunter2' },
  { id: 3, user_id: 9, holder_name: 'P@ss!' },
];
const VALID_ROW = { id: 4, user_id: 7, holder_name: 'আব্দুল্লাহ' };
function makeDeps({ rowsCount = 3, usersCount = 2, failOn = null, scanRows = null } = {}) {
  const rowsForScan = scanRows || (rowsCount === 0 ? [] : [...INVALID_ROWS.slice(0, rowsCount), VALID_ROW]);
  const queries = [];
  const client = {
    query: jest.fn(async (sql) => {
      queries.push(String(sql).replace(/\s+/g, ' ').trim());
      if (failOn && String(sql).includes(failOn)) { const e = new Error(`bad ${SECRET}`); e.code = 'XX999'; throw e; }
      if (/FROM bank_cards WHERE/.test(sql) && /^\s*SELECT/i.test(sql)) return { rows: rowsForScan };
      if (/FROM users WHERE id = ANY/.test(sql)) return { rows: [{ id: 7, password: 'hash7' }] };
      if (/UPDATE bank_cards/.test(sql)) return { rowCount: rowsCount };
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  const pool = {
    query: jest.fn(async (sql) => {
      queries.push(String(sql).replace(/\s+/g, ' ').trim());
      if (/FROM bank_cards WHERE/.test(sql)) return { rows: rowsForScan };
      if (/FROM users WHERE id = ANY/.test(sql)) return { rows: [{ id: 7, password: 'hash7' }] };
      if (/FROM device_sessions/.test(sql)) return { rows: [{ sid: 'sid-1' }] };
      return { rows: [] };
    }),
    connect: jest.fn(async () => client),
  };
  const deps = {
    pool,
    revokeAllOtherSessions: jest.fn(async () => 1),
    invalidateAuthCache: jest.fn(async () => {}),
    createRedis: jest.fn(),
    compare: jest.fn(async () => false),
  };
  return { deps, queries, client, pool };
}

describe('parseArgs / usesRedisSessions', () => {
  test('ডিফল্ট dry-run; --apply চিনে; অজানা অপশন ধরে', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(parseArgs(['--force']).unknown).toEqual(['--force']);
  });
  test('Redis সেশন স্টোরের শর্ত app.js-এর মতো', () => {
    expect(usesRedisSessions({ SESSION_STORE_TYPE: 'redis', REDIS_URL: 'redis://x' })).toBe(true);
    expect(usesRedisSessions({ REDIS_URL: 'redis://x' })).toBe(true);
    expect(usesRedisSessions({ REDIS_URL: 'redis://x', SESSION_STORE_TYPE: 'postgres' })).toBe(false);
    expect(usesRedisSessions({ REDIS_URL: 'redis://x', REDIS_ENABLED: 'false' })).toBe(false);
    expect(usesRedisSessions({})).toBe(false);
  });
});

describe('dry-run (ডিফল্ট)', () => {
  test('শুধু SELECT চলে; কোনো লেখা/ALTER/ট্রানজ্যাকশন/সেশন বাতিল নেই', async () => {
    const { deps, queries, pool } = makeDeps();
    const lines = [];
    const code = await run({ argv: [], env: makeEnv(), out: (m) => lines.push(m), deps });
    expect(code).toBe(0);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(deps.revokeAllOtherSessions).not.toHaveBeenCalled();
    expect(queries.every((q) => /^SELECT/i.test(q))).toBe(true);
    expect(lines.join('\n')).toMatch(/DRY-RUN/);
    expect(lines.join('\n')).toMatch(/আক্রান্ত row: 3, আক্রান্ত ইউজার: 2/);
  });
});

describe('--apply', () => {
  test('ক্রম: ব্যাকআপ → ফাঁকা করা → ফ্ল্যাগ → COMMIT; তারপর সেশন বাতিল', async () => {
    const { deps, queries, client } = makeDeps();
    const lines = [];
    const code = await run({ argv: ['--apply'], env: makeEnv(), out: (m) => lines.push(m), deps });
    expect(code).toBe(0);
    const tx = client.query.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim());
    const idx = (re) => tx.findIndex((q) => re.test(q));
    expect(idx(/^BEGIN/)).toBe(0);
    expect(idx(/INSERT INTO bank_cards_holder_name_backup/)).toBeGreaterThan(0);
    expect(idx(/UPDATE bank_cards SET holder_name = NULL/)).toBeGreaterThan(idx(/INSERT INTO bank_cards_holder_name_backup/));
    expect(idx(/UPDATE users SET must_reset_password = true/)).toBeGreaterThan(idx(/UPDATE bank_cards SET holder_name = NULL/));
    expect(idx(/^COMMIT/)).toBe(tx.length - 1);
    expect(deps.revokeAllOtherSessions).toHaveBeenCalledTimes(2);
    expect(deps.revokeAllOtherSessions).toHaveBeenCalledWith(7, '', 'SECURITY_CLEANUP');
    expect(client.release).toHaveBeenCalled();
    expect(queries.length).toBeGreaterThan(0);
  });
  test('মাঝপথে ব্যর্থ হলে ROLLBACK, exit 1, সেশন বাতিল নয়, বার্তায় ডেটা/ত্রুটির বার্তা নেই', async () => {
    const { deps, client } = makeDeps({ failOn: 'UPDATE bank_cards' });
    const lines = [];
    const code = await run({ argv: ['--apply'], env: makeEnv(), out: (m) => lines.push(m), deps });
    expect(code).toBe(1);
    const tx = client.query.mock.calls.map((c) => String(c[0]).trim());
    expect(tx.some((q) => /^ROLLBACK/.test(q))).toBe(true);
    expect(tx.some((q) => /^COMMIT/.test(q))).toBe(false);
    expect(deps.revokeAllOtherSessions).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).toMatch(/XX999/);
  });
  test('আক্রান্ত row না থাকলে কিছুই লেখে না', async () => {
    const { deps, pool } = makeDeps({ rowsCount: 0, usersCount: 0 });
    const code = await run({ argv: ['--apply'], env: makeEnv(), out: () => {}, deps });
    expect(code).toBe(0);
    expect(pool.connect).not.toHaveBeenCalled();
  });
  test('Redis সেশন স্টোর থাকলে শুধু আক্রান্ত ইউজারের কী মোছে', async () => {
    const { deps } = makeDeps();
    const store = {
      'livo:sess:a': JSON.stringify({ user: { id: 7 } }),
      'livo:sess:b': JSON.stringify({ user: { id: 100 } }),
      'livo:sess:c': 'not-json',
    };
    const redis = {
      scan: jest.fn(async () => ['0', Object.keys(store)]),
      get: jest.fn(async (k) => store[k]),
      del: jest.fn(async (k) => { delete store[k]; return 1; }),
      disconnect: jest.fn(),
    };
    deps.createRedis = jest.fn(() => redis);
    const lines = [];
    const code = await run({ argv: ['--apply'], env: makeEnv({ REDIS_URL: 'redis://x', SESSION_STORE_TYPE: 'redis' }), out: (m) => lines.push(m), deps });
    expect(code).toBe(0);
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith('livo:sess:a');
    expect(store['livo:sess:b']).toBeDefined();
    expect(redis.disconnect).toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/Redis 1টি/);
  });
  test('কোনো আউটপুটে holder_name-এর মান/DB URL ছাপা হয় না', async () => {
    const { deps } = makeDeps();
    const lines = [];
    await run({ argv: ['--apply'], env: makeEnv(), out: (m) => lines.push(m), deps });
    const all = lines.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('postgres://');
  });
});

describe('revokeRedisSessions', () => {
  test('একাধিক পেজ SCAN সামলায়', async () => {
    const pages = [['5', ['livo:sess:x']], ['0', ['livo:sess:y']]];
    const redis = {
      scan: jest.fn(async () => pages.shift()),
      get: jest.fn(async () => JSON.stringify({ user: { id: 1 } })),
      del: jest.fn(async () => 1),
    };
    expect(await revokeRedisSessions(redis, [1])).toBe(2);
  });
});

// আক্রান্ত-সিদ্ধান্ত = ভ্যালিডেটরের সিদ্ধান্ত (একই ফাংশন; এই টেস্ট ভবিষ্যতে দুটো আলাদা হয়ে গেলে ধরবে)
describe('classifyHolderName ↔ validateHolderName সমতা', () => {
  const { classifyHolderName } = require('../../scripts/cleanupBankCardHolderName');
  const { validateHolderName } = require('../../utils/holderName');
  const SAMPLES = [
    'মোহাম্মদ রফিকুল ইসলাম', 'ফাতেমা খাতুন', 'আব্দুল্লাহ', 'শ্রীমতী কৃষ্ণা', 'রাজ্জাক', 'Md. Rahim', "O'Brien", 'Anne-Marie', 'র\u200d্যাব আলী', 'কার\u200c্য',
    'Rahim Uddin', 'রহিম উদ্দিন', '李小龍', 'José Álvarez',
    'P@ssw0rd!', 'Pass1234', '12345678', '১২৩৪৫৬', 'নাম১২৩', 'a', 'ক', 'x'.repeat(61), '-name', '.name', 'name_1', '😀 smile', '<b>x</b>', 'a\nb', 'a\tb', '..', '  ',
  ];
  test.each(SAMPLES)('%j', (v) => {
    const cls = classifyHolderName(v);
    expect(cls === 'valid').toBe(validateHolderName(v).valid);
  });
  test('শ্রেণি: অক্ষর+অঙ্ক/চিহ্ন = password_like; শুধু অঙ্ক; শুধু চিহ্ন; দৈর্ঘ্য', () => {
    expect(classifyHolderName('Pass1234')).toBe('password_like');
    expect(classifyHolderName('P@ssw0rd!')).toBe('password_like');
    expect(classifyHolderName('12345678')).toBe('digits_only');
    expect(classifyHolderName('@@@@')).toBe('symbols_only');
    expect(classifyHolderName('a')).toBe('length_or_format');
  });
});
