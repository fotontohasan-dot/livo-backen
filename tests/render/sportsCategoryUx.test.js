// tests/render/sportsCategoryUx.test.js
// ---------------------------------------------------------------------------
// স্পোর্টস ক্যাটাগরি-ফার্স্ট UX রিগ্রেশন টেস্ট।
//
// নতুন UX: হোমপেজে কোনো ম্যাচ সরাসরি দেখানো হয় না। ইউজার প্রথমে খেলা বেছে নেয়
// (Football / Cricket), তারপর সেই খেলার Live ও Upcoming ম্যাচ দেখে।
//
// এখানে যা লক করা হচ্ছে:
//   • হোমপেজে লাইভ/আসন্ন ম্যাচের তালিকা রেন্ডার হয় না;
//   • হোমপেজ থেকে Football ও Cricket-এ যাওয়ার পথ আছে (ন্যাভিগেশন ভাঙেনি);
//   • Football পেজ শুধু football, Cricket পেজ শুধু cricket ফিল্টার করে;
//   • দুই পেজেই Live ও Upcoming — দুটো আলাদা সেকশন এবং খালি অবস্থা আছে;
//   • 'finished' ম্যাচ আর "আসন্ন" তালিকায় ঢোকে না;
//   • Popular Games ও বড় প্রোমোশনাল হিরো ব্যানার হোমপেজে নেই।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../../app');
const { pool } = require('../../db');
const { upsertMatch } = require('../../services/matchUpdater');

const matchesView = fs.readFileSync(
  path.join(__dirname, '..', '..', 'views', 'matches.ejs'), 'utf8'
);

describe('হোমপেজ — ম্যাচ আর সরাসরি দেখানো হয় না', () => {
  let html;

  beforeAll(async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    html = res.text;
  });

  test('লাইভ ম্যাচের তালিকা হোমপেজে নেই', () => {
    expect(html).not.toContain('homeSportsRail');
    expect(html).not.toContain('id="homeSports"');
    expect(html).not.toContain("fetch('/matches/api/live'");
  });

  test('আসন্ন ম্যাচের কোনো সেকশন হোমপেজে নেই', () => {
    expect(html).not.toContain('id="upcomingList"');
    expect(html).not.toContain('id="liveList"');
  });

  test('Popular Games সেকশন সরানো হয়েছে', () => {
    expect(html).not.toContain('Popular Games');
    expect(html).not.toContain('popularGamesRow');
    expect(html).not.toContain('popular-games-scroll');
  });

  test('বড় প্রোমোশনাল হিরো ব্যানার সরানো হয়েছে', () => {
    expect(html).not.toContain('hero-section');
    expect(html).not.toContain('hero-heading');
    expect(html).not.toContain('hero-cta-row');
    expect(html).not.toContain('জন এখন অনলাইনে খেলছেন'); // হিরোর লাইভ-কাউন্ট ব্যাজ

    // দ্রষ্টব্য: <title> ও og:title-এ "…প্রেডিকশন ও ক্যাসিনো প্ল্যাটফর্ম" থেকে যায় —
    // সেটা সাইটের ব্র্যান্ডিং/SEO মেটাডেটা, হিরো ব্যানার নয়। তাই শুধু <body>-তে
    // ওই হেডলাইনটা আছে কি না দেখা হচ্ছে।
    const body = html.slice(html.indexOf('</head>'));
    expect(body).not.toContain('প্রেডিকশন ও ক্যাসিনো প্ল্যাটফর্ম');
  });

  test('গেম গ্রিড ও ক্যাটাগরি ট্যাব আগের মতোই আছে (গেম দুর্গম হয়ে যায়নি)', () => {
    expect(html).toContain('id="categoryTabs"');
    expect(html).toContain('id="gameContainer"');
  });
});

describe('হোমপেজ থেকে খেলা নির্বাচন করা যায়', () => {
  test('Football ও Cricket-এ যাওয়ার লিংক হোমপেজে আছে', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('href="/matches/football"');
    expect(res.text).toContain('href="/matches/cricket"');
    expect(res.text).toContain('<span>ফুটবল</span>');
    expect(res.text).toContain('<span>ক্রিকেট</span>');
  });

  test('বটম নেভে স্পোর্টস এন্ট্রি এখনো আছে', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('href="/sports"');
  });
});

describe('Football ও Cricket পেজ', () => {
  test('Football পেজ শুধু football ফিল্টার করে', async () => {
    const res = await request(app).get('/matches/football');
    expect(res.status).toBe(200);
    expect(res.text).toContain("const CURRENT_SPORT = 'football'");
    // ক্লায়েন্ট-সাইড ফিল্টার: football হলে শুধু data.football নেওয়া হয়
    expect(res.text).toMatch(/CURRENT_SPORT === 'football'\) all = all\.concat\(data\.football/);
  });

  test('Cricket পেজ শুধু cricket ফিল্টার করে', async () => {
    const res = await request(app).get('/matches/cricket');
    expect(res.status).toBe(200);
    expect(res.text).toContain("const CURRENT_SPORT = 'cricket'");
    expect(res.text).toMatch(/CURRENT_SPORT === 'cricket'\) all = all\.concat\(data\.cricket/);
  });

  test('/sports/cricket-ও একই ফিল্টার নিয়ে রেন্ডার হয়', async () => {
    const res = await request(app).get('/sports/cricket');
    expect(res.status).toBe(200);
    expect(res.text).toContain("const CURRENT_SPORT = 'cricket'");
  });

  test('দুই পেজেই Live ও Upcoming আলাদা সেকশন আছে', async () => {
    for (const url of ['/matches/football', '/matches/cricket']) {
      const res = await request(app).get(url);
      expect(res.text).toContain('id="liveSection"');
      expect(res.text).toContain('id="upcomingSection"');
      expect(res.text).toContain('id="liveList"');
      expect(res.text).toContain('id="upcomingList"');
    }
  });

  test('ম্যাচ না থাকলে খালি অবস্থা দেখানোর ব্যবস্থা আছে', async () => {
    const res = await request(app).get('/matches/football');
    expect(res.text).toContain('id="emptyState"');
  });

  test('ম্যাচ কার্ড থেকে বিদ্যমান ম্যাচ পেজে যাওয়া যায়', async () => {
    const res = await request(app).get('/matches/cricket');
    expect(res.text).toContain('/matches/${m.id}');
  });
});

describe('live / upcoming / finished শ্রেণিবিন্যাস', () => {
  test("'finished' ম্যাচ আসন্ন তালিকায় ঢোকে না", () => {
    // আগে শুধু 'live' খোঁজা হতো আর বাকি সব upcoming ধরা হতো — শেষ হওয়া ম্যাচও
    // "আসন্ন" হিসেবে দেখাত। এখন তিনটা স্ট্যাটাসই আলাদা করা হয়।
    expect(matchesView).toMatch(/status === 'finished'/);
    const renderFn = matchesView.slice(
      matchesView.indexOf('function renderMatches'),
      matchesView.indexOf('// Live section')
    );
    expect(renderFn).toContain("status === 'live'");
    expect(renderFn).toContain("status === 'finished'");
  });

  test('ডাটাবেজের স্ট্যাটাস মান তিনটাই — নতুন কনভেনশন তৈরি হয়নি', () => {
    const { VALID_STATUSES } = require('../../services/providers/normalizedMatch');
    expect(VALID_STATUSES).toEqual(['live', 'upcoming', 'finished']);
  });
});

describe('API ফিল্টারিং — আসল ডেটা দিয়ে', () => {
  const P = 'test-uxprovider';

  afterEach(async () => {
    await pool.query('DELETE FROM matches WHERE provider = $1', [P]);
  });

  test('/matches/api/live ফুটবল ও ক্রিকেট আলাদা করে ফেরত দেয়', async () => {
    await upsertMatch({
      provider: P, externalId: 'ux-fb', sport: 'football', title: 'Real vs Barca',
      teamA: 'Real', teamB: 'Barca', status: 'live', scoreA: '2', scoreB: '1',
      overs: null, league: 'La Liga', startTime: null, metadata: null
    });
    await upsertMatch({
      provider: P, externalId: 'ux-ck', sport: 'cricket', title: 'IND vs AUS',
      teamA: 'India', teamB: 'Australia', status: 'upcoming', scoreA: null, scoreB: null,
      overs: null, league: null, startTime: null, metadata: null
    });

    const res = await request(app).get('/matches/api/live');
    expect(res.status).toBe(200);

    const fb = res.body.football.find((m) => m.teams.includes('Real'));
    const ck = res.body.cricket.find((m) => m.teams.includes('India'));

    expect(fb).toBeDefined();
    expect(ck).toBeDefined();
    // ক্রস-কন্টামিনেশন নেই — ফুটবল তালিকায় ক্রিকেট নেই এবং উল্টোটাও
    expect(res.body.football.some((m) => m.teams.includes('India'))).toBe(false);
    expect(res.body.cricket.some((m) => m.teams.includes('Real'))).toBe(false);

    expect(fb.status).toBe('live');
    expect(ck.status).toBe('upcoming');
  });
});
