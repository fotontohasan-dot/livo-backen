const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.TEAM_LOGO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'logos-'));
const logos = require('../../services/teamLogos');
const { emptyLive, liveForClient } = require('../../services/liveData');
const { buildMarketView, filterMarketView } = require('../../services/marketLayout');

describe('team logo cache safety', () => {
  test('only https URLs are remote', () => {
    expect(logos.isRemote('https://cdn.example.com/a.png')).toBe(true);
    for (const u of ['http://x.com/a.png', '//x.com/a.png', 'javascript:alert(1)', '/images/a.png', 'https://x.com/a b.png', '']) {
      expect(logos.isRemote(u)).toBe(false);
    }
  });
  test('private / loopback / link-local addresses are blocked (SSRF)', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) {
      expect(logos.isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(logos.isPrivateIp(ip)).toBe(false);
  });
  test('magic-byte sniffing accepts raster images only (never SVG/HTML)', () => {
    const pad = Buffer.alloc(16);
    expect(logos.sniff(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), pad]))).toBe('png');
    expect(logos.sniff(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), pad]))).toBe('jpg');
    expect(logos.sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), pad]))).toBe('webp');
    expect(logos.sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(logos.sniff(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
  });
  test('cachedPath finds a stored file; unknown URL -> null; cacheLogo never throws on bad input', async () => {
    const url = 'https://cdn.example.com/team.png';
    expect(logos.cachedPath(url)).toBeNull();
    fs.writeFileSync(path.join(logos.DIR, `${logos.hashOf(url)}.png`), Buffer.alloc(20));
    expect(logos.cachedPath(url)).toBe(`/images/teams/${logos.hashOf(url)}.png`);
    expect(await logos.cacheLogo(url)).toBe(`/images/teams/${logos.hashOf(url)}.png`); // cache hit, no network
    expect(await logos.cacheLogo('http://insecure/x.png')).toBeNull();
    expect(await logos.cacheLogo('https://127.0.0.1/x.png')).toBeNull();               // blocked address, no request made
  });
});

describe('fallback live data', () => {
  test('known sports get a waiting placeholder; stored data wins', () => {
    expect(emptyLive('cricket')).toEqual({ kind: 'cricket', waiting: true });
    expect(liveForClient('football', null)).toEqual({ kind: 'football', waiting: true });
    expect(liveForClient('tennis', { kind: 'tennis', sets: [[6, 4]] }).sets).toEqual([[6, 4]]);
    expect(emptyLive('rugby')).toBeNull();
  });
});

describe('player-specific markets', () => {
  const view = buildMarketView([
    { id: 10, type: 'player_runs', name: 'V Kohli Runs Over/Under 32.5', odds: { over: 1.9, under: 1.9 },
      depth: { over: { lay: 1.95, back_size: 800, lay_size: 500 } } },
    { id: 11, type: 'player_h2h', name: 'Head to Head: Kohli vs Rohit', odds: { 0: 1.8, 1: 2.0 },
      depth: { 0: { name: 'V Kohli', lay: 1.85 }, 1: { name: 'R Sharma', lay: 2.05 } } }
  ], { sport: 'cricket', teams: ['India', 'Australia'] });
  test('both land in the Player Performance tab', () => {
    expect(filterMarketView(view, 'player').map((m) => m.id)).toEqual([10, 11]);
    expect(view.tabs.map((t) => t.label)).toContain('Player Performance');
  });
  test('feed runner names label head-to-head runners and carry lay prices', () => {
    const h2h = view.markets.find((m) => m.id === 11);
    expect(h2h.runners.map((r) => r.label)).toEqual(['V Kohli', 'R Sharma']);
    expect(h2h.runners.map((r) => r.lay)).toEqual([1.85, 2.05]);
  });
  test('lay on a player market uses the same liability formula', () => {
    const { calcLiability, calcPotentialPayout } = require('../../services/layBet');
    expect(calcLiability(100, 1.85)).toBe(85);
    expect(calcPotentialPayout('lay', 100, 1.85)).toBe(185);
  });
  test('every cricket tab is present even with no markets (hydrates later)', () => {
    const empty = buildMarketView([], { sport: 'cricket', teams: ['A', 'B'] });
    expect(empty.tabs.map((t) => t.id)).toEqual(['all', 'match', 'bookmaker', 'fancy', 'ou', 'oe', 'player']);
  });
});
