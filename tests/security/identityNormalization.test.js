const fs = require('fs');
const path = require('path');
const {
  normalizeEmail,
  normalizeUsername,
  normalizePhone,
  normalizeIdentifier
} = require('../../utils/identity');

const ROOT = path.join(__dirname, '..', '..');

describe('identity normalization (P2-06)', () => {
  test('email is trimmed and lowercased', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
    expect(normalizeEmail('foo@example.com')).toBe('foo@example.com');
  });

  test('empty and non-string email becomes null', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  test('username is trimmed but keeps its case', () => {
    expect(normalizeUsername('  Mahmud_01 ')).toBe('Mahmud_01');
    expect(normalizeUsername('   ')).toBeNull();
    expect(normalizeUsername(null)).toBeNull();
  });

  test('phone is trimmed only', () => {
    expect(normalizePhone(' 01712345678 ')).toBe('01712345678');
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  test('login identifier lowercases emails but leaves phone numbers alone', () => {
    expect(normalizeIdentifier(' Foo@Example.com ')).toBe('foo@example.com');
    expect(normalizeIdentifier(' 01712345678 ')).toBe('01712345678');
    expect(normalizeIdentifier('')).toBeNull();
    expect(normalizeIdentifier(null)).toBeNull();
  });

  test('case and whitespace variants collapse to one identity', () => {
    const variants = ['foo@example.com', 'FOO@EXAMPLE.COM', ' Foo@Example.Com ', 'fOo@eXaMpLe.cOm'];
    expect(new Set(variants.map(normalizeEmail)).size).toBe(1);
  });
});

describe('auth lookups are case-insensitive (P2-06 regression)', () => {
  const source = () => fs.readFileSync(path.join(ROOT, 'routes/auth.js'), 'utf8');

  test('no exact-match email lookup remains', () => {
    const code = source()
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/WHERE email = \$1/);
    expect(code).not.toMatch(/email = \$1 OR phone = \$1/);
  });

  test('registration, login, reset and Google linking all normalize', () => {
    const code = source();
    expect(code).toMatch(/normalizeEmail/);
    expect(code).toMatch(/normalizeIdentifier/);
    expect(code).toMatch(/LOWER\(email\) = \$1/);
  });
});
