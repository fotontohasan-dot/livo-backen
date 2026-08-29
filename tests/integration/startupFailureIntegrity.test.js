// tests/integration/startupFailureIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 2 — DATABASE & STARTUP FAILURE INTEGRITY
//
// আগের আচরণ (vulnerable):
//   * runMigrations() সব error গিলে ফেলত → server.js "DB migration done" ছাপত
//     (Migration failed → Migration successful — contradictory state)
//   * connectDB() DB unreachable হলেও normally return করত → "PostgreSQL
//     connected successfully" ছাপত এবং DB ছাড়াই route চালু হত
//   * ensureCriticalTables() প্রতিটি ব্যর্থতা শুধু log করে সফল return করত
//   * /ready শুধু `SELECT 1` দেখত, তাই ভাঙা schema-তেও healthy দেখাত
//
// এই suite সেই fail-closed semantics গুলো লক করে।
// কোনো test প্রকৃত production DB/admin data স্পর্শ করে না — সবই mock/isolated।
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');

describe('Startup failure integrity (PHASE 2)', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  describe('connectDB() fail-closed', () => {
    test('DATABASE_URL না থাকলে connectDB() throw করে (silent skip নয়)', async () => {
      jest.resetModules();
      const original = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        const { connectDB } = require('../../db');
        await expect(connectDB()).rejects.toThrow(/DATABASE_URL/);
      } finally {
        process.env.DATABASE_URL = original;
        jest.resetModules();
      }
    });

    test('DB unreachable হলে connectDB() throw করে — "continuing without DB" নেই', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
      expect(src).not.toMatch(/Continuing without DB/i);
      expect(src).toMatch(/PostgreSQL connection failed after 5 attempts/);
    });
  });

  describe('runMigrations() fail-closed', () => {
    test('migration error গিলে ফেলা হয় না — rethrow করা হয়', () => {
      const src = fs.readFileSync(path.join(ROOT, 'migrations.js'), 'utf8');
      //  catch      throw  
      const tail = src.slice(src.lastIndexOf('} catch (err) {'));
      expect(tail).toMatch(/throw err;/);
    });

    test('startupState migration ব্যর্থতা রেকর্ড করে এবং schema-ready false হয়', () => {
      jest.resetModules();
      const startupState = require('../../services/startupState');
      const originalEnv = process.env.NODE_ENV;
      try {
        startupState.reset();
        startupState.markMigrationsFailed(new Error('relation "users" does not exist'));
        process.env.NODE_ENV = 'production';
        expect(startupState.isSchemaReady()).toBe(false);
        expect(startupState.getState().migrationError).toMatch(/does not exist/);

        startupState.markMigrationsCompleted();
        expect(startupState.isSchemaReady()).toBe(true);
        expect(startupState.getState().migrationError).toBeNull();
      } finally {
        process.env.NODE_ENV = originalEnv;
        startupState.reset();
        startupState.markMigrationsCompleted();
      }
    });
  });

  describe('ensureCriticalTables() fail-closed', () => {
    test('কোনো critical table তৈরি ব্যর্থ হলে aggregate error throw হয়', async () => {
      jest.resetModules();
      jest.doMock('../../db', () => ({
        pool: { query: jest.fn().mockRejectedValue(new Error('permission denied for schema public')) }
      }));
      const { ensureCriticalTables } = require('../../services/ensureCriticalTables');
      await expect(ensureCriticalTables()).rejects.toThrow(/Critical table verification failed/);
      jest.dontMock('../../db');
      jest.resetModules();
    });

    test('সব table ঠিক থাকলে কোনো error throw হয় না', async () => {
      jest.resetModules();
      jest.doMock('../../db', () => ({
        pool: { query: jest.fn().mockResolvedValue({ rows: [] }) }
      }));
      const { ensureCriticalTables } = require('../../services/ensureCriticalTables');
      await expect(ensureCriticalTables()).resolves.toBeUndefined();
      jest.dontMock('../../db');
      jest.resetModules();
    });
  });

  describe('/ready কখনো fake success দেখায় না', () => {
    test('schema ready না হলে readiness() throw করে (DB ping সফল হলেও)', async () => {
      jest.resetModules();
      jest.doMock('../../services/startupState', () => ({
        isSchemaReady: () => false,
        getState: () => ({ migrationError: 'migration 42 failed' }),
      }));
      jest.doMock('../../db', () => ({
        pool: { query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) }
      }));
      const { readiness } = require('../../services/healthCheck');
      await expect(readiness()).rejects.toThrow(/Schema not ready/);
      jest.dontMock('../../services/startupState');
      jest.dontMock('../../db');
      jest.resetModules();
    });

    test('DB unreachable হলে readiness() throw করে', async () => {
      jest.resetModules();
      jest.doMock('../../services/startupState', () => ({
        isSchemaReady: () => true,
        getState: () => ({ migrationError: null }),
      }));
      jest.doMock('../../db', () => ({
        pool: { query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
      }));
      const { readiness } = require('../../services/healthCheck');
      await expect(readiness()).rejects.toThrow(/DB not ready/);
      jest.dontMock('../../services/startupState');
      jest.dontMock('../../db');
      jest.resetModules();
    });

    test('সব ঠিক থাকলে readiness() ready ফেরত দেয় (zero-regression)', async () => {
      jest.resetModules();
      jest.doMock('../../services/startupState', () => ({
        isSchemaReady: () => true,
        getState: () => ({ migrationError: null }),
      }));
      jest.doMock('../../db', () => ({
        pool: { query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) }
      }));
      const { readiness } = require('../../services/healthCheck');
      await expect(readiness()).resolves.toEqual({ status: 'ready' });
      jest.dontMock('../../services/startupState');
      jest.dontMock('../../db');
      jest.resetModules();
    });
  });

  describe('server.js startup ordering', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    test('ensureCriticalTables() আর swallow করা হয় না', () => {
      const idx = src.indexOf('ensureCriticalTables()');
      expect(idx).toBeGreaterThan(-1);
      const around = src.slice(Math.max(0, idx - 400), idx + 200);
      expect(around).not.toMatch(/catch \(e\) \{\s*console\.error\('ensureCriticalTables:/);
    });

    test('listen() করার আগে connectDB → runMigrations → ensureCriticalTables হয়', () => {
      const iConnect = src.indexOf('await connectDB()');
      const iMigrate = src.indexOf('await runMigrations()');
      const iTables  = src.indexOf('await ensureCriticalTables()');
      const iListen  = src.indexOf('server.listen(PORT');
      expect(iConnect).toBeGreaterThan(-1);
      expect(iMigrate).toBeGreaterThan(iConnect);
      expect(iTables).toBeGreaterThan(iMigrate);
      expect(iListen).toBeGreaterThan(iTables);
    });

    test('startup ব্যর্থ হলে process exit(1) হয় (fake success নয়)', () => {
      const idx = src.indexOf('Server startup failed');
      expect(idx).toBeGreaterThan(-1);
      expect(src.slice(idx, idx + 200)).toMatch(/process\.exit\(1\)/);
    });
  });
});
