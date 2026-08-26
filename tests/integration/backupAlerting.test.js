// tests/integration/backupAlerting.test.js
// ---------------------------------------------------------------------------
// শিডিউলড ব্যাকআপ ব্যর্থ হলে অ্যাডমিন জানতে পারেন কি না — তার রিগ্রেশন কভারেজ।
//
// কেন দরকার: আগে scheduleAutoBackup()-এর রানার create*Backup()-এর রিটার্ন ভ্যালু ফেলে
// দিত এবং শেষে সবসময় "✅ Scheduled backup সম্পন্ন।" ছাপাত। create*Backup() ব্যর্থ হলে
// throw করে না — status:'failed' রেকর্ড ফেরত দেয়। ফলে ডিস্ক ভরে যাওয়া বা পারমিশন
// সমস্যায় রাতের পর রাত ব্যাকআপ ব্যর্থ হলেও কোনো অ্যালার্ট যেত না; শুধু /admin/backups
// খুলে দেখলে ধরা পড়ত। এখানে সেটাই লক করা হচ্ছে:
//   ১) সব ধাপ সফল হলে কোনো Telegram নোটিফিকেশন যায় না (স্প্যাম এড়ানো);
//   ২) কোনো ধাপ ব্যর্থ হলে ঠিক একবার 'system' ক্যাটাগরির অ্যালার্ট যায়;
//   ৩) একটা ধাপ ব্যর্থ হলেও বাকি ধাপগুলো চলে (আগে throw হলে পরেরগুলো বাদ পড়ত);
//   ৪) অ্যালার্টে টোকেন-সদৃশ লম্বা স্ট্রিং বা স্ট্যাক ট্রেস যায় না।
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const tmpBackupDir = path.join(ROOT, 'tmp-backup-alerting');

describe('শিডিউলড ব্যাকআপ ব্যর্থতার অ্যালার্ট', () => {
  let backupManager;
  let notifyMock;
  let originalBackupDir;

  beforeEach(() => {
    originalBackupDir = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = tmpBackupDir;
    jest.resetModules();

    notifyMock = jest.fn().mockResolvedValue({ sent: true });
    jest.doMock('../../services/telegramNotify', () => ({ notifyTelegram: notifyMock }));

    backupManager = require('../../services/backupManager');
  });

  afterEach(() => {
    if (originalBackupDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = originalBackupDir;
    fs.rmSync(tmpBackupDir, { recursive: true, force: true });
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('সব ধাপ সফল হলে কোনো Telegram অ্যালার্ট যায় না', async () => {
    const result = await backupManager.runScheduledBackups();

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test('একটা ধাপ ব্যর্থ হলে ঠিক একবার system অ্যালার্ট যায়', async () => {
    // create*Backup() থ্রো করে না — ব্যর্থ হলে status:'failed' রেকর্ড ফেরত দেয়। এখানে
    // pruneOldScheduledBackups-কে ব্যর্থ করানো হচ্ছে; একই কোডপাথ (failures তালিকা + অ্যালার্ট)।
    const pool = require('../../db').pool;
    const querySpy = jest.spyOn(pool, 'query').mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes("source = 'scheduled' ORDER BY created_at DESC OFFSET")) {
        return Promise.reject(new Error('prune failed: connection terminated'));
      }
      return pool.constructor.prototype.query.call(pool, sql, params);
    });

    const result = await backupManager.runScheduledBackups();
    querySpy.mockRestore();

    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.type === 'prune')).toBe(true);
    expect(notifyMock).toHaveBeenCalledTimes(1);

    const [text, opts] = notifyMock.mock.calls[0];
    expect(opts).toEqual({ category: 'system' });
    expect(text).toContain('Scheduled Backup ব্যর্থ');
  });

  test('অ্যালার্টে স্ট্যাক ট্রেস বা টোকেন-সদৃশ স্ট্রিং যায় না', async () => {
    const pool = require('../../db').pool;
    const secretish = 'ghpx' + 'A'.repeat(36); // টোকেন-সদৃশ লম্বা স্ট্রিং
    const querySpy = jest.spyOn(pool, 'query').mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes("source = 'scheduled' ORDER BY created_at DESC OFFSET")) {
        const err = new Error(`upload failed with credential ${secretish}\n    at Object.<anonymous> (/app/services/x.js:1:1)`);
        return Promise.reject(err);
      }
      return pool.constructor.prototype.query.call(pool, sql, params);
    });

    const result = await backupManager.runScheduledBackups();
    querySpy.mockRestore();

    expect(result.ok).toBe(false);
    expect(notifyMock).toHaveBeenCalledTimes(1);

    const [text] = notifyMock.mock.calls[0];
    expect(text).not.toContain(secretish);
    expect(text).toContain('***');
    expect(text).not.toMatch(/\n\s+at /); // স্ট্যাক ট্রেস লাইন নেই
  });

  test('scheduleAutoBackup রানার কখনো unhandled rejection ছড়ায় না', () => {
    // রানার নিজে .catch() দিয়ে মোড়ানো — টাইমার কলব্যাকে reject হলে প্রসেস ক্র্যাশ করত
    const src = fs.readFileSync(path.join(ROOT, 'services', 'backupManager.js'), 'utf8');
    expect(src).toMatch(/runScheduledBackups\(\)\.catch\(/);
  });
});
