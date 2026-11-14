// K2 — holder_name ভ্যালিডেটর: বৈধ বাংলা/ইংরেজি নাম পাস, বাকি সব প্রত্যাখ্যান; সার্ভার ও ক্লায়েন্ট নিয়ম অভিন্ন।
const { validateHolderName, sanitizeImportedRows } = require('../../utils/holderName');
const client = require('../../public/js/holder-name-validate.js');

const VALID = [
  'Rahim Uddin', 'রহিম উদ্দিন', 'আবদুল্লাহ আল-মামুন', "Mary-Jane O'Neil", 'O’Brien', 'José Álvarez', 'Md. Karim',
  '李小龍', 'অনিন্দ্য', 'শামীমা আক্তার', 'Ana', 'আলি', 'মোঃ রফিকুল ইসলাম', 'A.K.M. Rahman', 'র‍্যাব আলী',
];
const INVALID = [
  '', ' ', '   ', 'a', 'ক', 'x'.repeat(61), 'P@ssw0rd!', '12345678', 'Pass1234', 'name123', 'Secur3Pass#', 'my_password',
  '<script>alert(1)</script>', "a'; DROP TABLE users;--", 'hello\nworld', 'na\tme', 'na\nme', '-name', '.name', "'name",
  'name_with_underscore', '😀 smile', 'smile 😀', 'নাম১২৩', 'Rahim@Uddin', 'a b!', '..', '--', 'ab\u200bcd'.replace('b', '\u0000'),
  '১২৩৪৫৬', 'pass word 1',
];
const NOT_STRINGS = [undefined, null, 123, [], ['Rahim'], {}, { toString: () => 'Rahim' }, true];

describe('বৈধ নাম পাস', () => {
  test.each(VALID)('%s', (name) => { expect(validateHolderName(name).valid).toBe(true); });
  test('ছাঁটা ও পরপর স্পেস একটা; NFC', () => {
    expect(validateHolderName('  Rahim    Uddin  ').value).toBe('Rahim Uddin');
    expect(validateHolderName('Cafe\u0301 Noir').value).toBe('Caf\u00e9 Noir');
    expect(validateHolderName('\tRahim\n').value).toBe('Rahim'); // শুধু শুরু/শেষের ফাঁকা ছাঁটা হয়; মাঝের ট্যাব/নতুন লাইন প্রত্যাখ্যাত (উপরে)
  });
});

describe('বাকিগুলো প্রত্যাখ্যান', () => {
  test.each(INVALID)('%j', (v) => { expect(validateHolderName(v)).toEqual({ valid: false, value: null }); });
  test.each(NOT_STRINGS.map((v) => [typeof v, v]))('স্ট্রিং নয় (%s)', (_, v) => { expect(validateHolderName(v).valid).toBe(false); });
  test('সীমা: ২ ও ৬০ অক্ষর বৈধ; ১ ও ৬১ অবৈধ', () => {
    expect(validateHolderName('ab').valid).toBe(true);
    expect(validateHolderName('a'.repeat(60)).valid).toBe(true);
    expect(validateHolderName('a').valid).toBe(false);
    expect(validateHolderName('a'.repeat(61)).valid).toBe(false);
  });
  test('কখনো throw করে না', () => {
    expect(() => validateHolderName('\ud800')).not.toThrow();
    expect(() => validateHolderName(Symbol.iterator)).not.toThrow();
  });
});

describe('সার্ভার ও ক্লায়েন্ট নিয়ম অভিন্ন', () => {
  test.each([...VALID, ...INVALID, '  Rahim    Uddin  '])('%j', (v) => {
    expect(client.check(v)).toEqual(validateHolderName(v));
  });
  test('ক্লায়েন্টও স্ট্রিং-নয় প্রত্যাখ্যান করে', () => {
    for (const v of NOT_STRINGS) expect(client.check(v).valid).toBe(false);
  });
});

describe('sanitizeImportedRows (রিস্টোর/ইমপোর্ট)', () => {
  test('অবৈধ মান NULL, বৈধ নামাল, ফাঁকা/NULL অক্ষত; সারি বাদ যায় না', () => {
    const rows = [
      { id: 1, holder_name: 'Rahim Uddin' }, { id: 2, holder_name: 'S3cretPass!' }, { id: 3, holder_name: null },
      { id: 4, holder_name: '' }, { id: 5, holder_name: '  রহিম   উদ্দিন ' }, { id: 6 },
    ];
    const out = sanitizeImportedRows(rows);
    expect(out.rows).toHaveLength(6);
    expect(out.cleared).toBe(1);
    expect(out.rows.map((r) => r.holder_name)).toEqual(['Rahim Uddin', null, null, '', 'রহিম উদ্দিন', undefined]);
  });
});
