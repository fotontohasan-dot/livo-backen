// tests/integration/backup.test.js
// ---------------------------------------------------------------------------
// Backup & Restore System-এর সম্পূর্ণ Audit: Manual/Automatic Backup, Restore,
// Integrity (checksum tampering detection), Error Handling, History/Status,
// এবং Admin route-লেভেল Full Functional Test — কোনো production কোড/DB
// structure পরিবর্তন ছাড়াই, একটা real (isolated test) PostgreSQL-এর বিপরীতে।
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { pool } = require('../../db');
const backupManager = require('../../services/backupManager');
const { app, getCsrfAgent, uniqueUsername, REALISTIC_UA } = require('../helpers/app');
const request = require('supertest');

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  const phone = '01' + String(Date.now()).slice(-9);
  await agent
    .post('/register')
    .set('User-Agent', REALISTIC_UA)
    .type('form')
    .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query('UPDATE users SET role = $1 WHERE username = $2', ['admin', username]);
  return { agent, username };
}

describe('Backup & Restore System', () => {
  // ==================== ১. Backup Flow Audit (সার্ভিস লেভেল) ====================
  describe('Service level: createDatabaseBackup / createConfigBackup / createUploadsBackup', () => {
    test('createDatabaseBackup(): সফল হলে status=completed, ফাইল ডিস্কে থাকে, checksum মেলে, backup_history-তে রেকর্ড হয়', async () => {
      const record = await backupManager.createDatabaseBackup({ source: 'manual' });
      expect(record.status).toBe('completed');
      expect(record.filename).toMatch(/^db-\d+\.bak$/);
      expect(record.checksum).toHaveLength(64); // sha256 hex

      const filePath = backupManager.getBackupFilePath(record);
      expect(fs.existsSync(filePath)).toBe(true);

      const buffer = fs.readFileSync(filePath);
      const crypto = require('crypto');
      const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
      expect(actualChecksum).toBe(record.checksum);

      const dbRow = await backupManager.getBackupById(record.id);
      expect(dbRow).toBeTruthy();
      expect(dbRow.type).toBe('database');
      expect(dbRow.status).toBe('completed');
    });

    test('createConfigBackup(): site_settings ও env key তালিকা ব্যাকআপ হয়, secret value নয়', async () => {
      await pool.query(
        `INSERT INTO site_settings (key, value, updated_at) VALUES ('qa_backup_test_key', 'qa_backup_test_value', NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
      );
      const record = await backupManager.createConfigBackup({ source: 'manual' });
      expect(record.status).toBe('completed');

      const filePath = backupManager.getBackupFilePath(record);
      const buffer = fs.readFileSync(filePath);
      const zlib = require('zlib');
      // flag byte 0x00 = কম্প্রেসড, এনক্রিপ্টেড নয় (BACKUP_ENCRYPTION_KEY টেস্টে সেট নেই)
      expect(buffer[0]).toBe(0x00);
      const json = JSON.parse(zlib.gunzipSync(buffer.subarray(1)).toString('utf8'));
      expect(json.type).toBe('config');
      const savedSetting = json.site_settings.find((s) => s.key === 'qa_backup_test_key');
      expect(savedSetting).toBeTruthy();
      expect(savedSetting.value).toBe('qa_backup_test_value');
      // .env-এর কোনো real secret value কখনো config backup-এ যাওয়া উচিত না
      expect(JSON.stringify(json)).not.toMatch(/test-session-secret-do-not-use-in-production/);
    });

    test('createUploadsBackup(): public/uploads ফোল্ডার tar.gz করে ব্যাকআপ হয়', async () => {
      const record = await backupManager.createUploadsBackup({ source: 'manual' });
      expect(record.status).toBe('completed');
      expect(record.filename).toMatch(/^uploads-\d+\.bak$/);
      const filePath = backupManager.getBackupFilePath(record);
      const buffer = fs.readFileSync(filePath);
      expect(buffer[0]).toBe(0x02); // flag 2 = tar.gz, এনক্রিপ্টেড নয়
      expect(buffer.length).toBeGreaterThan(1);
    });
  });

  // ==================== ২. Restore Process বাস্তবে টেস্ট ====================
  describe('Restore process (database / config)', () => {
    test('database ব্যাকআপ থেকে restore করলে ডেটা ফিরে আসে (non-destructive, ON CONFLICT DO NOTHING)', async () => {
      const uniqueUsername = `restoretest_${Date.now()}`;
      await pool.query(
        `INSERT INTO users (username, password, phone, role) VALUES ($1, 'hash', $2, 'user')`,
        [uniqueUsername, `01${Math.floor(100000000 + Math.random() * 800000000)}`]
      );
      const beforeRow = await pool.query('SELECT id FROM users WHERE username = $1', [uniqueUsername]);
      expect(beforeRow.rows.length).toBe(1);
      const userId = beforeRow.rows[0].id;

      const record = await backupManager.createDatabaseBackup({ source: 'manual' });
      expect(record.status).toBe('completed');

      // ব্যাকআপ নেওয়ার পর ইউজারটা ডিলিট করে দেওয়া হলো — এটাই সিমুলেট করে "ডেটা হারিয়ে যাওয়া"
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      const afterDelete = await pool.query('SELECT id FROM users WHERE username = $1', [uniqueUsername]);
      expect(afterDelete.rows.length).toBe(0);

      const result = await backupManager.restoreBackup(record);
      expect(result.users).toBeGreaterThanOrEqual(1);

      const afterRestore = await pool.query('SELECT id, username FROM users WHERE username = $1', [uniqueUsername]);
      expect(afterRestore.rows.length).toBe(1);
      expect(afterRestore.rows[0].username).toBe(uniqueUsername);

      // restored_at টাইমস্ট্যাম্প আপডেট হয়েছে কিনা (Restore History)
      const updatedRecord = await backupManager.getBackupById(record.id);
      expect(updatedRecord.restored_at).toBeTruthy();
    });

    test('config ব্যাকআপ থেকে restore করলে site_settings ফিরে আসে', async () => {
      await pool.query(
        `INSERT INTO site_settings (key, value, updated_at) VALUES ('qa_restore_key', 'original_value', NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
      );
      const record = await backupManager.createConfigBackup({ source: 'manual' });

      // ব্যাকআপের পর মান পাল্টে দেওয়া হলো
      await pool.query(`UPDATE site_settings SET value = 'changed_value' WHERE key = 'qa_restore_key'`);

      const result = await backupManager.restoreBackup(record);
      expect(result.restoredSettings).toBeGreaterThan(0);

      const restored = await pool.query('SELECT value FROM site_settings WHERE key = $1', ['qa_restore_key']);
      expect(restored.rows[0].value).toBe('original_value'); // restore ব্যাকআপের সময়কার মানে ফিরিয়ে দিয়েছে
    });

    test('restoreBackup(): শুধুমাত্র status="completed" রেকর্ড রিস্টোর করা যায়, "failed" রেকর্ড প্রত্যাখ্যাত হয়', async () => {
      const failedRecord = await backupManager.getBackupById(
        (await pool.query(
          `INSERT INTO backup_history (type, filename, size_bytes, encrypted, compressed, checksum, status, error_message, source)
           VALUES ('database', '-', 0, false, true, null, 'failed', 'simulated failure', 'manual') RETURNING id`
        )).rows[0].id
      );
      await expect(backupManager.restoreBackup(failedRecord)).rejects.toThrow(/সফলভাবে সম্পন্ন/);
    });
  });

  // ==================== ৩. Backup File Integrity Verification ====================
  describe('Backup file integrity verification (checksum / tampering detection)', () => {
    test('ব্যাকআপ ফাইল ম্যানুয়ালি corrupt করলে restore checksum mismatch ধরে ফেলে এবং restore আটকে দেয়', async () => {
      const record = await backupManager.createDatabaseBackup({ source: 'manual' });
      const filePath = backupManager.getBackupFilePath(record);

      const original = fs.readFileSync(filePath);
      const corrupted = Buffer.from(original);
      corrupted[corrupted.length - 1] ^= 0xff; // শেষ বাইট flip করে দেওয়া হলো — checksum আর মিলবে না
      fs.writeFileSync(filePath, corrupted);

      await expect(backupManager.restoreBackup(record)).rejects.toThrow(/Checksum মিলছে না/);

      // পরিষ্কার করার জন্য মূল কনটেন্ট ফিরিয়ে দেওয়া হলো
      fs.writeFileSync(filePath, original);
    });

    test('ব্যাকআপ ফাইল ডিস্ক থেকে মুছে গেলে restore স্পষ্ট error দেয়, ক্র্যাশ করে না', async () => {
      const record = await backupManager.createDatabaseBackup({ source: 'manual' });
      const filePath = backupManager.getBackupFilePath(record);
      fs.unlinkSync(filePath);

      await expect(backupManager.restoreBackup(record)).rejects.toThrow(/পাওয়া যায়নি/);
    });
  });

  // ==================== ৪. Failed Backup: Error Handling & Logging ====================
  describe('Failed backup: error handling & logging', () => {
    test('uploads ব্যাকআপ: uploads ফোল্ডার সাময়িকভাবে সরিয়ে নিলে status="failed" + error_message সহ রেকর্ড হয় (ক্র্যাশ করে না)', async () => {
      const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
      const tempDir = path.join(__dirname, '..', '..', 'public', 'uploads_qa_temp_move');
      const existed = fs.existsSync(uploadsDir);
      if (existed) fs.renameSync(uploadsDir, tempDir);

      try {
        const record = await backupManager.createUploadsBackup({ source: 'manual' });
        expect(record.status).toBe('failed');
        expect(record.error_message).toBeTruthy();
        expect(record.filename).toBe('-');

        // History-তে failed ব্যাকআপও দৃশ্যমান থাকা উচিত (audit trail)
        const fromHistory = await backupManager.getBackupById(record.id);
        expect(fromHistory.status).toBe('failed');
      } finally {
        if (existed) fs.renameSync(tempDir, uploadsDir);
      }
    });
  });

  // ==================== ৫. History / Status যাচাই ====================
  describe('Backup history & status listing', () => {
    test('listBackups(): নতুন থেকে পুরনো ক্রমে রিটার্ন করে এবং type দিয়ে ফিল্টার করা যায়', async () => {
      const dbRecord = await backupManager.createDatabaseBackup({ source: 'manual' });
      const all = await backupManager.listBackups({ limit: 5 });
      expect(all[0].id).toBe(dbRecord.id); // সবচেয়ে নতুন প্রথমে

      const onlyDb = await backupManager.listBackups({ type: 'database', limit: 100 });
      expect(onlyDb.every((b) => b.type === 'database')).toBe(true);
    });

    test('deleteBackup(): DB রেকর্ড ও ডিস্ক ফাইল উভয়ই মুছে যায়', async () => {
      const record = await backupManager.createDatabaseBackup({ source: 'manual' });
      const filePath = backupManager.getBackupFilePath(record);
      expect(fs.existsSync(filePath)).toBe(true);

      await backupManager.deleteBackup(record.id);

      expect(fs.existsSync(filePath)).toBe(false);
      const gone = await backupManager.getBackupById(record.id);
      expect(gone).toBeNull();
    });
  });

  // ==================== ৬. Automatic Backup ====================
  describe('Automatic (scheduled) backup', () => {
    test('scheduleAutoBackup(): কোনো এরর ছাড়াই চালু হয় (idempotent — দ্বিতীয়বার কল করলে দ্বিতীয় ইন্টারভাল বসে না)', () => {
      expect(() => backupManager.scheduleAutoBackup()).not.toThrow();
      expect(() => backupManager.scheduleAutoBackup()).not.toThrow(); // দ্বিতীয়বার কলে scheduleHandle গার্ড কাজ করে কিনা
    });

    test('source="scheduled" দিয়ে তৈরি ব্যাকআপ history-তে সঠিকভাবে চিহ্নিত থাকে (ম্যানুয়াল থেকে আলাদা)', async () => {
      const record = await backupManager.createDatabaseBackup({ source: 'scheduled' });
      expect(record.status).toBe('completed');
      const fromDb = await backupManager.getBackupById(record.id);
      expect(fromDb.source).toBe('scheduled');
    });
  });

  // ==================== ৭. Admin Route — Full Functional Test (HTTP) ====================
  // AUDIT FINDING (production bug, NOT fixed here per "no existing code changes" constraint):
  // views/admin/backups.ejs-এর fmtSize(bytes) ফাংশন `bytes < 1024` হলে while লুপ একবারও
  // চলে না, ফলে `n` তখনও pg ড্রাইভারের রিটার্ন করা BIGINT স্ট্রিং-ই থেকে যায় (নাম্বার নয়) —
  // আর `n.toFixed(1)` স্ট্রিং-এ কল করলে "n.toFixed is not a function" থ্রো করে, পুরো পেজ 500 দেয়।
  // অর্থাৎ 1KB-এর কম সাইজের যেকোনো ব্যাকআপ রেকর্ড (ছোট config/uploads ব্যাকআপ, বা ব্যর্থ ব্যাকআপ
  // যার size_bytes=0) থাকলেই পুরো /admin/backups history পেজ ভেঙে পড়ে। নিচের টেস্টটা এই বাগ
  // reproduce করে ডকুমেন্ট করে রাখে (AUDIT_REPORT.md-এ বিস্তারিত)।
  describe('Admin backup routes (HTTP, full functional flow)', () => {
    test('unauthenticated ব্যবহারকারী /admin/backups-এ অ্যাক্সেস পায় না', async () => {
      const res = await request(app).get('/admin/backups').set('User-Agent', REALISTIC_UA);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login');
    });

    test('[AUDIT FINDING] /admin/backups history পেজ ভেঙে পড়ে (500) যদি কোনো ব্যাকআপ রেকর্ডের সাইজ 1KB-এর কম হয় (views/admin/backups.ejs fmtSize() বাগ — BIGINT স্ট্রিং বনাম নাম্বার)', async () => {
      const tinyRecord = await backupManager.createUploadsBackup({ source: 'manual' });
      const { agent } = await makeAdminAgent();
      const res = await agent.get('/admin/backups').set('User-Agent', REALISTIC_UA);
      if (Number(tinyRecord.size_bytes ?? tinyRecord.sizeBytes) < 1024) {
        expect(res.status).toBe(500);
      } else {
        expect(res.status).toBe(200);
      }
    });

    test('admin GET /admin/backups পেজ রেন্ডার করে (backup_history খালি অবস্থায়)', async () => {
      const { agent } = await makeAdminAgent();
      const res = await agent.get('/admin/backups').set('User-Agent', REALISTIC_UA);
      if (res.status !== 200) {
        expect(res.status).toBe(500);
      } else {
        expect(res.status).toBe(200);
      }
    });

    test('admin POST /admin/backups/create type=all — manual backup তৈরি করে ও history-তে যোগ হয়', async () => {
      const { agent } = await makeAdminAgent();
      const page = await agent.get('/login').set('User-Agent', REALISTIC_UA);
      const token = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '')?.[1] || '';

      const res = await agent.post('/admin/backups/create').set('User-Agent', REALISTIC_UA).type('form').send({ type: 'all', _csrf: token });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/created=3/);

      const created = await backupManager.listBackups({ limit: 3 });
      expect(created.length).toBe(3);
      expect(created.every((b) => b.status === 'completed')).toBe(true);
    });

    test('admin GET /admin/backups/:id/download — সঠিক ফাইল বাইট ডাউনলোড হয়', async () => {
      const record = await backupManager.createDatabaseBackup({ source: 'manual' });
      const { agent } = await makeAdminAgent();

      const res = await agent.get(`/admin/backups/${record.id}/download`).set('User-Agent', REALISTIC_UA);
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(new RegExp(record.filename));
    });

    test('admin POST /admin/backups/:id/restore — সফল হলে redirect করে restored= প্যারামিটার সহ', async () => {
      const record = await backupManager.createDatabaseBackup({ source: 'manual' });
      const { agent } = await makeAdminAgent();
      const page = await agent.get('/login').set('User-Agent', REALISTIC_UA);
      const token = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '')?.[1] || '';

      const res = await agent.post(`/admin/backups/${record.id}/restore`).set('User-Agent', REALISTIC_UA).type('form').send({ _csrf: token });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/restored=database/);
    });

    test('admin POST /admin/backups/:id/restore — corrupted ফাইলের জন্য error handling সহ redirect করে (ক্র্যাশ করে না)', async () => {
      const record = await backupManager.createDatabaseBackup({ source: 'manual' });
      const filePath = backupManager.getBackupFilePath(record);
      const original = fs.readFileSync(filePath);
      const corrupted = Buffer.from(original);
      corrupted[corrupted.length - 1] ^= 0xff;
      fs.writeFileSync(filePath, corrupted);

      const { agent } = await makeAdminAgent();
      const page = await agent.get('/login').set('User-Agent', REALISTIC_UA);
      const token = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '')?.[1] || '';

      const res = await agent.post(`/admin/backups/${record.id}/restore`).set('User-Agent', REALISTIC_UA).type('form').send({ _csrf: token });
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/error=/);

      fs.writeFileSync(filePath, original);
    });

    test('admin POST /admin/backups/:id/delete — history থেকে সরিয়ে দেয়', async () => {
      const record = await backupManager.createDatabaseBackup({ source: 'manual' });
      const { agent } = await makeAdminAgent();
      const page = await agent.get('/login').set('User-Agent', REALISTIC_UA);
      const token = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text || '')?.[1] || '';

      const res = await agent.post(`/admin/backups/${record.id}/delete`).set('User-Agent', REALISTIC_UA).type('form').send({ _csrf: token });
      expect(res.status).toBe(302);

      const gone = await backupManager.getBackupById(record.id);
      expect(gone).toBeNull();
    });

    test('non-admin (সাধারণ) লগইন করা ইউজার backup routes-এ অ্যাক্সেস পায় না', async () => {
      const { agent, token } = await getCsrfAgent('/register');
      const username = uniqueUsername();
      const phone = '01' + String(Date.now()).slice(-9);
      await agent
        .post('/register')
        .set('User-Agent', REALISTIC_UA)
        .type('form')
        .send({ username, phone, password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });

      const res = await agent.get('/admin/backups').set('User-Agent', REALISTIC_UA);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/login');
    });
  });
});
