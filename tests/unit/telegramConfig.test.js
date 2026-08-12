// tests/unit/telegramConfig.test.js
// এই টেস্টগুলো কোনো DB/অ্যাপ বুট ছাড়াই চলে — services/telegramConfig.js-এর
// pure helper (mask/validate/normalize/shouldNotify) ও এনক্রিপশন লেয়ার যাচাই করে।
// (db শুধু DB-নির্ভর ফাংশনের ভেতরে lazy-require করা হয়, তাই এখানে pg লাগে না।)

const tg = require('../../services/telegramConfig');

const SAMPLE_TOKEN = '123456789:AAF-abcdefghijklmnopqrstuvwxyz012345';

describe('telegramConfig: maskToken (secret কখনো পুরো এক্সপোজ হয় না)', () => {
  test('bot id রাখে কিন্তু secret অংশ লুকায়', () => {
    const masked = tg.maskToken(SAMPLE_TOKEN);
    expect(masked.startsWith('123456789:')).toBe(true);
    expect(masked).not.toContain('AAF-abcdefghijklmnopqrstuvwxyz');
    expect(masked.endsWith('2345')).toBe(true);
  });

  test('খালি/অবৈধ ইনপুটে খালি স্ট্রিং', () => {
    expect(tg.maskToken('')).toBe('');
    expect(tg.maskToken(null)).toBe('');
    expect(tg.maskToken(undefined)).toBe('');
  });

  test('কোলনবিহীন ছোট স্ট্রিংও কখনো পুরো দেখায় না', () => {
    expect(tg.maskToken('secret12')).toBe('••••••••');
  });
});

describe('telegramConfig: isValidBotToken', () => {
  test('সঠিক ফরম্যাটের টোকেন গ্রহণ করে', () => {
    expect(tg.isValidBotToken(SAMPLE_TOKEN)).toBe(true);
    expect(tg.isValidBotToken(`  ${SAMPLE_TOKEN}  `)).toBe(true);
  });

  test('ভুল ফরম্যাট/ইনজেকশন-ধরনের ইনপুট বাতিল করে', () => {
    expect(tg.isValidBotToken('')).toBe(false);
    expect(tg.isValidBotToken(null)).toBe(false);
    expect(tg.isValidBotToken('not-a-token')).toBe(false);
    expect(tg.isValidBotToken('123:short')).toBe(false);
    expect(tg.isValidBotToken('123456789:AAF-abc$%^&*(){}[]<script>alert(1)')).toBe(false);
  });
});

describe('telegramConfig: isValidChatId', () => {
  test('numeric ও negative (গ্রুপ/সুপারগ্রুপ) chat id গ্রহণ করে', () => {
    expect(tg.isValidChatId('123456789')).toBe(true);
    expect(tg.isValidChatId('-1001234567890')).toBe(true);
    expect(tg.isValidChatId(123456789)).toBe(true);
  });

  test('@channelusername গ্রহণ করে', () => {
    expect(tg.isValidChatId('@livo_alerts')).toBe(true);
  });

  test('খালি বা অবৈধ ইনপুট বাতিল করে', () => {
    expect(tg.isValidChatId('')).toBe(false);
    expect(tg.isValidChatId(null)).toBe(false);
    expect(tg.isValidChatId('abc def')).toBe(false);
    expect(tg.isValidChatId("123'; DROP TABLE users;--")).toBe(false);
  });
});

describe('telegramConfig: normalizeCategories', () => {
  test('চেকবক্স-স্টাইল ভ্যালু boolean-এ রূপান্তর করে', () => {
    const out = tg.normalizeCategories({ deposit: 'true', withdraw: 'on', support: '1', security: true });
    expect(out.deposit).toBe(true);
    expect(out.withdraw).toBe(true);
    expect(out.support).toBe(true);
    expect(out.security).toBe(true);
  });

  test('অনুপস্থিত কী = false (আনচেক করা চেকবক্স ব্রাউজার পাঠায় না)', () => {
    const out = tg.normalizeCategories({ deposit: 'true' });
    expect(out.withdraw).toBe(false);
    expect(out.system).toBe(false);
  });

  test('অজানা কী উপেক্ষা করে, শুধু জানা ক্যাটাগরি ফেরত দেয়', () => {
    const out = tg.normalizeCategories({ deposit: 'true', __proto__hack: 'true', evil: true });
    expect(Object.keys(out).sort()).toEqual([...tg.CATEGORIES].sort());
  });

  test('ইনপুট না দিলে সব ডিফল্ট (true)', () => {
    expect(tg.normalizeCategories(null)).toEqual(tg.DEFAULT_CATEGORIES);
  });
});

describe('telegramConfig: shouldNotify (নোটিফিকেশন গেটিং)', () => {
  const base = {
    enabled: true,
    botToken: SAMPLE_TOKEN,
    chatId: '123456789',
    categories: { ...tg.DEFAULT_CATEGORIES }
  };

  test('সব ঠিক থাকলে পাঠায়', () => {
    expect(tg.shouldNotify(base, 'deposit')).toBe(true);
    expect(tg.shouldNotify(base)).toBe(true);
  });

  test('ইন্টিগ্রেশন বন্ধ থাকলে কোনো ক্যাটাগরিই পাঠায় না', () => {
    expect(tg.shouldNotify({ ...base, enabled: false }, 'deposit')).toBe(false);
    expect(tg.shouldNotify({ ...base, enabled: false })).toBe(false);
  });

  test('credential না থাকলে পাঠায় না', () => {
    expect(tg.shouldNotify({ ...base, botToken: null }, 'deposit')).toBe(false);
    expect(tg.shouldNotify({ ...base, chatId: null }, 'deposit')).toBe(false);
  });

  test('নির্দিষ্ট ক্যাটাগরি বন্ধ থাকলে শুধু সেটাই ব্লক হয়', () => {
    const cfg = { ...base, categories: { ...tg.DEFAULT_CATEGORIES, withdraw: false } };
    expect(tg.shouldNotify(cfg, 'withdraw')).toBe(false);
    expect(tg.shouldNotify(cfg, 'deposit')).toBe(true);
  });

  test('অচেনা category ব্লক করে না (legacy কল ব্যাকওয়ার্ড-কম্প্যাটিবল)', () => {
    expect(tg.shouldNotify(base, 'unknown_category')).toBe(true);
  });

  test('config না থাকলে নিরাপদে false', () => {
    expect(tg.shouldNotify(null, 'deposit')).toBe(false);
  });
});

describe('telegramConfig: encryptSecret / decryptSecret (at-rest সুরক্ষা)', () => {
  const OLD = process.env.TELEGRAM_SETTINGS_KEY;
  beforeAll(() => { process.env.TELEGRAM_SETTINGS_KEY = 'unit-test-encryption-key-0123456789'; });
  afterAll(() => { if (OLD === undefined) delete process.env.TELEGRAM_SETTINGS_KEY; else process.env.TELEGRAM_SETTINGS_KEY = OLD; });

  test('round-trip সঠিকভাবে কাজ করে', () => {
    const packed = tg.encryptSecret(SAMPLE_TOKEN);
    expect(tg.decryptSecret(packed)).toBe(SAMPLE_TOKEN);
  });

  test('ciphertext-এ plaintext টোকেন থাকে না', () => {
    const packed = tg.encryptSecret(SAMPLE_TOKEN);
    expect(packed).not.toContain(SAMPLE_TOKEN);
    expect(packed.startsWith('v1:')).toBe(true);
  });

  test('একই ইনপুটে প্রতিবার আলাদা ciphertext (র‍্যান্ডম IV)', () => {
    expect(tg.encryptSecret(SAMPLE_TOKEN)).not.toBe(tg.encryptSecret(SAMPLE_TOKEN));
  });

  test('টেম্পার করা ciphertext ডিক্রিপ্ট হয় না (GCM auth tag)', () => {
    const parts = tg.encryptSecret(SAMPLE_TOKEN).split(':');
    parts[3] = Buffer.from('tampered-ciphertext-value').toString('base64');
    expect(tg.decryptSecret(parts.join(':'))).toBeNull();
  });

  test('ভুল/অসম্পূর্ণ ইনপুটে throw না করে null', () => {
    expect(tg.decryptSecret('')).toBeNull();
    expect(tg.decryptSecret(null)).toBeNull();
    expect(tg.decryptSecret('garbage')).toBeNull();
    expect(tg.decryptSecret('v2:a:b:c')).toBeNull();
  });

  test('ভিন্ন কী দিয়ে ডিক্রিপ্ট করা যায় না', () => {
    const packed = tg.encryptSecret(SAMPLE_TOKEN);
    process.env.TELEGRAM_SETTINGS_KEY = 'a-completely-different-key-value-xyz';
    expect(tg.decryptSecret(packed)).toBeNull();
    process.env.TELEGRAM_SETTINGS_KEY = 'unit-test-encryption-key-0123456789';
  });
});
