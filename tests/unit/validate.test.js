// tests/unit/validate.test.js
// এই টেস্টগুলো কোনো DB/অ্যাপ বুট ছাড়াই চলে — শুধু pure validation helper ফাংশন যাচাই করে।

const { parseAmount, sanitizeText, isSafeUrl, parsePositiveInt } = require('../../middleware/validate');

describe('middleware/validate: parseAmount', () => {
  test('accepts a valid integer amount within range', () => {
    expect(parseAmount('500')).toBe(500);
  });

  test('rejects non-integer / float amounts', () => {
    expect(parseAmount('10.5')).toBeNull();
  });

  test('rejects amounts above the default max (overflow / abuse protection)', () => {
    expect(parseAmount('999999999999')).toBeNull();
  });

  test('rejects zero and negative amounts', () => {
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('-100')).toBeNull();
  });

  test('rejects non-numeric input (injection-style payloads)', () => {
    expect(parseAmount('1000; DROP TABLE users;')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });

  test('respects custom min/max options', () => {
    expect(parseAmount('50', { min: 100, max: 200 })).toBeNull();
    expect(parseAmount('150', { min: 100, max: 200 })).toBe(150);
  });
});

describe('middleware/validate: sanitizeText (XSS / stored-injection protection)', () => {
  test('strips HTML and script tags', () => {
    expect(sanitizeText('<script>alert(1)</script>hello')).toBe('alert(1)hello');
    expect(sanitizeText('<img src=x onerror=alert(1)>')).toBe('');
  });

  test('strips javascript: URI scheme', () => {
    expect(sanitizeText('javascript:alert(1)')).toBe('alert(1)');
  });

  test('trims whitespace and enforces max length', () => {
    expect(sanitizeText('  hi  ')).toBe('hi');
    expect(sanitizeText('a'.repeat(3000), { maxLen: 10 }).length).toBe(10);
  });

  test('returns empty string for non-string input', () => {
    expect(sanitizeText(12345)).toBe('');
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText(undefined)).toBe('');
  });
});

describe('middleware/validate: isSafeUrl', () => {
  test('accepts http/https URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('http://example.com/path')).toBe(true);
  });

  test('rejects javascript:, data: and malformed URLs', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeUrl('not a url')).toBe(false);
    expect(isSafeUrl('')).toBe(false);
  });
});

describe('middleware/validate: parsePositiveInt', () => {
  test('accepts positive integers', () => {
    expect(parsePositiveInt('42')).toBe(42);
  });

  test('rejects zero, negatives, floats and non-numeric values', () => {
    expect(parsePositiveInt('0')).toBeNull();
    expect(parsePositiveInt('-5')).toBeNull();
    expect(parsePositiveInt('3.5')).toBeNull();
    expect(parsePositiveInt('abc')).toBeNull();
    expect(parsePositiveInt("1 OR 1=1")).toBeNull();
  });
});
