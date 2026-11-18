// tests/render/homeCasinoFirst.test.js
// ক্যাসিনো-প্রথম হোম: রেন্ডার (লগইন করা/না-করা/ক্যাসিনো-বন্ধ), ন্যাভ ক্রম, সার্ভার-সাইড ফিল্টার
// (A-Z, সার্চ, ক্যাটাগরি, প্রোভাইডার), খালি ক্যাটাগরি লুকানো, ম্যাচ সাইডবারের সীমা, গেম লঞ্চ-পথ অপরিবর্তিত।

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const cache = require('../../services/cache');
const autoSuspend = require('../../services/autoSuspend');
const homeCasino = require('../../services/homeCasino');

const PROV = 'HCFTestProv';
const PROV2 = 'HCFTestProvTwo';
const SUSP = 'HCFSuspendedProv';
const CAT_A = 'hcf_slots';
const CAT_B = 'hcf_live';
const CAT_EMPTY = 'hcf_emptycat';

const seed = [
  ['Alpha Fortune', CAT_A, PROV, 'a1'],
  ['Apple Spin', CAT_A, PROV, 'a2'],
  ['Banana Bonanza', CAT_A, PROV2, 'b1'],
  ['Zeus Thunder', CAT_B, PROV2, 'z1'],
  ['আলফা বাংলা গেম', CAT_B, PROV, 'bn1'],
  ['Suspended Slot', CAT_A, SUSP, 's1'],
];

async function clearCaches() {
  for (const k of ['home:casino:facets', 'home:casino:rails', 'home:casino:banners']) await cache.del(k).catch(() => {});
}

beforeAll(async () => {
  for (const [name, category, provider, gid] of seed) {
    await pool.query(
      `INSERT INTO games (name, slug, category, provider, provider_game_id, is_active, admin_disabled)
       VALUES ($1, $2, $3, $4, $5, true, false)
       ON CONFLICT (slug) DO NOTHING`,
      [name, `hcf-${gid}`, category, provider, gid]
    );
  }
  // খালি ক্যাটাগরি: শুধু নিষ্ক্রিয় গেম আছে, তাই লুকাতে হবে
  await pool.query(
    `INSERT INTO games (name, slug, category, provider, provider_game_id, is_active, admin_disabled)
     VALUES ('Hidden Game', 'hcf-hidden', $1, $2, 'h1', false, false) ON CONFLICT (slug) DO NOTHING`,
    [CAT_EMPTY, PROV]
  );
  await clearCaches();
});

afterAll(async () => {
  await autoSuspend.manualResume(`casino:${SUSP}`).catch(() => {});
  await pool.query(`DELETE FROM games WHERE slug LIKE 'hcf-%'`);
  await clearCaches();
});

describe('হোম রেন্ডার', () => {
  test('লগইন ছাড়া 200', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="categoryTabs"');
    expect(res.text).toContain('id="gameContainer"');
  });

  test('লগইন করা অবস্থায় 200', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername('hc');
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
      .send({ username, phone: uniquePhone(), password: 'HomeCasino123', confirmPassword: 'HomeCasino123', _csrf: token });
    const res = await agent.get('/').set('User-Agent', REALISTIC_UA);
    expect(res.status).toBe(200);
    await pool.query('DELETE FROM users WHERE username = $1', [username]).catch(() => {});
  });

  test('ক্যাসিনো-বন্ধ (প্রোভাইডার সাসপেন্ড) অবস্থায় 200 এবং "সাময়িকভাবে বন্ধ" আচরণ আগের মতো', async () => {
    await autoSuspend.manualSuspend(`casino:${SUSP}`, { reason: 'test' });
    const res = await request(app).get('/?q=Suspended');
    expect(res.status).toBe(200);
    expect(res.text).toContain('hc-suspended');
    expect(res.text).toContain('সাময়িকভাবে বন্ধ');
    // সাসপেন্ড গেমে কোনো লঞ্চ-লিংক নেই
    expect(res.text).not.toContain(`/games/launch/${SUSP}/s1`);
    await autoSuspend.manualResume(`casino:${SUSP}`);
  });

  test('গেম-ডেটা ব্যর্থ হলেও হোম 500 দেয় না', async () => {
    const spy = jest.spyOn(pool, 'query');
    spy.mockImplementation(async (sql, ...rest) => {
      if (typeof sql === 'string' && /FROM games/.test(sql)) throw new Error('boom');
      return spy.getMockImplementation && jest.requireActual('../../db').pool.query.call(pool, sql, ...rest);
    });
    await clearCaches();
    const out = await homeCasino.getHomeCasino({});
    spy.mockRestore();
    expect(out.page.games).toEqual([]);
    expect(out.facets.categories).toEqual([]);
    await clearCaches();
  });
});

describe('ন্যাভ ক্রম', () => {
  test('ক্যাসিনো, লাইভ ক্যাসিনো, ক্রিকেট, স্পোর্টস — তারপর বাকি ট্যাব', async () => {
    const res = await request(app).get('/');
    const nav = res.text.slice(res.text.indexOf('class="main-cat-nav"'));
    const labels = [...nav.slice(0, nav.indexOf('</nav>')).matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels.slice(0, 4)).toEqual(['ক্যাসিনো', 'লাইভ ক্যাসিনো', 'ক্রিকেট', 'স্পোর্টস']);
    expect(labels).toEqual(expect.arrayContaining(['ফুটবল', 'লাইভ ম্যাচ', 'টুর্নামেন্ট', 'লিডারবোর্ড', 'প্রমোশন']));
  });

  test('বটম-বার: হোম, ক্যাসিনো, স্পোর্টস, ওয়ালেট, প্রোফাইল (ক্রমে) এবং সব লিংক বৈধ', async () => {
    const res = await request(app).get('/');
    const nav = res.text.slice(res.text.indexOf('id="pubBottomNav"'));
    const labels = [...nav.slice(0, nav.indexOf('</nav>')).matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(['হোম', 'ক্যাসিনো', 'স্পোর্টস', 'ওয়ালেট', 'প্রোফাইল']);
    const hrefs = [...nav.matchAll(/<a href="([^"]+)" class="pub-nav-item/g)].map((m) => m[1]);
    for (const h of hrefs) expect([200, 302]).toContain((await request(app).get(h)).status);
  });
});

describe('সার্ভার-সাইড ফিল্টার', () => {
  const names = (html) => {
    const grid = html.slice(html.indexOf('id="gameContainer"'));
    return [...grid.slice(0, grid.indexOf('</section>')).matchAll(/class="hc-name">([^<]+)</g)].map((m) => m[1]);
  };

  test('A-Z অক্ষর ফিল্টার ঠিক গেম ফেরায় (শুধু ইংরেজি প্রথম অক্ষর)', async () => {
    const res = await request(app).get('/?letter=A');
    expect(names(res.text).filter((n) => /^(Alpha|Apple)/.test(n)).sort()).toEqual(['Alpha Fortune', 'Apple Spin']);
    expect(names(res.text).every((n) => n.toUpperCase().startsWith('A'))).toBe(true);
    expect(names(res.text)).not.toContain('Banana Bonanza');
  });

  test('বাংলা বা অবৈধ অক্ষর উপেক্ষিত — কোনো ফিল্টার প্রযোজ্য হয় না', async () => {
    expect(homeCasino.parseHomeQuery({ letter: 'আ' }).letter).toBe('');
    expect(homeCasino.parseHomeQuery({ letter: '1' }).letter).toBe('');
    expect(homeCasino.parseHomeQuery({ letter: 'z' }).letter).toBe('Z');
    const res = await request(app).get('/?letter=%E0%A6%86');
    expect(res.status).toBe(200);
  });

  test('সার্চ ঠিক গেম ফেরায়; % ও _ ওয়াইল্ডকার্ড নয়', async () => {
    const res = await request(app).get('/?q=zeus');
    expect(names(res.text)).toEqual(['Zeus Thunder']);
    const wild = await request(app).get('/?q=%25');
    expect(names(wild.text)).toEqual([]);
  });

  test('ক্যাটাগরি ও প্রোভাইডার ফিল্টার', async () => {
    const c = await request(app).get(`/?cat=${CAT_B}`);
    expect(names(c.text).sort()).toEqual(['Zeus Thunder', 'আলফা বাংলা গেম'].sort());
    const p = await request(app).get(`/?cat=${CAT_A}&provider=${PROV2}`);
    expect(names(p.text)).toEqual(['Banana Bonanza']);
  });

  test('খালি ক্যাটাগরি (শুধু নিষ্ক্রিয় গেম) সাইডবারে নেই', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain(`href="/?cat=${CAT_A}#casino"`);
    expect(res.text).not.toContain(CAT_EMPTY);
  });

  test('সব গেম A-Z ক্রমে এবং পেজিনেশন লিংক আইডেম্পোটেন্ট (GET)', async () => {
    const res = await request(app).get('/');
    const list = names(res.text);
    const sorted = [...list].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    expect(list.length).toBeGreaterThan(0);
    expect(list.slice(0, 3).map((n) => n[0])).toEqual(sorted.slice(0, 3).map((n) => n[0]));
    const again = await request(app).get('/');
    expect(names(again.text)).toEqual(list);
  });
});

describe('ম্যাচ সাইডবার ও লঞ্চ', () => {
  test('সর্বোচ্চ সীমা ≤ ৮ — ভিউতে data-max এবং JS দুটোই মানে', async () => {
    const res = await request(app).get('/');
    const m = res.text.match(/id="homeHub" data-max="(\d+)"/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeLessThanOrEqual(8);
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/views/home-matches.js'), 'utf8');
    expect(js).toMatch(/Math\.min\([^;]*data-max[^;]*8\)/s);
    expect(js).toContain('rows.slice(0, MAX_ROWS)');
  });

  test('ম্যাচ ডেটা এন্ডপয়েন্ট ও ক্লিক-পথ অপরিবর্তিত', async () => {
    const res = await request(app).get('/matches/api/live');
    expect(res.status).toBe(200);
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/views/home-matches.js'), 'utf8');
    expect(js).toContain("fetch('/matches/api/live'");
  });

  test('গেম লঞ্চ-লিংক আগের পথেই; লগইন ছাড়া লঞ্চ লগইনে পাঠায়', async () => {
    const res = await request(app).get('/?letter=A');
    expect(res.text).toContain(`href="/games/launch/${PROV}/a1"`);
    const launch = await request(app).get(`/games/launch/${PROV}/a1`);
    expect([302, 401, 403]).toContain(launch.status);
  });
});
