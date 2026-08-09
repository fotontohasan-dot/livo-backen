const speakeasy = require('speakeasy');
const {
  generateTotpSetup,
  verifyTotpToken,
  generateBackupCodes,
  hashBackupCodes,
  verifyAndConsumeBackupCode,
  qrFromSecret
} = require('../../services/twofactor');

// services/twofactor.js — অ্যাডমিন 2FA (TOTP + ব্যাকআপ কোড)।
// শুধু বিদ্যমান আচরণ যাচাই করা হচ্ছে, কোনো লজিক পরিবর্তন করা হয়নি।
describe('2FA / TOTP (services/twofactor.js)', () => {

  describe('generateTotpSetup()', () => {
    test('base32 সিক্রেট, otpauth URL ও QR ডেটা-URL রিটার্ন করে', async () => {
      const setup = await generateTotpSetup('testadmin');
      expect(setup.base32).toBeTruthy();
      expect(typeof setup.base32).toBe('string');
      expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    });

    test('প্রতিবার ভিন্ন সিক্রেট তৈরি করে (পুনরাবৃত্তি হয় না)', async () => {
      const a = await generateTotpSetup('user1');
      const b = await generateTotpSetup('user1');
      expect(a.base32).not.toBe(b.base32);
    });

    test('otpauth URL-এ issuer ও username থাকে', async () => {
      const setup = await generateTotpSetup('alice');
      expect(decodeURIComponent(setup.otpauthUrl)).toContain('Livo Admin');
      expect(decodeURIComponent(setup.otpauthUrl)).toContain('alice');
    });
  });

  describe('verifyTotpToken()', () => {
    let secret;
    beforeAll(async () => {
      secret = (await generateTotpSetup('verifyuser')).base32;
    });

    test('বর্তমান সময়ের সঠিক কোড গ্রহণ করে', () => {
      const token = speakeasy.totp({ secret, encoding: 'base32' });
      expect(verifyTotpToken(secret, token)).toBe(true);
    });

    test('স্পেসসহ কোড দিলেও গ্রহণ করে (ইউজার কপি-পেস্ট করলে)', () => {
      const token = speakeasy.totp({ secret, encoding: 'base32' });
      const spaced = `${token.slice(0, 3)} ${token.slice(3)}`;
      expect(verifyTotpToken(secret, spaced)).toBe(true);
    });

    test('ভুল কোড প্রত্যাখ্যান করে', () => {
      const token = speakeasy.totp({ secret, encoding: 'base32' });
      const wrong = token === '000000' ? '111111' : '000000';
      expect(verifyTotpToken(secret, wrong)).toBe(false);
    });

    test('অন্য সিক্রেটের কোড প্রত্যাখ্যান করে', async () => {
      const otherSecret = (await generateTotpSetup('otheruser')).base32;
      const otherToken = speakeasy.totp({ secret: otherSecret, encoding: 'base32' });
      expect(verifyTotpToken(secret, otherToken)).toBe(false);
    });

    test('অনেক পুরোনো কোড (window-এর বাইরে) প্রত্যাখ্যান করে', () => {
      const oldToken = speakeasy.totp({
        secret,
        encoding: 'base32',
        time: Math.floor(Date.now() / 1000) - 300 // ৫ মিনিট আগে
      });
      expect(verifyTotpToken(secret, oldToken)).toBe(false);
    });

    test('সিক্রেট বা টোকেন অনুপস্থিত থাকলে false দেয়, throw করে না', () => {
      const token = speakeasy.totp({ secret, encoding: 'base32' });
      expect(verifyTotpToken(null, token)).toBe(false);
      expect(verifyTotpToken(secret, null)).toBe(false);
      expect(verifyTotpToken(undefined, undefined)).toBe(false);
      expect(verifyTotpToken(secret, '')).toBe(false);
    });
  });

  describe('generateBackupCodes()', () => {
    test('ডিফল্টে ৮টা কোড তৈরি করে', () => {
      expect(generateBackupCodes()).toHaveLength(8);
    });

    test('চাহিদামতো সংখ্যক কোড তৈরি করে', () => {
      expect(generateBackupCodes(3)).toHaveLength(3);
    });

    test('কোডগুলো XXXXX-XXXXX ফরম্যাটে থাকে', () => {
      generateBackupCodes(5).forEach((code) => {
        expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
      });
    });

    test('একই ব্যাচে ডুপ্লিকেট কোড থাকে না', () => {
      const codes = generateBackupCodes(8);
      expect(new Set(codes).size).toBe(codes.length);
    });

    test('দুইবার কল করলে ভিন্ন কোড সেট আসে', () => {
      expect(generateBackupCodes(8)).not.toEqual(generateBackupCodes(8));
    });
  });

  describe('hashBackupCodes() ও verifyAndConsumeBackupCode()', () => {
    test('হ্যাশ করা কোডে আসল কোড plain text-এ থাকে না', async () => {
      const codes = generateBackupCodes(4);
      const stored = await hashBackupCodes(codes);
      codes.forEach((c) => expect(stored).not.toContain(c));
    });

    test('সঠিক ব্যাকআপ কোড গ্রহণ করে', async () => {
      const codes = generateBackupCodes(4);
      const stored = await hashBackupCodes(codes);
      const result = await verifyAndConsumeBackupCode(stored, codes[2]);
      expect(result.valid).toBe(true);
    });

    test('ব্যবহৃত কোড তালিকা থেকে সরে যায় (single-use)', async () => {
      const codes = generateBackupCodes(4);
      const stored = await hashBackupCodes(codes);

      const first = await verifyAndConsumeBackupCode(stored, codes[0]);
      expect(first.valid).toBe(true);
      expect(JSON.parse(first.remainingJson)).toHaveLength(3);

      // একই কোড আবার ব্যবহার করা যাবে না
      const reuse = await verifyAndConsumeBackupCode(first.remainingJson, codes[0]);
      expect(reuse.valid).toBe(false);
    });

    test('বাকি কোডগুলো ব্যবহারযোগ্য থাকে', async () => {
      const codes = generateBackupCodes(3);
      const stored = await hashBackupCodes(codes);
      const used = await verifyAndConsumeBackupCode(stored, codes[0]);
      const other = await verifyAndConsumeBackupCode(used.remainingJson, codes[1]);
      expect(other.valid).toBe(true);
    });

    test('ছোট হাতের অক্ষরে দেওয়া কোডও গ্রহণ করে', async () => {
      const codes = generateBackupCodes(2);
      const stored = await hashBackupCodes(codes);
      const result = await verifyAndConsumeBackupCode(stored, codes[0].toLowerCase());
      expect(result.valid).toBe(true);
    });

    test('আগে/পরে স্পেস থাকলেও গ্রহণ করে', async () => {
      const codes = generateBackupCodes(2);
      const stored = await hashBackupCodes(codes);
      const result = await verifyAndConsumeBackupCode(stored, `  ${codes[0]}  `);
      expect(result.valid).toBe(true);
    });

    test('ভুল কোড প্রত্যাখ্যান করে', async () => {
      const stored = await hashBackupCodes(generateBackupCodes(4));
      const result = await verifyAndConsumeBackupCode(stored, 'AAAAA-BBBBB');
      expect(result.valid).toBe(false);
    });

    test('অবৈধ/খালি ইনপুটে throw না করে false দেয়', async () => {
      const stored = await hashBackupCodes(generateBackupCodes(2));
      expect((await verifyAndConsumeBackupCode(null, 'AAAAA-BBBBB')).valid).toBe(false);
      expect((await verifyAndConsumeBackupCode(stored, null)).valid).toBe(false);
      expect((await verifyAndConsumeBackupCode('not-valid-json', 'AAAAA-BBBBB')).valid).toBe(false);
      expect((await verifyAndConsumeBackupCode('{"a":1}', 'AAAAA-BBBBB')).valid).toBe(false);
      expect((await verifyAndConsumeBackupCode('[]', 'AAAAA-BBBBB')).valid).toBe(false);
    });
  });

  describe('qrFromSecret()', () => {
    test('বিদ্যমান সিক্রেট থেকে QR ডেটা-URL তৈরি করে', async () => {
      const secret = (await generateTotpSetup('qruser')).base32;
      const qr = await qrFromSecret(secret, 'qruser');
      expect(qr).toMatch(/^data:image\/png;base64,/);
    });
  });
});
