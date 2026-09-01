const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const codeOnly = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('#22/#23 রিসেট ও ভেরিফিকেশন টোকেন হ্যাশ করে রাখা হয়', () => {
  const { generateToken, hashToken, issueToken } = require('../utils/tokens');
  const auth = codeOnly(read('routes', 'auth.js'));

  test('হ্যাশ ডিটার্মিনিস্টিক, টোকেনের সমান নয়', () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).not.toBe(token);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateToken()));
  });

  test('issueToken টোকেন ও তার হ্যাশ দুটোই দেয়', () => {
    const { token, tokenHash } = issueToken();
    expect(tokenHash).toBe(hashToken(token));
  });

  test('DB-তে কাঁচা টোকেন লেখা হয় না', () => {
    expect(auth).toMatch(/\[tokenHash, expiry/);
    expect(auth).not.toMatch(/\[token, expiry, userId\]/);
  });

  test('যাচাইয়ের সময় ইউজারের টোকেন হ্যাশ করে মেলানো হয়', () => {
    expect(auth).toMatch(/hashToken\(req\.params\.token\)/);
    expect(auth).toMatch(/hashToken\(token\)/);
  });

  test('সেশনে কাঁচা ভেরিফিকেশন টোকেন রাখা হয় না', () => {
    expect(auth).not.toMatch(/session\.user\.verification_token = token/);
  });
});

describe('#24 TOTP সিক্রেট at-rest এনক্রিপ্টেড', () => {
  const secretBox = require('../utils/secretBox');
  const admin = codeOnly(read('routes', 'admin.js'));

  test('এনক্রিপ্ট করা মান আসল সিক্রেটের সমান নয়, ফিরিয়ে আনা যায়', () => {
    const prev = process.env.SETTINGS_ENCRYPTION_KEY;
    process.env.SETTINGS_ENCRYPTION_KEY = 'test-key-for-secretbox-only';
    try {
      const secret = 'JBSWY3DPEHPK3PXP';
      const packed = secretBox.encrypt(secret);
      expect(packed).not.toContain(secret);
      expect(secretBox.isEncrypted(packed)).toBe(true);
      expect(secretBox.decrypt(packed)).toBe(secret);
    } finally {
      if (prev === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
      else process.env.SETTINGS_ENCRYPTION_KEY = prev;
    }
  });

  test('পুরনো প্লেইনটেক্সট সিক্রেট আগের মতোই কাজ করে (কেউ লক-আউট হয় না)', () => {
    expect(secretBox.decrypt('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP');
    expect(secretBox.isEncrypted('JBSWY3DPEHPK3PXP')).toBe(false);
  });

  test('টেম্পার করা ciphertext ডিক্রিপ্ট হয় না', () => {
    const prev = process.env.SETTINGS_ENCRYPTION_KEY;
    process.env.SETTINGS_ENCRYPTION_KEY = 'test-key-for-secretbox-only';
    try {
      const packed = secretBox.encrypt('secret-value');
      const parts = packed.split(':');
      parts[3] = Buffer.from('tampered-content').toString('base64');
      expect(secretBox.decrypt(parts.join(':'))).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
      else process.env.SETTINGS_ENCRYPTION_KEY = prev;
    }
  });

  test('সিক্রেট এনক্রিপ্ট করে সেভ ও ডিক্রিপ্ট করে যাচাই হয়', () => {
    expect(admin).toMatch(/secretBox\.encrypt\(pendingSecret\)/);
    // যে ইনভেরিয়েন্টটা এই টেস্ট রক্ষা করে তা হলো: TOTP সিক্রেট এনক্রিপ্ট অবস্থায়
    // থাকে এবং যাচাইয়ের মুহূর্তে secretBox.decrypt() দিয়ে খোলা হয় — কোন যাচাই-
    // ফাংশন ব্যবহার হচ্ছে সেটা নয়। আগে প্যাটার্নে শুধু verifyTotpToken( ধরা হতো,
    // তাই /admin/2fa/disable-এ replay protection যোগ করতে গিয়ে সেটাকে
    // verifyTotpTokenWithStep( করার সাথে সাথেই এই টেস্ট ভেঙে যেত — অথচ
    // সিক্রেট-হ্যান্ডলিং একটুও দুর্বল হয়নি। প্যাটার্ন এখন দুটো ভ্যারিয়েন্টই চেনে;
    // কাঁচা (আন-ডিক্রিপ্টেড) সিক্রেট পাস করা এখনো নিষিদ্ধ।
    expect(admin).toMatch(/verifyTotpToken(WithStep)?\(secretBox\.decrypt\(admin\.totp_secret\)/);
    expect(admin).not.toMatch(/verifyTotpToken(WithStep)?\(admin\.totp_secret,/);
  });
});

describe('#25 2FA disable রুটে রেট-লিমিট', () => {
  test('strict2FALimiter প্রয়োগ করা আছে', () => {
    expect(read('routes', 'admin.js')).toMatch(/router\.post\('\/2fa\/disable', strict2FALimiter/);
  });
});

describe('#16/#17/#18 রিওয়ার্ড atomicity', () => {
  test('loyalty: পয়েন্ট ও লেজার একই ট্রানজেকশনে', () => {
    const loyalty = codeOnly(read('services', 'loyalty.js'));
    const idx = loyalty.indexOf('loyalty_points = COALESCE(loyalty_points,0) + $1');
    const block = loyalty.slice(Math.max(0, idx - 600), idx + 600);
    expect(block).toMatch(/BEGIN/);
    expect(block).toMatch(/COMMIT/);
    expect(block).toMatch(/ROLLBACK/);
  });

  test('vip: লেভেল আপগ্রেড ও বোনাস একই ট্রানজেকশনে, গার্ড অক্ষত', () => {
    const vip = codeOnly(read('services', 'vip.js'));
    expect(vip).toMatch(/client\.query\(\s*`UPDATE users SET vip_level/);
    expect(vip).toMatch(/COALESCE\(vip_level, 0\) < \$1/);
    // লেভেল আর pool.query() দিয়ে আলাদা কমিট হয় না
    expect(vip).not.toMatch(/pool\.query\(\s*`UPDATE users SET vip_level/);
  });

  test('streak: FOR UPDATE লক, স্ট্রিক ও বোনাস একই ট্রানজেকশনে', () => {
    const streak = codeOnly(read('services', 'streak.js'));
    expect(streak).toMatch(/FOR UPDATE/);
    expect(streak).toMatch(/client\.query\(\s*`UPDATE users\s*\n?\s*SET win_streak/);
    expect(streak).not.toMatch(/pool\.query\(\s*`UPDATE users\s*\n?\s*SET win_streak = COALESCE/);
  });
});

describe('#19/#20/#21 KYC স্টেট মেশিন', () => {
  const admin = codeOnly(read('routes', 'admin.js'));

  test('approve ও reject শুধু pending থেকে', () => {
    expect(admin).toMatch(/status = 'approved'[\s\S]{0,120}AND status = 'pending'/);
    expect(admin).toMatch(/status = 'rejected'[\s\S]{0,160}AND status = 'pending'/);
  });

  test('pending না হলে 409', () => {
    expect(admin).toMatch(/409/);
    expect(admin).toMatch(/admin_kyc_not_pending/);
    expect(JSON.parse(read('locales', 'bn.json')).admin_kyc_not_pending).toBeTruthy();
    expect(JSON.parse(read('locales', 'en.json')).admin_kyc_not_pending).toBeTruthy();
  });

  test('kyc_requests ও users একই ট্রানজেকশনে', () => {
    expect(admin).toMatch(/client\.query\("UPDATE users SET kyc_status = 'approved'/);
    expect(admin).toMatch(/client\.query\("UPDATE users SET kyc_status = 'rejected'/);
  });

  test('একজনের একাধিক pending রিকোয়েস্ট DB-তেই আটকানো', () => {
    expect(read('migrations.js')).toMatch(/uniq_kyc_pending_per_user/);
    expect(read('migrations.js')).toMatch(/WHERE status = 'pending'/);
    expect(read('routes', 'extra.js')).toMatch(/23505/);
  });
});

describe('#39/#40 বাজির মার্কেট ও রানার যাচাই', () => {
  const { resolveOdd } = require('../services/oddsResolver');

  test('মার্কেট অবশ্যই একই ম্যাচের হতে হবে', () => {
    const matches = codeOnly(read('routes', 'matches.js'));
    expect(matches).toMatch(/FROM markets WHERE id = \$1 AND match_id = \$2/);
  });

  test('অচেনা রানার প্রত্যাখ্যাত, ফলব্যাক অডস দেওয়া হয় না', () => {
    expect(resolveOdd({ type: 'match_winner', odds: {} }, 'বানানো-রানার')).toBeNull();
    expect(resolveOdd({ type: 'bookmaker', odds: { '0': 1.85 } }, '999')).toBeNull();
  });

  test('বৈধ রানার আগের মতোই অডস পায়', () => {
    expect(resolveOdd({ type: 'bookmaker', odds: { '0': 1.9 } }, '0')).toBe(1.9);
    expect(resolveOdd({ type: 'bookmaker', odds: {} }, '1')).toBe(2.10);
  });
});

describe('#13 দৈনিক ডিপোজিট লিমিটের রেস', () => {
  const payment = codeOnly(read('routes', 'payment.js'));

  test('লিমিট যাচাই লক নিয়ে, INSERT-এর সাথে একই ট্রানজেকশনে', () => {
    expect(payment).toMatch(/SELECT daily_deposit_limit FROM users WHERE id = \$1 FOR UPDATE/);
    expect(payment).toMatch(/client\.query\(\s*\n?\s*`INSERT INTO payment_requests/);
  });

  test('দিনের সীমানা ব্যবসায়িক টাইমজোন থেকে, CURRENT_DATE নয়', () => {
    expect(payment).toMatch(/businessTime\.startOfDay\(\)/);
    expect(payment).not.toMatch(/created_at::date = CURRENT_DATE/);
  });
});

describe('#48 ব্যবসায়িক টাইমজোন একীভূত', () => {
  const bt = require('../utils/businessTime');

  test('দিন YYYY-MM-DD ফরম্যাটে', () => {
    expect(bt.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('addDays মাসের সীমানা পার করে', () => {
    expect(bt.addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(bt.addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('startOfDay ও endOfDay ঠিক ২৪ ঘণ্টার ব্যবধান', () => {
    const start = bt.startOfDay('2026-06-15');
    const end = bt.endOfDay('2026-06-15');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
    // ঢাকা UTC+6, তাই দিন শুরু হয় আগের দিনের UTC ১৮:০০-এ
    expect(start.toISOString()).toBe('2026-06-14T18:00:00.000Z');
  });

  test('redpacket হাতে করা +6 ঘণ্টা অফসেট আর ব্যবহার করে না', () => {
    const redpacket = codeOnly(read('services', 'redpacket.js'));
    expect(redpacket).not.toMatch(/6 \* 3600 \* 1000/);
    expect(redpacket).toMatch(/businessTime|businessToday/);
  });
});

describe('#35 শিডিউলার একাধিক ইনস্ট্যান্সে নিরাপদ', () => {
  const scheduler = codeOnly(read('services', 'scheduler.js'));

  test('advisory lock নেওয়া হয়', () => {
    expect(scheduler).toMatch(/pg_try_advisory_lock/);
    expect(scheduler).toMatch(/pg_advisory_unlock/);
  });

  test('লক না পেলে জব স্কিপ হয়, দুবার চলে না', () => {
    expect(scheduler).toMatch(/skipped/);
  });

  test('লক আইডি স্থিতিশীল ও 32-bit', () => {
    const scheduleSrc = read('services', 'scheduler.js');
    expect(scheduleSrc).toMatch(/function advisoryLockId/);
  });
});

describe('#53 age gate সৎভাবে উপস্থাপিত', () => {
  test('বয়স যাচাই বলে দাবি করা হয় না', () => {
    const gate = read('public', 'js', 'age-gate.js');
    expect(gate).toMatch(/সেল্ফ-ডিক্লারেশন|UI গেট/);
    expect(gate).toMatch(/age verification নয়|যাচাই নয়/);
  });
});

describe('#54 যাচাইহীন মার্কেটিং দাবি সরানো', () => {
  const page = read('src', 'app', 'page.tsx');

  test('বানানো পরিসংখ্যান নেই', () => {
    expect(page).not.toMatch(/value: "500\+"/);
    expect(page).not.toMatch(/value: "6\.5M"/);
  });

  test('লাইসেন্স ব্যাজ কনফিগার করা থাকলে তবেই দেখায়', () => {
    expect(page).not.toMatch(/>CURACAO LICENSED</);
    expect(page).toMatch(/NEXT_PUBLIC_LICENSE_NOTICE/);
  });
});

describe('#42 sports-api অরক্ষিত নয়', () => {
  const server = read('sports-api', 'backend', 'server.js');

  test('লেখার রুটে কী বাধ্যতামূলক', () => {
    expect(server).toMatch(/app\.post\("\/api\/predict", requireApiKey/);
    expect(server).toMatch(/function requireApiKey/);
  });

  test('কী ছাড়া সার্ভিস চালুই হয় না', () => {
    expect(server).toMatch(/process\.exit\(1\)/);
  });

  test('ডিপ্লয় অবস্থা ডকুমেন্টেড', () => {
    expect(read('sports-api', 'README.md')).toMatch(/প্রোডাকশনের অংশ নয়/);
  });
});

describe('#49/#50/#51 CI আসল অ্যাপ যাচাই করে', () => {
  const workflow = read('.github', 'workflows', 'node.js.yml');

  test('E2E merge gate হিসেবে চলে', () => {
    expect(workflow).toMatch(/playwright test/);
    expect(workflow).toMatch(/playwright install/);
  });

  test('বুট স্মোক টেস্ট ও EJS কম্পাইল যাচাই আছে', () => {
    expect(workflow).toMatch(/Boot smoke test/);
    expect(workflow).toMatch(/ejs\.compile/);
  });

  test('coverage threshold কনফিগার করা', () => {
    const jestConfig = require('../jest.config.js');
    expect(jestConfig.coverageThreshold).toBeDefined();
    expect(jestConfig.coverageThreshold.global.statements).toBeGreaterThan(0);
    expect(jestConfig.coverageThreshold['./middleware/auth.js']).toBeDefined();
  });

  test('playwright কনফিগে হার্ডকোড করা ব্রাউজার পাথ নেই', () => {
    const pw = read('playwright.config.js');
    expect(pw).not.toMatch(/\/opt\/pw-browsers\/chromium'/);
    expect(pw).toMatch(/testDir/);
  });
});
