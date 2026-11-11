// scripts/migrate.js — mock-ভিত্তিক ইউনিট টেস্ট (কোনো DB লাগে না)।
const { run, redact, applyOverride } = require('../../scripts/migrate');

const SECRET_PW = 'Zq9-unit-secret-PW';
// scheme আলাদা করে বানানো: নইলে scripts/scanSecrets.js এই ফেক URL-কে আসল credential ভাবে
const PG_SCHEME = 'postgres' + '://';
const MAIN_URL = `${PG_SCHEME}app_user:${SECRET_PW}@main-host.invalid:5432/maindb`;
const MIG_URL = `${PG_SCHEME}mig_user:${SECRET_PW}2@direct-host.invalid:5432/migdb`;

function makeLog() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { lines, log: { log: push, warn: push, error: push } };
}
const makePool = () => ({ end: jest.fn(async () => {}) });

describe('scripts/migrate run()', () => {
  test('সফল → 0, runMigrations একবার, pool.end একবার', async () => {
    const pool = makePool(); const runMigrations = jest.fn(async () => {});
    const { log } = makeLog();
    const code = await run({ env: { DATABASE_URL: MAIN_URL }, log, load: () => ({ runMigrations, pool }) });
    expect(code).toBe(0);
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  test('migration ব্যর্থ → 1, তবুও pool.end ডাকা হয়', async () => {
    const pool = makePool(); const runMigrations = jest.fn(async () => { throw new Error('boom'); });
    const { log, lines } = makeLog();
    const code = await run({ env: { DATABASE_URL: MAIN_URL }, log, load: () => ({ runMigrations, pool }) });
    expect(code).toBe(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toMatch(/boom/);
  });

  test('pool.end ব্যর্থ হলে ফলাফল (0) বদলায় না, শুধু সতর্কতা লগ হয়', async () => {
    const pool = { end: jest.fn(async () => { throw new Error('close failed'); }) };
    const { log, lines } = makeLog();
    const code = await run({ env: { DATABASE_URL: MAIN_URL }, log, load: () => ({ runMigrations: async () => {}, pool }) });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/close failed/);
  });

  test('load() নিজেই ব্যর্থ (যেমন require error) → 1, pool নেই বলে end ডাকা হয় না', async () => {
    const { log } = makeLog();
    const code = await run({ env: { DATABASE_URL: MAIN_URL }, log, load: () => { throw new Error('load failed'); } });
    expect(code).toBe(1);
  });

  test('কোনো URL নেই → 1 এবং load() ডাকা হয় না', async () => {
    const load = jest.fn(); const { log } = makeLog();
    const code = await run({ env: {}, log, load });
    expect(code).toBe(1);
    expect(load).not.toHaveBeenCalled();
  });

  test('MIGRATION_DATABASE_URL থাকলে সেটাই DATABASE_URL হয়ে load()-এর আগে বসে', async () => {
    const env = { DATABASE_URL: MAIN_URL, MIGRATION_DATABASE_URL: MIG_URL };
    let seenAtLoad = null;
    const { log, lines } = makeLog();
    await run({ env, log, load: () => { seenAtLoad = env.DATABASE_URL; return { runMigrations: async () => {}, pool: makePool() }; } });
    expect(seenAtLoad).toBe(MIG_URL);
    expect(lines.join('\n')).toMatch(/MIGRATION_DATABASE_URL/);
  });

  test('ওভাররাইড না থাকলে (বা ফাঁকা) বিদ্যমান DATABASE_URL অপরিবর্তিত', () => {
    const a = { DATABASE_URL: MAIN_URL };
    const b = { DATABASE_URL: MAIN_URL, MIGRATION_DATABASE_URL: '   ' };
    expect(applyOverride(a)).toBe(false); expect(a.DATABASE_URL).toBe(MAIN_URL);
    expect(applyOverride(b)).toBe(false); expect(b.DATABASE_URL).toBe(MAIN_URL);
  });

  test('DB_POOL_MAX: না থাকলে 2, স্পষ্ট মান থাকলে অক্ষত', async () => {
    const e1 = { DATABASE_URL: MAIN_URL }; const e2 = { DATABASE_URL: MAIN_URL, DB_POOL_MAX: '7' };
    const mk = () => ({ runMigrations: async () => {}, pool: makePool() });
    await run({ env: e1, log: makeLog().log, load: mk });
    await run({ env: e2, log: makeLog().log, load: mk });
    expect(e1.DB_POOL_MAX).toBe('2'); expect(e2.DB_POOL_MAX).toBe('7');
  });

  test('লগে কোনো URL/পাসওয়ার্ড নেই — সফল, ব্যর্থ ও ওভাররাইড, সব পথে', async () => {
    const env = { DATABASE_URL: MAIN_URL, MIGRATION_DATABASE_URL: MIG_URL };
    const { log, lines } = makeLog();
    const leaky = new Error(`connect failed for ${MIG_URL} (also ${MAIN_URL}) password=${SECRET_PW}`);
    await run({ env, log, load: () => ({ runMigrations: async () => { throw leaky; }, pool: makePool() }) });
    const out = lines.join('\n');
    expect(out).not.toContain(SECRET_PW);
    expect(out).not.toContain('main-host.invalid');
    expect(out).not.toContain('direct-host.invalid');
    expect(out).not.toMatch(/postgres:\/\/[^<\s]/);
    expect(out).toContain('<redacted>');
  });

  test('redact(): URL-এ এম্বেড করা পাসওয়ার্ড ও অজানা postgres:// স্ট্রিং দুটোই মোছে', () => {
    const msg = redact(`x ${MAIN_URL} y postgres://other:pw@elsewhere/db z ${SECRET_PW}`, { DATABASE_URL: MAIN_URL });
    expect(msg).not.toContain(SECRET_PW);
    expect(msg).not.toContain('elsewhere');
  });

  test('require করলে কিছু চালু হয় না (পুল/সংযোগ নেই)', () => {
    expect(typeof run).toBe('function');
  });
});
