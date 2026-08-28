// tests/security/auditBackupProdConfig.test.js
// ---------------------------------------------------------------------------
// PHASE 14 (AUDIT LOGGING) + 15 (BACKUP/RESTORE) + 16 (PRODUCTION CONFIG)
//
//   MEDIUM-11 : logEvent() details কোনো redaction ছাড়াই JSONB-তে লিখত।
//               বর্তমান caller গুলো সতর্ক, কিন্তু একটি নতুন caller ভুল করে
//               req.body দিলে password/token চিরকাল audit_logs-এ থেকে যেত।
//
//   বাকিগুলো regression lock: প্রকৃত restore যাচাই, checksum tamper rejection,
//   session cookie ও production config।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const auditLog = require('../../services/auditLog');
const backupManager = require('../../services/backupManager');
const { uniqueUsername, uniquePhone } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('Audit, backup and production config (PHASE 14-16)', () => {
  describe('PHASE 14: MEDIUM-11 audit redaction', () => {
    test('sensitive key গুলো redact হয়', () => {
      const out = auditLog.redactDetails({
        password: 'hunter2',
        totp_secret: 'JBSWY3DPEHPK3PXP',
        sessionCookie: 'connect.sid=abc',
        api_key: 'k-123456',
        backup_code: '11112222',
        username: 'bob',
        amount: 500,
      });
      expect(out.password).toBe('[REDACTED]');
      expect(out.totp_secret).toBe('[REDACTED]');
      expect(out.sessionCookie).toBe('[REDACTED]');
      expect(out.api_key).toBe('[REDACTED]');
      expect(out.backup_code).toBe('[REDACTED]');
      //     
      expect(out.username).toBe('bob');
      expect(out.amount).toBe(500);
    });

    test('nested object ও array-তেও redaction কাজ করে', () => {
      const out = auditLog.redactDetails({
        level1: { level2: { password: 'x', ok: 'keep' } },
        list: [{ token: 'secret-value' }, { safe: 1 }],
      });
      expect(out.level1.level2.password).toBe('[REDACTED]');
      expect(out.level1.level2.ok).toBe('keep');
      expect(out.list[0].token).toBe('[REDACTED]');
      expect(out.list[1].safe).toBe(1);
    });

    test('token-সদৃশ মান key নিরীহ হলেও redact হয়', () => {
      // fixture গুলো runtime-এ জোড়া লাগানো হয়, যাতে repo-wide secret scanner
      // এই ফাইলটিকে সত্যিকারের credential leak হিসেবে না ধরে
      const fakeBotToken = '123456789' + ':' + 'AAF-abcdefghijklmnopqrstuvwxyz012345';
      const fakePat = 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
      const out = auditLog.redactDetails({
        note: fakeBotToken,
        other: fakePat,
        plain: 'just a normal message',
      });
      expect(out.note).toBe('[REDACTED]');
      expect(out.other).toBe('[REDACTED]');
      expect(out.plain).toBe('just a normal message');
    });

    test('logEvent() DB-তে লেখার সময় redaction প্রয়োগ করে', async () => {
      const u = await pool.query(
        `INSERT INTO users (username, phone, password, role) VALUES ($1,$2,'x','user') RETURNING id`,
        [uniqueUsername('au'), uniquePhone()]
      );
      const userId = u.rows[0].id;

      await auditLog.logEvent({
        actorType: 'user', actorId: userId, actorUsername: 'redaction-test',
        action: 'REDACTION_TEST', category: 'auth', status: 'success',
        details: { password: 'super-secret-value', keepThis: 'visible' },
      });

      const row = await pool.query(
        `SELECT details::text AS d FROM audit_logs WHERE actor_id = $1 AND action = 'REDACTION_TEST'
          ORDER BY id DESC LIMIT 1`,
        [userId]
      );
      expect(row.rows.length).toBe(1);
      expect(row.rows[0].d).not.toContain('super-secret-value');
      expect(row.rows[0].d).toContain('[REDACTED]');
      expect(row.rows[0].d).toContain('visible');
    });

    test('privileged action গুলোর audit event বিদ্যমান (regression)', () => {
      const adminSrc = read('routes', 'admin.js');
      const paymentSrc = read('routes', 'payment.js');
      const authSrc = read('routes', 'auth.js');

      for (const action of ['ADMIN_LOGIN_FAILED', 'ADMIN_LOGIN_DENIED', 'ADMIN_2FA_FAILED']) {
        expect(adminSrc).toContain(action);
      }
      expect(paymentSrc).toContain('PAYMENT_APPROVED');
      expect(paymentSrc).toContain('PAYMENT_REJECTED');
      expect(authSrc).toContain('PASSWORD_RESET_COMPLETED');
    });
  });

  describe('PHASE 15: backup and restore', () => {
    //     ;   isolated test DB- 
    test('backup তৈরি হয়, checksum রেকর্ড হয় এবং restore সত্যিই ডেটা ফেরায়', async () => {
      const marker = `restore-${uniqueUsername('bk')}`;
      await pool.query(
        `INSERT INTO users (username, phone, password, role) VALUES ($1,$2,'x','user')`,
        [marker, uniquePhone()]
      );

      const created = await backupManager.createDatabaseBackup({ source: 'manual' });
      expect(created.status).toBe('completed');
      expect(created.checksum).toBeTruthy();

      const list = await backupManager.listBackups({ type: 'database', limit: 1 });
      const rows = list.rows || list.items || list;
      const record = Array.isArray(rows) ? rows[0] : rows;
      expect(record).toBeTruthy();

      //     
      await pool.query('DELETE FROM users WHERE username = $1', [marker]);
      expect((await pool.query('SELECT 1 FROM users WHERE username = $1', [marker])).rowCount).toBe(0);

      //  restore  
      await backupManager.restoreBackup(record);
      expect((await pool.query('SELECT 1 FROM users WHERE username = $1', [marker])).rowCount).toBe(1);

      await pool.query('DELETE FROM users WHERE username = $1', [marker]);
    }, 120000);

    test('checksum ভাঙা backup restore করা যায় না', async () => {
      const created = await backupManager.createDatabaseBackup({ source: 'manual' });
      expect(created.status).toBe('completed');

      const list = await backupManager.listBackups({ type: 'database', limit: 1 });
      const rows = list.rows || list.items || list;
      const record = Array.isArray(rows) ? rows[0] : rows;

      const filePath = backupManager.getBackupFilePath(record);
      const buf = fs.readFileSync(filePath);
      buf[buf.length - 1] ^= 0xff; //  
      fs.writeFileSync(filePath, buf);

      await expect(backupManager.restoreBackup(record)).rejects.toThrow();
    }, 120000);

    test('backup encryption ও compression কনফিগারযোগ্য', () => {
      const src = read('services', 'backupManager.js');
      expect(src).toMatch(/aes-256-gcm/i);
      expect(src).toMatch(/gzipSync/);
      expect(typeof backupManager.isEncryptionEnabled).toBe('function');
    });
  });

  describe('PHASE 16: production configuration', () => {
    const appSrc = read('app.js');

    test('production-এ SESSION_SECRET বাধ্যতামূলক (fail-closed)', () => {
      const idx = appSrc.indexOf('SESSION_SECRET');
      const block = appSrc.slice(idx, idx + 900);
      expect(block).toMatch(/process\.exit\(1\)/);
    });

    test('session cookie httpOnly, production-এ secure, sameSite সেট', () => {
      expect(appSrc).toMatch(/httpOnly:\s*true/);
      expect(appSrc).toMatch(/secure:\s*isProd/);
      expect(appSrc).toMatch(/sameSite:\s*'lax'/);
    });

    test('trust proxy সেট এবং x-powered-by বন্ধ', () => {
      expect(appSrc).toMatch(/app\.set\('trust proxy', 1\)/);
      expect(appSrc).toMatch(/app\.disable\('x-powered-by'\)/);
    });

    test('production-এ HSTS চালু', () => {
      expect(appSrc).toMatch(/hsts:\s*isProdEnv\s*\?/);
      expect(appSrc).toMatch(/maxAge:\s*31536000/);
    });

    test('admin reset endpoint token, rate limit ও timing-safe compare দিয়ে সুরক্ষিত', () => {
      expect(appSrc).toMatch(/ADMIN_RESET_TOKEN/);
      expect(appSrc).toMatch(/timingSafeEqual/);
      expect(appSrc).toMatch(/resetAdminLimiter/);
      //   token       
      expect(appSrc).toMatch(/if \(process\.env\.ADMIN_RESET_TOKEN\)/);
    });

    test('CSP কনফিগার করা আছে এবং report endpoint কাজ করে', () => {
      expect(appSrc).toMatch(/contentSecurityPolicy/);
      expect(appSrc).toMatch(/reportUri/);
    });
  });
});
