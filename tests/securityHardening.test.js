const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// এই টেস্টগুলো DB ছাড়াই চলে — উদ্দেশ্য প্রতিটা ফিক্সের রিগ্রেশন গার্ড।
// যেসব আচরণ যাচাই করতে সত্যিকারের PostgreSQL লাগে, সেগুলো এখানে নেই;
// সেগুলো CI-র DB-নির্ভর সুইটে চলে।

describe('#1 ব্যাকআপ আর GitHub-এ যায় না', () => {
  const backup = read('services', 'backup.js');

  test('services/backup.js-এ GitHub API কল নেই', () => {
    expect(backup).not.toMatch(/api\.github\.com/);
    expect(backup).not.toMatch(/GITHUB_TOKEN/);
  });

  test('ডাটাবেস ডাম্প তৈরির কোড সরানো হয়েছে', () => {
    expect(backup).not.toMatch(/information_schema\.tables/);
    expect(backup).not.toMatch(/SELECT \* FROM/);
  });

  test('runBackupNow fail-closed — নিঃশব্দে সফল দেখায় না', async () => {
    const { runBackupNow, getBackupStatus } = require('../services/backup');
    const result = await runBackupNow();
    expect(result.ok).toBe(false);
    expect(result.deprecated).toBe(true);
    expect(getBackupStatus().configured).toBe(false);
  });

  test('GitHub থেকে রিস্টোর করার পথও বন্ধ', async () => {
    const { restoreFromBackup, fetchLatestBackup } = require('../services/backup');
    await expect(restoreFromBackup()).rejects.toThrow();
    await expect(fetchLatestBackup()).rejects.toThrow();
  });

  test('.gitignore ডাম্প আর্টিফ্যাক্ট আটকায়', () => {
    const ignore = read('.gitignore');
    expect(ignore).toMatch(/db-backups/);
    expect(ignore).toMatch(/\*\.dump/);
  });

  test('টাইমার গার্ড ও unref আগের মতোই আছে', () => {
    expect(backup).toMatch(/if \(dailyBackupHandle\) return/);
    expect(backup).toMatch(/\.unref\(\)/);
  });
});

describe('#27 প্রোডাকশনে ব্যাকআপ এনক্রিপশন বাধ্যতামূলক', () => {
  const manager = read('services', 'backupManager.js');

  test('কী ছাড়া প্রোডাকশন ব্যাকআপ throw করে', () => {
    expect(manager).toMatch(/BACKUP_ENCRYPTION_KEY সেট করা নেই/);
    expect(manager).toMatch(/if \(isProduction\(\)\)/);
  });

  test('খুব ছোট কী প্রোডাকশনে গ্রহণ করা হয় না', () => {
    expect(manager).toMatch(/MIN_KEY_LENGTH/);
  });
});

describe('#2 Host হেডার থেকে লিংক বানানো হয় না', () => {
  test('reset/verify লিংকে req.get(host) নেই', () => {
    for (const file of ['auth.js', 'profile.js', 'payment.js']) {
      expect(read('routes', file)).not.toMatch(/req\.get\('host'\)/);
    }
  });

  test('publicUrl প্রোডাকশনে কনফিগ ছাড়া চলে না', () => {
    jest.resetModules();
    const prevEnv = process.env.NODE_ENV;
    const prevPublic = process.env.PUBLIC_APP_URL;
    const prevBase = process.env.BASE_URL;
    process.env.NODE_ENV = 'production';
    delete process.env.PUBLIC_APP_URL;
    delete process.env.BASE_URL;
    try {
      const publicUrl = require('../utils/publicUrl');
      expect(() => publicUrl.getBaseUrl(null)).toThrow(/PUBLIC_APP_URL/);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevPublic !== undefined) process.env.PUBLIC_APP_URL = prevPublic;
      if (prevBase !== undefined) process.env.BASE_URL = prevBase;
      jest.resetModules();
    }
  });

  test('কনফিগার করা URL ব্যবহার হয়, Host উপেক্ষা করা হয়', () => {
    jest.resetModules();
    const prev = process.env.PUBLIC_APP_URL;
    process.env.PUBLIC_APP_URL = 'https://livo.example/';
    try {
      const publicUrl = require('../utils/publicUrl');
      const fakeReq = { protocol: 'http', get: () => 'attacker.example' };
      expect(publicUrl.buildUrl(fakeReq, '/reset-password/abc'))
        .toBe('https://livo.example/reset-password/abc');
      expect(publicUrl.getBaseUrl(fakeReq)).not.toMatch(/attacker/);
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = prev;
      jest.resetModules();
    }
  });

  test('প্রোডাকশনে http URL গ্রহণ করা হয় না', () => {
    jest.resetModules();
    const prevEnv = process.env.NODE_ENV;
    const prevUrl = process.env.PUBLIC_APP_URL;
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_APP_URL = 'http://livo.example';
    try {
      const publicUrl = require('../utils/publicUrl');
      expect(() => publicUrl.getBaseUrl(null)).toThrow(/https/);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevUrl === undefined) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = prevUrl;
      jest.resetModules();
    }
  });
});

describe('#4 প্রমাণীকরণ fail-closed', () => {
  const auth = read('middleware', 'auth.js');

  test('DB ব্যর্থ হলে exists:true ফেরত দেওয়া হয় না', () => {
    expect(auth).not.toMatch(/return \{ exists: true, banned: false, selfExcluded: false, checkFailed: true \}/);
    expect(auth).toMatch(/return \{ exists: false, banned: false, selfExcluded: false, checkFailed: true \}/);
  });

  test('checkFailed হলে 503, সেশন ধ্বংস নয়', () => {
    expect(auth).toMatch(/if \(status\.checkFailed\)/);
    expect(auth).toMatch(/503/);
  });

  test('বার্তাটি দুই ভাষাতেই আছে', () => {
    expect(JSON.parse(read('locales', 'bn.json')).auth_status_unavailable).toBeTruthy();
    expect(JSON.parse(read('locales', 'en.json')).auth_status_unavailable).toBeTruthy();
  });
});

describe('#5 প্রোডাকশনে DB TLS যাচাই', () => {
  const db = read('db.js');

  test('প্রোডাকশনে rejectUnauthorized true', () => {
    expect(db).toMatch(/rejectUnauthorized: true/);
  });

  test('অনিরাপদ মোড স্পষ্ট অপ্ট-ইন ও সতর্কবার্তাসহ', () => {
    expect(db).toMatch(/DATABASE_SSL_INSECURE/);
    expect(db).toMatch(/console\.warn/);
  });

  test('CA সার্টিফিকেট দেওয়ার পথ আছে', () => {
    expect(db).toMatch(/DATABASE_CA_CERT/);
  });
});

describe('#32 maintenance mode রিস্টার্টে রিসেট হয় না', () => {
  test('maintenance_mode জোর করে false করা হয় না', () => {
    // কমেন্টে পুরনো প্যাটার্নটা উদ্ধৃত আছে (কেন সরানো হলো তার ব্যাখ্যা),
    // তাই যাচাইয়ের আগে কমেন্ট লাইন বাদ।
    const migrations = read('migrations.js')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(migrations).not.toMatch(/maintenance_mode[\s\S]{0,200}DO UPDATE SET value = 'false'/);
    expect(migrations).toMatch(/maintenance_mode[\s\S]{0,400}DO NOTHING/);
  });
});

describe('#43 service worker ব্যক্তিগত পেইজ ক্যাশ করে না', () => {
  const sw = read('public', 'service-worker.js');

  test('ব্যক্তিগত রুটগুলো বাদ যায়', () => {
    for (const route of ['/profile', '/wallet', '/payment', '/kyc', '/history']) {
      expect(sw).toContain(`'${route}'`);
    }
  });

  test('no-store/private রেসপন্স ক্যাশ হয় না', () => {
    expect(sw).toMatch(/no-store/);
    expect(sw).toMatch(/private/);
  });

  test('ক্রস-অরিজিন রিকোয়েস্ট ক্যাশে ঢোকে না', () => {
    expect(sw).toMatch(/url\.origin !== self\.location\.origin/);
  });
});

describe('#44 CSRF টোকেন শুধু same-origin', () => {
  // কোডটা এখন public/js/csrf-inject.js-এ — আগে ১০টা টেমপ্লেটে কপি করা ছিল
  // এবং কপিগুলো এক ছিল না: শুধু head.ejs-এ এই same-origin যাচাইটা ছিল।
  const injector = read('public', 'js', 'csrf-inject.js');

  test('অরিজিন যাচাই আছে', () => {
    expect(injector).toMatch(/function isSameOrigin/);
    expect(injector).toMatch(/isSameOrigin\(url\)/);
  });

  test('XHR-এও একই যাচাই', () => {
    expect(injector).toMatch(/_csrfSameOrigin/);
  });

  test('পার্স করা না গেলে টোকেন পাঠানো হয় না (fail-closed)', () => {
    expect(injector).toMatch(/return false;/);
  });

  test('সব পেজ একই সংস্করণ পায় — টেমপ্লেটে কোনো কপি নেই', () => {
    const fs2 = require('fs');
    const path2 = require('path');
    const root = path2.join(__dirname, '..');
    const walk = (dir, out = []) => {
      for (const e of fs2.readdirSync(dir, { withFileTypes: true })) {
        const full = path2.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith('.ejs')) out.push(full);
      }
      return out;
    };
    const copies = walk(path2.join(root, 'views'))
      .filter((f) => /injectIntoForms/.test(fs2.readFileSync(f, 'utf8')));
    expect(copies).toEqual([]);
  });
});

describe('#8 লেজার ইনভেরিয়েন্ট — বাজি দুবার বিয়োগ হয় না', () => {
  const games = read('routes', 'games.js');
  const code = games.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  test('game_play-তে netChange লেখা হয় না', () => {
    expect(code).not.toMatch(/\[userId, netChange, 'game_play'/);
  });

  test('casino_bet ডেবিট + game_play ক্রেডিট মডেল', () => {
    expect(code).toMatch(/\[userId, -betAmount, 'casino_bet'/);
    expect(code).toMatch(/\[userId, winAmount, 'game_play'/);
    expect(code).toMatch(/if \(winAmount > 0\)/);
  });

  test('ব্যাজের বাজি-গণনা হেরে যাওয়া বাজিও ধরে', () => {
    expect(read('services', 'badges.js')).toMatch(/'bet','casino_bet'/);
  });
});

describe('#34 fraud scan সততা', () => {
  test('বাস্তবায়ন না থাকা জব ডিফল্টে চালু নয়', () => {
    const scheduler = read('services', 'scheduler.js');
    const idx = scheduler.indexOf('fraud_scan: {');
    expect(idx).toBeGreaterThan(-1);
    const block = scheduler.slice(idx, idx + 1200);
    expect(block).toMatch(/defaultEnabled: false/);
  });
});

describe('#55 SMS সিমুলেশন সফলতা বলে চালিয়ে দেয় না', () => {
  test('গেটওয়ে কনফিগার না থাকলে ok:false', async () => {
    const prevUrl = process.env.SMS_API_URL;
    const prevKey = process.env.SMS_API_KEY;
    delete process.env.SMS_API_URL;
    delete process.env.SMS_API_KEY;
    jest.resetModules();
    try {
      const { sendSms } = require('../services/sms');
      const result = await sendSms('01700000000', 'test');
      expect(result.ok).toBe(false);
      expect(result.code).toBe('SMS_NOT_CONFIGURED');
    } finally {
      if (prevUrl !== undefined) process.env.SMS_API_URL = prevUrl;
      if (prevKey !== undefined) process.env.SMS_API_KEY = prevKey;
      jest.resetModules();
    }
  });
});

describe('#14 transaction ID পুনঃব্যবহার', () => {
  test('অন্য ইউজারের TrxID status নির্বিশেষে ব্লক', () => {
    const payment = read('routes', 'payment.js');
    expect(payment).toMatch(/user_id <> \$3 OR status <> 'rejected'/);
  });
});
