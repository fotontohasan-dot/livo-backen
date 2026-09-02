// tests/render/sharedBetEngine.test.js
// ---------------------------------------------------------------------------
// LIVO-05 রিগ্রেশন — শেয়ার্ড বাজি ইঞ্জিন (views/games/play.ejs-এর placeBet/recordWin)।
//
// প্রায় ১২০টা গেম ভিউ এই দুটো হেল্পারের উপর নির্ভর করে, তাই এদের ত্রুটি একটা নয়
// — একশোর বেশি গেমে একসাথে দেখা দেয়। দুটো প্রমাণিত ত্রুটি ছিল:
//
//   ১) HTTP ত্রুটি গিলে ফেলা। `response.json()` সরাসরি ডাকা হতো। ৪২৯-এ
//      express-rate-limit v7 প্লেইন টেক্সট পাঠায়, ৫০০-তে HTML এরর পেজ আসতে পারে —
//      দুটোতেই json() থrows করে, catch ব্লক নীরবে false ফেরত দেয়। ইউজার কোনো
//      বার্তাই দেখত না, শুধু বাটন কাজ করছে না মনে হতো।
//      আর যেসব রেসপন্সে `{ error: ... }` থাকে (message নয়), সেখানে
//      `alert(data.message)` আক্ষরিক "undefined" দেখাত।
//
//   ২) সর্বনিম্ন বাজির অমিল। ইনপুটের ডিফল্ট ছিল value="1" min="1", অথচ
//      সার্ভারের min_bet ১০। ডিফল্ট মেনে বাজি ধরলেই ৪০০ ফিরত।
//
// এই টেস্ট রেন্ডার করা পেজ থেকে আসল স্ক্রিপ্টটা বের করে vm-এ চালায় এবং
// stub করা fetch দিয়ে প্রতিটা স্ট্যাটাস যাচাই করে — সোর্সে টেক্সট খোঁজা নয়,
// সত্যিকারের আচরণ পরীক্ষা।
// ---------------------------------------------------------------------------

const vm = require('vm');
const { getCsrfAgent, uniqueUsername, uniquePhone } = require('../helpers/app');
const { pool } = require('../../db');
const { getSetting } = require('../../services/settings');

async function renderGamePage(slug = 'slots') {
  const { agent, token } = await getCsrfAgent('/register');
  await agent.post('/register').type('form').send({
    username: uniqueUsername(),
    phone: uniquePhone(),
    password: 'SecurePass123',
    confirmPassword: 'SecurePass123',
    _csrf: token
  });
  const page = await agent.get(`/games/${slug}`);
  return page.text;
}

// রেন্ডার করা HTML থেকে যে <script> ব্লকে placeBet সংজ্ঞায়িত, সেটাই বের করি
function extractEngine(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = blocks.find((b) => /function placeBet/.test(b));
  if (!src) throw new Error('placeBet স্ক্রিপ্ট রেন্ডার করা পেজে পাওয়া যায়নি');
  return src;
}

// vm-এ চালানোর জন্য ন্যূনতম ব্রাউজার পরিবেশ
function makeSandbox(fetchImpl) {
  const alerts = [];
  const el = () => ({
    innerText: '', value: '10', disabled: false,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, focus() {}, setAttribute() {}, getAttribute() { return null; }
  });
  const ctx = {
    fetch: fetchImpl,
    alert: (m) => alerts.push(m),
    console: { error() {}, log() {} },
    document: { getElementById: el, querySelectorAll: () => [] },
    setTimeout,
    window: {}
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  return { ctx, alerts };
}

function jsonResponse(status, body, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    json: async () => {
      if (contentType !== 'application/json') throw new SyntaxError('Unexpected token');
      return body;
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

describe('LIVO-05 — শেয়ার্ড বাজি ইঞ্জিনের HTTP আচরণ', () => {
  jest.setTimeout(60000);
  let engineSrc;

  beforeAll(async () => { engineSrc = extractEngine(await renderGamePage('slots')); });

  async function run(fetchImpl, fn) {
    const { ctx, alerts } = makeSandbox(fetchImpl);
    vm.runInContext(engineSrc, ctx);
    const result = await fn(ctx);
    return { result, alerts, ctx };
  }

  test('২০০ সফল — ডেটা ফেরত দেয়, কোনো alert নয়', async () => {
    const { result, alerts } = await run(
      async () => jsonResponse(200, { success: true, newBalance: 990, winAmount: 0 }),
      (ctx) => ctx.placeBet(10)
    );
    expect(result).toBeTruthy();
    expect(result.success).toBe(true);
    expect(alerts).toHaveLength(0);
  });

  test('৪০০ — সার্ভারের নিজের বার্তাই দেখায়', async () => {
    const { result, alerts } = await run(
      async () => jsonResponse(400, { success: false, message: 'সর্বনিম্ন বাজি ১০' }),
      (ctx) => ctx.placeBet(1)
    );
    expect(result).toBe(false);
    expect(alerts[0]).toBe('সর্বনিম্ন বাজি ১০');
  });

  test('৪২৯ প্লেইন টেক্সট — নীরবে গিলে ফেলে না, রেট-লিমিট বার্তা দেখায়', async () => {
    // express-rate-limit v7 ডিফল্টে text/plain পাঠায় — json() এখানে throw করে
    const { result, alerts } = await run(
      async () => jsonResponse(429, 'Too many requests', 'text/plain'),
      (ctx) => ctx.placeBet(10)
    );
    expect(result).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBeTruthy();
    expect(String(alerts[0])).not.toMatch(/undefined/);
  });

  test('৪০১/৪০৩ — সেশন-সংক্রান্ত বার্তা, "undefined" নয়', async () => {
    for (const status of [401, 403]) {
      const { result, alerts } = await run(
        async () => jsonResponse(status, { success: false, error: 'Forbidden' }),
        (ctx) => ctx.placeBet(10)
      );
      expect(result).toBe(false);
      expect(alerts).toHaveLength(1);
      expect(String(alerts[0])).not.toMatch(/undefined/);
      expect(String(alerts[0]).length).toBeGreaterThan(3);
    }
  });

  test('৫০০ HTML এরর পেজ — পার্সে ক্র্যাশ করে না, বার্তা দেখায়', async () => {
    const { result, alerts } = await run(
      async () => jsonResponse(500, '<html><body>Internal Server Error</body></html>', 'text/html'),
      (ctx) => ctx.placeBet(10)
    );
    expect(result).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0])).not.toMatch(/undefined|<html|Internal Server Error/);
  });

  test('নেটওয়ার্ক ব্যর্থতা — পরিষ্কার বার্তা দেয়', async () => {
    const { result, alerts } = await run(
      async () => { throw new TypeError('Failed to fetch'); },
      (ctx) => ctx.placeBet(10)
    );
    expect(result).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0])).not.toMatch(/undefined|Failed to fetch/);
  });

  test('ভাঙা JSON বডি — ক্র্যাশ করে না', async () => {
    const { result, alerts } = await run(
      async () => ({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
        text: async () => '{'
      }),
      (ctx) => ctx.placeBet(10)
    );
    expect(result).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0])).not.toMatch(/undefined|SyntaxError/);
  });

  test('`{ error: ... }` আকারের বডিতেও "undefined" দেখায় না', async () => {
    const { alerts } = await run(
      async () => jsonResponse(400, { success: false, error: 'Bad request' }),
      (ctx) => ctx.placeBet(10)
    );
    expect(String(alerts[0])).not.toMatch(/undefined/);
  });

  test('কলার HTTP স্ট্যাটাস আলাদা করতে পারে', async () => {
    for (const status of [400, 401, 403, 429, 500]) {
      const { ctx } = await run(
        async () => jsonResponse(status, { success: false, message: 'x' }),
        (c) => c.placeBet(10)
      );
      expect(ctx.window.lastBetError).toBeTruthy();
      expect(ctx.window.lastBetError.status).toBe(status);
    }
    // নেটওয়ার্ক ব্যর্থতায় status 0
    const { ctx } = await run(
      async () => { throw new TypeError('Failed to fetch'); },
      (c) => c.placeBet(10)
    );
    expect(ctx.window.lastBetError.status).toBe(0);
  });

  test('recordWin-ও একই ত্রুটি-ব্যবস্থাপনা মানে', async () => {
    const { result, alerts } = await run(
      async () => jsonResponse(429, 'Too many requests', 'text/plain'),
      (ctx) => ctx.recordWin(2.0)
    );
    expect(result).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0])).not.toMatch(/undefined/);
  });
});

describe('LIVO-05 — বাজির ইনপুট সার্ভারের সীমার সঙ্গে সঙ্গতিপূর্ণ', () => {
  jest.setTimeout(60000);

  test('ইনপুটের min/value/max সার্ভারের min_bet/max_bet মেনে চলে', async () => {
    const html = await renderGamePage('slots');
    const minBet = Number(await getSetting('min_bet'));
    const maxBet = Number(await getSetting('max_bet'));

    const input = /<input[^>]*id="betAmount"[^>]*>/.exec(html);
    expect(input).toBeTruthy();
    const tag = input[0];

    // আগে হার্ডকোড করা ছিল value="1" min="1" — সার্ভারের ন্যূনতম ১০-এর সঙ্গে অমিল,
    // ফলে ডিফল্ট মেনে বাজি ধরলেই ৪০০ ফিরত।
    expect(tag).toContain(`min="${minBet}"`);
    expect(tag).toContain(`value="${minBet}"`);
    expect(tag).toContain(`max="${maxBet}"`);
  });

  test('ডিফল্ট মান দিয়ে বাজি ধরলে সার্ভার গ্রহণ করে', async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').type('form').send({
      username, phone: uniquePhone(),
      password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token
    });
    const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    await pool.query('UPDATE users SET coins = 100000 WHERE id = $1', [r.rows[0].id]);

    const page = await agent.get('/games/slots');
    const csrf = (/<meta name="csrf-token" content="([^"]*)"/.exec(page.text) || [])[1];
    const defaultValue = Number(/<input[^>]*id="betAmount"[^>]*value="(\d+)"/.exec(page.text)[1]);

    const bet = await agent.post('/games/play').set('X-CSRF-Token', csrf)
      .send({ gameSlug: 'slots', amount: defaultValue });
    expect(bet.status).toBe(200);
    expect(bet.body.success).toBe(true);
  });
});
