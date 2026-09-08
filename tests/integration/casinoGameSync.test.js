// tests/integration/casinoGameSync.test.js
// ---------------------------------------------------------------------------
// PHASE 3 — "credential বসালেই গেম লবিতে ভেসে ওঠে" — এন্ড-টু-এন্ড যাচাই।
//
// এটাই পুরো ফেজের কেন্দ্রীয় দাবি, তাই আসল ডাটাবেসের বিরুদ্ধে পরীক্ষা করা
// হচ্ছে (UPSERT, unique index ও deactivate-লজিক mock করলে কিছুই প্রমাণ হয় না)।
//
// যা লক করা হচ্ছে:
//   ১. mock credential বসিয়ে sync চালালে গেম DB-তে ঢোকে
//   ২. দ্বিতীয় sync ডুপ্লিকেট তৈরি করে না, শুধু হালনাগাদ করে
//   ৩. এবার না-আসা গেম is_active=false হয় — মুছে যায় না (ঐতিহাসিক bet আছে)
//   ৪. admin_disabled sync-এ কখনো overwrite হয় না
//   ৫. প্রতিটা run provider_sync_log-এ লেখা হয়
// ---------------------------------------------------------------------------

const { pool } = require('../../db');

const MOCK_ENV = {
  PROVIDER_MOCK_CASINO_API_URL: 'https://example.invalid',
  PROVIDER_MOCK_CASINO_AGENT_ID: 'agent-x',
  PROVIDER_MOCK_CASINO_SECRET: 'secret-x',
  PROVIDER_MOCK_CASINO_GAME_COUNT: '8'
};
const PROVIDER = 'mock-casino';

function enableMock(count) {
  Object.assign(process.env, MOCK_ENV);
  if (count) process.env.PROVIDER_MOCK_CASINO_GAME_COUNT = String(count);
  jest.resetModules();
  return require('../../services/casinoGameSync');
}

function disableMock() {
  Object.keys(MOCK_ENV).forEach(k => delete process.env[k]);
  jest.resetModules();
}

async function cleanup() {
  await pool.query('DELETE FROM provider_sync_log WHERE provider = $1', [PROVIDER]);
  await pool.query('DELETE FROM games WHERE provider = $1', [PROVIDER]);
}

describe('casino game sync', () => {
  beforeEach(cleanup);
  afterAll(async () => { await cleanup(); disableMock(); });
  afterEach(disableMock);

  test('credential বসালে sync চলে ও গেম DB-তে ঢোকে', async () => {
    const sync = enableMock(8);
    const out = await sync.syncAll();
    expect(out.skipped).toBe(false);
    expect(out.results[0].status).toBe('success');
    expect(out.results[0].added).toBe(8);

    const r = await pool.query('SELECT COUNT(*)::int AS c FROM games WHERE provider = $1', [PROVIDER]);
    expect(r.rows[0].c).toBe(8);
  });

  test('credential ছাড়া sync কিছুই করে না', async () => {
    disableMock();
    const sync = require('../../services/casinoGameSync');
    const out = await sync.syncAll();
    expect(out.skipped).toBe(true);
  });

  test('দ্বিতীয় sync ডুপ্লিকেট বানায় না, হালনাগাদ করে', async () => {
    let sync = enableMock(8);
    await sync.syncAll();
    sync = enableMock(8);
    const out = await sync.syncAll();

    expect(out.results[0].added).toBe(0);
    expect(out.results[0].updated).toBe(8);
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM games WHERE provider = $1', [PROVIDER]);
    expect(r.rows[0].c).toBe(8);
  });

  test('এবার না-আসা গেম নিষ্ক্রিয় হয়, মুছে যায় না', async () => {
    let sync = enableMock(8);
    await sync.syncAll();
    sync = enableMock(5); // প্রোভাইডার ৩টা গেম সরিয়ে নিয়েছে
    const out = await sync.syncAll();

    expect(out.results[0].removed).toBe(3);
    const total = await pool.query('SELECT COUNT(*)::int AS c FROM games WHERE provider = $1', [PROVIDER]);
    expect(total.rows[0].c).toBe(8); // সারি এখনো আছে
    const active = await pool.query(
      'SELECT COUNT(*)::int AS c FROM games WHERE provider = $1 AND is_active = true', [PROVIDER]
    );
    expect(active.rows[0].c).toBe(5);
  });

  test('admin_disabled sync-এ কখনো overwrite হয় না', async () => {
    let sync = enableMock(8);
    await sync.syncAll();
    await pool.query(
      `UPDATE games SET admin_disabled = true WHERE provider = $1 AND provider_game_id = 'mock-001'`,
      [PROVIDER]
    );

    sync = enableMock(8);
    await sync.syncAll();

    const r = await pool.query(
      `SELECT admin_disabled FROM games WHERE provider = $1 AND provider_game_id = 'mock-001'`,
      [PROVIDER]
    );
    expect(r.rows[0].admin_disabled).toBe(true);
  });

  test('প্রতিটা run provider_sync_log-এ লেখা হয়', async () => {
    const sync = enableMock(4);
    await sync.syncAll();
    const logs = await pool.query(
      `SELECT status, games_added, finished_at FROM provider_sync_log WHERE provider = $1`, [PROVIDER]
    );
    expect(logs.rows.length).toBe(1);
    expect(logs.rows[0].status).toBe('success');
    expect(logs.rows[0].games_added).toBe(4);
    expect(logs.rows[0].finished_at).not.toBeNull();
  });

  test('slug প্রোভাইডার-স্কোপড, তাই দুই প্রোভাইডারে একই game id সংঘর্ষ করে না', () => {
    const sync = require('../../services/casinoGameSync');
    expect(sync.slugFor('a', 'g1')).toBe('a:g1');
    expect(sync.slugFor('b', 'g1')).toBe('b:g1');
  });
});
