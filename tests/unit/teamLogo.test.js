const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../../services/teamLogo');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const pub = async () => [{ address: '93.184.216.34', family: 4 }];
const ok = (body = PNG, extra = {}) => async () => ({ status: 200, headers: {}, body, ...extra });

describe('isBlockedIp', () => {
  test.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0',
    '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'not-an-ip'
  ])('blocks %s', (ip) => expect(L.isBlockedIp(ip)).toBe(true));
  test.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111'])('allows %s', (ip) => expect(L.isBlockedIp(ip)).toBe(false));
});

describe('validateLogoUrl', () => {
  test.each([
    'http://cdn.example.com/a.png', 'ftp://x.com/a.png', 'https://user:pw@cdn.example.com/a.png', 'https://cdn.example.com:8443/a.png',
    'https://localhost/a.png', 'https://foo.localhost/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://10.0.0.5/a.png',
    'https://169.254.169.254/latest/meta-data', 'https://svc.internal/a.png', '', 'javascript:alert(1)', 'https://' + 'a'.repeat(3000) + '.com/x'
  ])('rejects %s', (u) => expect(() => L.validateLogoUrl(u, [])).toThrow());
  test('accepts a public https url and enforces the allow-list', () => {
    expect(L.validateLogoUrl('https://cdn.example.com/a.png', []).hostname).toBe('cdn.example.com');
    expect(() => L.validateLogoUrl('https://evil.com/a.png', ['example.com'])).toThrow('host_not_allowed');
    expect(L.validateLogoUrl('https://img.example.com/a.png', ['example.com'])).toBeTruthy();
    expect(() => L.validateLogoUrl('https://notexample.com/a.png', ['example.com'])).toThrow();
  });
});

describe('downloadLogo', () => {
  const run = (url, deps) => L.downloadLogo(url, { hosts: [], lookup: pub, ...deps });
  test('returns a valid PNG', async () => {
    const r = await run('https://cdn.example.com/a.png', { get: ok() });
    expect(r.ext).toBe('png');
  });
  test('DNS answering a private address is refused (and one bad answer poisons the host)', async () => {
    await expect(run('https://cdn.example.com/a.png', { lookup: async () => [{ address: '10.0.0.1', family: 4 }], get: ok() })).rejects.toThrow('blocked_ip');
    await expect(run('https://cdn.example.com/a.png', { lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], get: ok() })).rejects.toThrow('blocked_ip');
  });
  test('the socket is pinned to the validated address', async () => {
    let pinned;
    await run('https://cdn.example.com/a.png', { get: async (u, pin) => { pinned = pin; return { status: 200, headers: {}, body: PNG }; } });
    expect(pinned.address).toBe('93.184.216.34');
  });
  test('a redirect to a private host is refused; a redirect to a public host is followed', async () => {
    await expect(run('https://cdn.example.com/a.png', { get: async () => ({ status: 302, headers: { location: 'https://169.254.169.254/x' }, body: Buffer.alloc(0) }) })).rejects.toThrow('blocked_ip');
    await expect(run('https://cdn.example.com/a.png', { get: async () => ({ status: 302, headers: { location: 'http://cdn.example.com/x' }, body: Buffer.alloc(0) }) })).rejects.toThrow('not_https');
    let n = 0;
    const r = await run('https://cdn.example.com/a.png', { get: async () => (n++ === 0 ? { status: 301, headers: { location: '/b.png' }, body: Buffer.alloc(0) } : { status: 200, headers: {}, body: PNG }) });
    expect(r.ext).toBe('png');
  });
  test('redirect loops stop', async () => {
    await expect(run('https://cdn.example.com/a', { get: async () => ({ status: 302, headers: { location: '/a' }, body: Buffer.alloc(0) }) })).rejects.toThrow('too_many_redirects');
  });
  test('svg, html and lying content-types are rejected by the bytes', async () => {
    for (const body of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('<html></html>'), Buffer.from('GIF')]) {
      await expect(run('https://cdn.example.com/a.png', { get: ok(body, { headers: { 'content-type': 'image/png' } }) })).rejects.toThrow('not_an_image');
    }
  });
  test('over 200 KB is rejected; non-200 and empty are rejected', async () => {
    await expect(run('https://cdn.example.com/a.png', { get: ok(Buffer.concat([PNG, Buffer.alloc(L.MAX_BYTES)])) })).rejects.toThrow('too_large');
    await expect(run('https://cdn.example.com/a.png', { get: async () => ({ status: 404, headers: {}, body: PNG }) })).rejects.toThrow('http_404');
    await expect(run('https://cdn.example.com/a.png', { get: ok(Buffer.alloc(0)) })).rejects.toThrow('empty');
  });
});

describe('storeLogo / sniff', () => {
  test('stores under a content-hash name, deduplicates, and never uses the URL for the path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logos-'));
    const a = await L.storeLogo(PNG, 'png', dir);
    const b = await L.storeLogo(PNG, 'png', dir);
    expect(a).toBe(b);
    expect(L.SAFE_FILE.test(a)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([a]);
  });
  test('sniffs png/jpg/gif/webp only', () => {
    expect(L.sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])).ext).toBe('jpg');
    expect(L.sniffImage(Buffer.from('GIF89a....')).ext).toBe('gif');
    expect(L.sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])).ext).toBe('webp');
    expect(L.sniffImage(Buffer.from('<svg></svg>'))).toBeNull();
  });
});
