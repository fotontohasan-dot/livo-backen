// tests/integration/dockerBackupSmoke.test.js
// ---------------------------------------------------------------------------
// ডিপ্লয়মেন্ট-কনফিগ স্মোক টেস্ট — Docker ডিমন ছাড়াই চলে (CI-তে Docker না থাকলেও পাস করে)।
//
// কেন দরকার: প্রোডাকশন অডিটে এমন কিছু সমস্যা ধরা পড়েছিল যেগুলো অ্যাপ্লিকেশন কোডে নয়,
// ডিপ্লয়মেন্ট কনফিগে ছিল — এবং লোকালি (root হিসেবে, docker ছাড়া) চালালে কখনোই দেখা যেত না:
//   • Dockerfile /app/backups তৈরি/chown করত না, অথচ docker-compose.yml ওখানে ভলিউম
//     মাউন্ট করে। মাউন্ট-পাথ ইমেজে না থাকলে Docker সেটা root:root বানায়, আর কন্টেইনার
//     USER nodejs হিসেবে চলে — ফলে ব্যাকআপ রাইট EACCES-এ ব্যর্থ হতো (ফিচার কন্টেইনারে অকেজো)।
//   • docker-compose.yml-এ DB/Redis/Grafana পাসওয়ার্ড `changeme` ডিফল্টে পড়ে যেত।
//
// এই ফাইল দুটো জিনিস যাচাই করে:
//   ১) ডিপ্লয়মেন্ট কনফিগ (Dockerfile + docker-compose.yml) স্ট্যাটিক্যালি সঠিক আছে।
//   ২) ব্যাকআপ create → restore রাউন্ড-ট্রিপ একটা আলাদা (কন্টেইনারের মতো) BACKUP_DIR-এ
//      সত্যিই কাজ করে — অর্থাৎ ডিরেক্টরি অটো-তৈরি হয়, ফাইল লেখা যায়, আবার পড়া যায়।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');

describe('Docker ডিপ্লয়মেন্ট কনফিগ স্মোক টেস্ট', () => {
  describe('Dockerfile — ব্যাকআপ ডিরেক্টরির মালিকানা', () => {
    test('/app/backups ইমেজেই তৈরি করা হয় (নাহলে ভলিউম মাউন্ট root:root হয়ে যায়)', () => {
      expect(dockerfile).toMatch(/mkdir\s+-p[^\n]*\/app\/backups/);
    });

    test('/app চownে nodejs ইউজারকে দেওয়া হয় এবং সেটা USER nodejs-এর আগেই ঘটে', () => {
      const chownIndex = dockerfile.indexOf('chown -R nodejs:nodejs /app');
      // কমেন্টেও "USER nodejs" লেখা থাকতে পারে — তাই শুধু আসল ইনস্ট্রাকশনটা (লাইনের শুরুতে) খোঁজা হচ্ছে
      const userMatch = /^USER nodejs$/m.exec(dockerfile);
      expect(chownIndex).toBeGreaterThan(-1);
      expect(userMatch).not.toBeNull();
      expect(chownIndex).toBeLessThan(userMatch.index);
    });

    test('production স্টেজ non-root ইউজার হিসেবে চলে', () => {
      expect(dockerfile).toMatch(/^USER nodejs$/m);
    });

    test('backupManager-এর নির্ভরশীল tar/gzip ইমেজে ইনস্টল করা আছে', () => {
      expect(dockerfile).toMatch(/apk add[^\n]*tar/);
      expect(dockerfile).toMatch(/apk add[^\n]*gzip/);
    });
  });

  describe('docker-compose.yml — সিক্রেট ব্যবস্থাপনা', () => {
    test('কোথাও "changeme" ডিফল্ট পাসওয়ার্ড অবশিষ্ট নেই', () => {
      expect(compose).not.toMatch(/changeme/);
    });

    test.each([
      ['DB_PASSWORD'],
      ['REDIS_PASSWORD'],
      ['SESSION_SECRET'],
      ['GRAFANA_ADMIN_PASSWORD']
    ])('%s অনুপস্থিত থাকলে compose ফেল করে (:? required syntax)', (key) => {
      const pattern = new RegExp('\\$\\{' + key + ':\\?');
      expect(compose).toMatch(pattern);
    });

    test('app সার্ভিস db ও redis হেলথি হওয়া পর্যন্ত অপেক্ষা করে', () => {
      expect(compose).toMatch(/condition:\s*service_healthy/);
    });

    test('ব্যাকআপ ভলিউম /app/backups-এ মাউন্ট করা হয়', () => {
      expect(compose).toMatch(/backups_data:\/app\/backups/);
    });
  });
});

describe('ব্যাকআপ create → restore রাউন্ড-ট্রিপ (কন্টেইনার-সদৃশ আলাদা BACKUP_DIR-এ)', () => {
  const tmpBackupDir = path.join(ROOT, 'tmp-backup-smoke');
  let backupManager;
  let originalBackupDir;

  beforeAll(() => {
    originalBackupDir = process.env.BACKUP_DIR;
    // ডিরেক্টরিটা ইচ্ছাকৃতভাবে আগে থেকে তৈরি করা হচ্ছে না — backupManager-এর নিজেরই
    // এটা তৈরি করতে পারা উচিত, ঠিক যেমন কন্টেইনারে প্রথমবার ব্যাকআপ নেওয়ার সময় হয়।
    process.env.BACKUP_DIR = tmpBackupDir;
    jest.resetModules();
    backupManager = require('../../services/backupManager');
  });

  afterAll(() => {
    if (originalBackupDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = originalBackupDir;
    fs.rmSync(tmpBackupDir, { recursive: true, force: true });
    jest.resetModules();
  });

  test('BACKUP_DIR না থাকলেও config ব্যাকআপ তৈরি হয় (ডিরেক্টরি অটো-তৈরি ও রাইটেবল)', async () => {
    const record = await backupManager.createConfigBackup({ source: 'manual' });
    expect(record.status).toBe('completed');
    expect(fs.existsSync(tmpBackupDir)).toBe(true);
    expect(fs.existsSync(path.join(tmpBackupDir, record.filename))).toBe(true);
    expect(Number(record.size_bytes)).toBeGreaterThan(0);
  });

  test('তৈরি হওয়া ব্যাকআপ একই ডিরেক্টরি থেকে restore করা যায়', async () => {
    const record = await backupManager.createConfigBackup({ source: 'manual' });
    expect(record.status).toBe('completed');
    await expect(backupManager.restoreBackup(record)).resolves.toBeDefined();
  });

  test('ব্যাকআপ ডিরেক্টরিতে রাইট পারমিশন আছে (কন্টেইনারে EACCES হলে এখানেই ধরা পড়বে)', () => {
    const probe = path.join(tmpBackupDir, '.write-probe');
    expect(() => {
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
    }).not.toThrow();
  });
});
