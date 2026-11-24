// tests/render/homeCasinoFirst.test.js
// ---------------------------------------------------------------------------
// ক্যাসিনো-প্রথম হোম: ন্যাভ ক্রম, সার্ভার-সাইড ফিল্টার (ক্যাটাগরি/প্রোভাইডার/A-Z/সার্চ),
// খালি ক্যাটাগরি লুকানো, ম্যাচ সাইডবারের সর্বোচ্চ সীমা, সাসপেন্ড আচরণ ও গেম-লঞ্চ লিংক।
// ওয়ালেট/সেটেলমেন্ট/ডিপোজিট লজিক এখানে ছোঁয়া হয়নি — শুধু ভিউ ও হোমের ডেটা-পড়া।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const request = require('supertest');
const { app, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const cache = require('../../services/cache');
const autoSuspend = require('../../services/autoSuspend');

jest.setTimeout(60000);

const P = 'HcTestProv';
const P_DOWN = 'HcTestDown';
const CAT_ACTIVE = 'hctest_slots';
const CAT_EMPTY = 'hctest_empty';

const SEED = [
  // [name, slug, category, provider, gameId, active, adminDisabled]
  ['Alpha Fortune', 'hc-alpha', CAT_ACTIVE, P, 'hc-1', true, false],
  ['Apple Spin', 'hc-apple', CAT_ACTIVE, P, 'hc-2', true, false],
  ['Beta Crash', 'hc-beta', CAT_ACTIVE, P, 'hc-3', true, false],
  ['বাংলা গেম', 'hc-bangla', CAT_ACTIVE, P, 'hc-4', true, false],
  ['Down Game', 'hc-down', CAT_ACTIVE, P_DOWN, 'hc-5', true, false],
  ['Hidden Inactive', 'hc-inactive', CAT_EMPTY, P, 'hc-6', false, false],
  ['Hidden Disabled', 'hc-disabled', CAT_EMPTY, P, 'hc-7', true, true]
];

async function clearCache() {
  await cache.del('home:casino:facets', 'home:casino:rows', 'home:casino:banners');
}

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
  return { agent, id: r.rows[0].id };
}

beforeAll(async () => {
  for (const [name, slug, category, provider, gid, active, disabled] of SEED) {
    await pool.query(
      `INSERT INTO games (name, slug, emoji, category, provider, provider_game_id, is_active, admin_disabled)
       VALUES ($1, $2, '🎰', $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET is_active = EXCLUDED.is_active, admin_disabled = EXCLUDED.admin_disabled,
         category = EXCLUDED.category, provider = EXCLUDED.provider, provider_game_id = EXCLUDED.provider_game_id`,
      [name, slug, category, provider, gid, active, disabled]
    );
  }
  await clearCache();
});

afterAll(async () => {
  await pool.query(`DELETE FROM games WHERE slug LIKE 'hc-%'`);
  await clearCache();
});

afterEach(() => jest.restoreAllMocks());

describe('হোম — 200 ও নেভিগেশন ক্রম', () => {
  test('লগইন ছাড়া হোম 200', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="casinoHome"');
  });

  test('লগইন করা অবস্থায় হোম 200', async () => {
    const u = await makeUser();
    const res = await u.agent.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="casinoHome"');
    await pool.query('DELETE FROM users WHERE id = $1', [u.id]).catch(() => {});
  });

  test('ক্যাসিনো সাসপেন্ড থাকলেও হোম 200 ও "সাময়িকভাবে বন্ধ" দেখায়', async () => {
    jest.spyOn(autoSuspend, 'suspendedCasinoProviders').mockResolvedValue(new Set([P_DOWN]));
    const res = await request(app).get(`/?provider=${P_DOWN}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('cs-suspended');
    expect(res.text).toContain('সাময়িকভাবে বন্ধ');
    expect(res.text).not.toContain('/games/launch/HcTestDown/hc-5'); // সাসপেন্ড কার্ডে লঞ্চ-লিংক নেই
  });

  test('সাসপেন্ড-অবস্থা পড়া ব্যর্থ হলে ফেইল-ওপেন (হোম ভাঙে না)', async () => {
    jest.spyOn(autoSuspend, 'suspendedCasinoProviders').mockRejectedValue(new Error('boom'));
    const res = await request(app).get(`/?provider=${P}`);
    expect(res.status).toBe(200);
  });

  test('ন্যাভ ক্রম: ক্যাসিনো, লাইভ ক্যাসিনো, ক্রিকেট, স্পোর্টস, তারপর বাকি', async () => {
    const res = await request(app).get('/');
    const labels = [...res.text.matchAll(/<a href="[^"]+" class="main-cat-item[^"]*">.*?<span>([^<]+)<\/span><\/a>/g)].map((m) => m[1]);
    expect(labels.slice(0, 4)).toEqual(['ক্যাসিনো', 'লাইভ ক্যাসিনো', 'ক্রিকেট', 'স্পোর্টস']);
    expect(labels).toEqual(expect.arrayContaining(['ফুটবল', 'টুর্নামেন্ট', 'প্রমোশন']));
  });

  test('English locale-এ নতুন লেবেল ইংরেজিতে আসে', async () => {
    const { agent } = await getCsrfAgent('/register');
    await agent.get('/lang/en').set('Referer', '/');
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<html lang="en"/);
    for (const label of ['Casino', 'Live Casino', 'Cricket', 'Sports', 'Wallet', 'All games']) {
      expect(res.text).toContain(label);
    }
    const nav = [...res.text.matchAll(/<a href="[^"]+" class="main-cat-item[^"]*">.*?<span>([^<]+)<\/span><\/a>/g)].map((m) => m[1]);
    expect(nav.slice(0, 4)).toEqual(['Casino', 'Live Casino', 'Cricket', 'Sports']);
  });
});

describe('গেম ফিল্টার (সার্ভার-সাইড)', () => {
  const names = (html) => [...html.matchAll(/<div class="cs-name">([^<]*)<\/div>/g)].map((m) => m[1]);
  const gridPart = (html) => html.slice(html.indexOf('id="allGames"'));

  test('A অক্ষর শুধু A-দিয়ে-শুরু গেম ফেরায়', async () => {
    const res = await request(app).get(`/?provider=${P}&letter=A`);
    const got = names(gridPart(res.text));
    expect(got).toEqual(['Alpha Fortune', 'Apple Spin']);
  });

  test('অক্ষর ছোট হাতের হলেও কাজ করে; অবৈধ অক্ষর উপেক্ষিত (ফিল্টার নেই)', async () => {
    const lower = await request(app).get(`/?provider=${P}&letter=b`);
    expect(names(gridPart(lower.text))).toEqual(['Beta Crash']);
    const junk = await request(app).get(`/?provider=${P}&letter=%E0%A6%AC`); // বাংলা অক্ষর
    expect(junk.status).toBe(200);
    expect(names(gridPart(junk.text))).toEqual(expect.arrayContaining(['Alpha Fortune', 'বাংলা গেম']));
  });

  test('সার্চ ঠিক গেম ফেরায় (ILIKE, % _ লিটারেল)', async () => {
    const res = await request(app).get(`/?provider=${P}&q=spin`);
    expect(names(gridPart(res.text))).toEqual(['Apple Spin']);
    const wild = await request(app).get(`/?provider=${P}&q=%25`);
    expect(names(gridPart(wild.text))).toEqual([]); // % ওয়াইল্ডকার্ড নয়
  });

  test('সব গেম A-Z ক্রমে (ইংরেজি নাম আগে নামের ক্রমে)', async () => {
    const res = await request(app).get(`/?provider=${P}`);
    const got = names(gridPart(res.text)).filter((n) => /^[A-Za-z]/.test(n));
    expect(got).toEqual(['Alpha Fortune', 'Apple Spin', 'Beta Crash']);
  });

  test('প্রোভাইডার ও ক্যাটাগরি ফিল্টার', async () => {
    const byProv = await request(app).get(`/?provider=${P_DOWN}`);
    expect(names(gridPart(byProv.text))).toEqual(['Down Game']);
    const byCat = await request(app).get(`/?category=${CAT_ACTIVE}&provider=${P}&letter=B`);
    expect(names(gridPart(byCat.text))).toEqual(['Beta Crash']);
  });

  test('ফিল্টার সক্রিয় থাকলে খালি ফলে "কোনো গেম নেই" বার্তা', async () => {
    const res = await request(app).get(`/?provider=${P}&q=zzzzzz-nothing`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('cs-empty');
  });

  test('inactive ও admin_disabled গেম কখনো দেখায় না', async () => {
    const res = await request(app).get(`/?provider=${P}`);
    const got = names(gridPart(res.text));
    expect(got).not.toContain('Hidden Inactive');
    expect(got).not.toContain('Hidden Disabled');
  });

  test('খালি ক্যাটাগরি সাইডবারে লুকানো, গেমওয়ালা ক্যাটাগরি দেখায়', async () => {
    const res = await request(app).get('/');
    const side = res.text.slice(res.text.indexOf('class="cs-cats"'), res.text.indexOf('class="cs-top"'));
    expect(side).toContain(`category=${CAT_ACTIVE}`);
    expect(side).not.toContain(CAT_EMPTY);
  });

  test('A-Z ইনডেক্সে শুধু ইংরেজি A-Z অক্ষর, বাংলা নয়', async () => {
    const res = await request(app).get('/');
    const az = res.text.slice(res.text.indexOf('class="cs-az"'));
    const idx = az.slice(0, az.indexOf('</ul>'));
    const letters = [...idx.matchAll(/<li><a [^>]*>([^<]+)<\/a><\/li>/g)].map((m) => m[1]);
    expect(letters.length).toBeGreaterThan(0);
    for (const l of letters) expect(l).toMatch(/^[A-Z]$/); // বাংলা বা অন্য কিছু নয়
    expect(letters).toContain('A');
  });

  test('পেজিনেশন আইডেম্পোটেন্ট: একই URL দুইবার = একই ফল; অবৈধ page = ১', async () => {
    const a = await request(app).get(`/?provider=${P}&page=1`);
    const b = await request(app).get(`/?provider=${P}&page=1`);
    expect(names(gridPart(a.text))).toEqual(names(gridPart(b.text)));
    const bad = await request(app).get(`/?provider=${P}&page=-5`);
    expect(names(gridPart(bad.text))).toEqual(names(gridPart(a.text)));
  });

  test('ফিল্টার সক্রিয় থাকলে ক্যাটাগরি-সারি লুকানো', async () => {
    const res = await request(app).get(`/?provider=${P}`);
    const body = res.text.slice(res.text.indexOf('id="casinoHome"'));
    expect(body).not.toContain('class="cs-h-scroll"');
    const all = await request(app).get('/');
    expect(all.text.slice(all.text.indexOf('id="casinoHome"'))).toContain('class="cs-h-scroll"');
  });
});

describe('গেম লঞ্চ ও আচরণ অপরিবর্তিত', () => {
  test('কার্ডের লিংক লবির লঞ্চ-পথের মতোই /games/launch/:provider/:id', async () => {
    const res = await request(app).get(`/?provider=${P}&letter=A`);
    expect(res.text).toContain('href="/games/launch/HcTestProv/hc-1"');
    expect(res.text).toContain('href="/games/launch/HcTestProv/hc-2"');
  });

  test('লঞ্চ রুট আগের মতোই সাড়া দেয় (অতিথির জন্য রিডাইরেক্ট/অস্বীকার, 404/500 নয়)', async () => {
    const r = await request(app).get('/games/launch/HcTestProv/hc-1');
    expect([301, 302, 303, 307, 401, 403]).toContain(r.status);
  });

  test('লবি /games আগের মতোই 200/302 এবং পুরনো বটম-বার অপরিবর্তিত', async () => {
    const r = await request(app).get('/games');
    expect([200, 302]).toContain(r.status);
    if (r.status === 200) {
      expect(r.text).toContain('<span>আমন্ত্রণ</span>');
      expect(r.text).not.toContain('<span>ওয়ালেট</span>');
    }
  });

  test('হোমের নতুন বটম-বারের সব লিংক আসল রুটে যায়', async () => {
    const res = await request(app).get('/');
    const nav = res.text.slice(res.text.indexOf('id="pubBottomNav"'));
    const hrefs = [...nav.matchAll(/<a href="([^"]+)" class="pub-nav-item/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['/', '/games', '/sports', '/coins', '/profile']);
    for (const href of hrefs) {
      const r = await request(app).get(href);
      expect([200, 302]).toContain(r.status);
    }
  });
});

describe('ম্যাচ সাইডবার — সর্বোচ্চ সীমা', () => {
  test('সার্ভার ডেস্কটপ ৮ ও মোবাইল ৫ সীমা দেয়, ম্যাচ হাব সাইডবারে আছে', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('data-max-desktop="8"');
    expect(res.text).toContain('data-max-mobile="5"');
    expect(res.text).toMatch(/class="cs-matches"[\s\S]*id="homeHub"/);
  });

  function runHub(desktop, total) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'views', 'home-matches.js'), 'utf8');
    class El {
      constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.attrs = {}; this._text = ''; }
      appendChild(c) { this.children.push(c); return c; }
      set textContent(v) { this._text = v; if (v === '') this.children = []; }
      get textContent() { return this._text; }
      getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }
      querySelectorAll() { return []; }
      addEventListener() {}
    }
    const listEl = new El('div');
    const root = new El('section');
    root.attrs = { 'data-max-desktop': '8', 'data-max-mobile': '5' };
    const ids = { homeHub: root, hhList: listEl, hhTabs: new El('div'), hhLeague: new El('select') };
    const matches = Array.from({ length: total }, (_, i) => ({
      id: i + 1, status: 'live', sport: 'cricket', league: 'L', homeTeam: 'A', awayTeam: 'B', date: new Date().toISOString()
    }));
    const ctx = {
      document: { getElementById: (id) => ids[id], createElement: (t) => new El(t) },
      window: { matchMedia: () => ({ matches: desktop }) },
      fetch: () => Promise.resolve({ json: () => Promise.resolve({ success: true, cricket: matches }) }),
      setInterval: () => 0, setTimeout, clearTimeout, Date, Object, Array, parseInt, String, isNaN, encodeURIComponent
    };
    vm.runInNewContext(src, ctx);
    return new Promise((resolve) => setTimeout(() => resolve(listEl.children.filter((c) => c.className === 'hh-row').length), 20));
  }

  test('ডেস্কটপে সর্বোচ্চ ৮টা ম্যাচ-সারি', async () => {
    expect(await runHub(true, 20)).toBe(8);
  });
  test('মোবাইলে সর্বোচ্চ ৫টা ম্যাচ-সারি', async () => {
    expect(await runHub(false, 20)).toBe(5);
  });
  test('সীমার কম ম্যাচ থাকলে সবগুলোই দেখায়', async () => {
    expect(await runHub(true, 3)).toBe(3);
  });
});
