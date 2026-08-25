const { sanitizeRepoPath, extractText } = require('../../telegram-bot');

describe('telegram-bot: GitHub file path validation (P1-06)', () => {
  test('repo-relative paths accepted', () => {
    expect(sanitizeRepoPath('app.js')).toBe('app.js');
    expect(sanitizeRepoPath('routes/adminTelegram.js')).toBe('routes/adminTelegram.js');
    expect(sanitizeRepoPath('  services/cache.js  ')).toBe('services/cache.js');
  });

  test('traversal, absolute and URL-injection paths rejected', () => {
    const bad = [
      '../../etc/passwd',
      'a/../b',
      './app.js',
      '/etc/passwd',
      'app.js?ref=other-branch',
      'app.js#frag',
      'app.js&x=1',
      '../.github/workflows/deploy.yml',
      'dir/',
      '',
      '   ',
      'a b.js',
      'x'.repeat(256)
    ];
    bad.forEach((p) => expect(sanitizeRepoPath(p)).toBeNull());
  });

  test('non-string input rejected', () => {
    [null, undefined, 42, {}, []].forEach((p) => expect(sanitizeRepoPath(p)).toBeNull());
  });
});

describe('telegram-bot: model response text extraction (P1-06)', () => {
  test('joins text blocks and ignores non-text blocks', () => {
    expect(extractText({ content: [{ type: 'thinking' }, { type: 'text', text: 'hi' }] })).toBe('hi');
    expect(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
  });

  test('returns empty string instead of throwing on missing/odd content', () => {
    expect(extractText({})).toBe('');
    expect(extractText({ content: [] })).toBe('');
    expect(extractText({ content: [{ type: 'tool_use' }] })).toBe('');
    expect(extractText(null)).toBe('');
  });
});
