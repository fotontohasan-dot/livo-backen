// tests/withdrawalWindow.test.js
// ---------------------------------------------------------------------------
// উইথড্র সময়সূচি।
//
// যে ঝুঁকিগুলো এখানে লক করা হচ্ছে:
//   • বন্ধ সময়ে সার্ভার যেন সত্যিই রিকোয়েস্ট ফিরিয়ে দেয় (ফর্ম লুকানো যথেষ্ট নয়);
//   • মধ্যরাত পেরোনো জানালা (২৩:০০ → ০৭:০০) যেন ঠিকভাবে গোনা হয়;
//   • সার্ভার UTC-তে চললেও হিসাব যেন ঢাকার সময় ধরে হয়;
//   • সেটিংস পড়া না গেলে যেন fail-open হয় — DB হেঁচকিতে ইউজারের টাকা আটকে না যায়;
//   • ডিপোজিট ও বিদ্যমান উইথড্র রিকোয়েস্টে যেন কোনো প্রভাব না পড়ে।
// ---------------------------------------------------------------------------

const { getCsrfAgent, freshRequest, uniqueUsername, uniquePhone, REALISTIC_UA, extractCsrfToken } = require('./helpers/app');
const { cleanupUsers } = require('./helpers/cleanup');
const { pool } = require('../db');
const withdrawalWindow = require('../services/withdrawalWindow');

const createdUserIds = [];

async function makeUser(prefix) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername(prefix);
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  const id = r.rows[0] && r.rows[0].id;
  if (id) createdUserIds.push(id);
  return { agent, username, id };
}

async function setConfig(cfg) {
  const result = await withdrawalWindow.saveConfig(cfg);
  expect(result.ok).toBe(true);
}

async function resetConfig() {
  await pool.query('DELETE FROM site_settings WHERE key = ANY($1)', [Object.values(withdrawalWindow.KEYS)]);
}

// একটা নির্দিষ্ট ঢাকা-সময়ে UTC মুহূর্ত। ঢাকা UTC+6, DST নেই।
function dhaka(hh, mm = 0) {
  return new Date(Date.UTC(2026, 8, 15, hh - 6, mm, 0));
}

afterEach(resetConfig);

afterAll(async () => {
  await resetConfig();
  await cleanupUsers(createdUserIds);
});

// ==================== সময় গণনা ====================
describe('সময়সূচি গণনা (২৩:০০ → ০৭:০০)', () => {
  beforeEach(() => setConfig({ mode: 'auto', start: '23:00', end: '07:00', timezone: 'Asia/Dhaka' }));

  test.each([
    ['রাত ১১:০০ — ঠিক বন্ধের মুহূর্ত', 23, 0, false],
    ['রাত ১১:৩০', 23, 30, false],
    ['রাত ২টা — মধ্যরাত পেরিয়ে', 2, 0, false],
    ['ভোর ৬:৫৯ — খোলার এক মিনিট আগে', 6, 59, false],
    ['সকাল ৭:০০ — ঠিক খোলার মুহূর্ত', 7, 0, true],
    ['সকাল ১০টা', 10, 0, true],
    ['রাত ১০:৫৯ — বন্ধের এক মিনিট আগে', 22, 59, true]
  ])('%s', async (_label, hh, mm, expectedOpen) => {
    const state = await withdrawalWindow.getState(dhaka(hh, mm));
    expect(state.open).toBe(expectedOpen);
  });

  test('বন্ধ থাকলে কখন খুলবে সেটা জানানো হয়', async () => {
    const state = await withdrawalWindow.getState(dhaka(1, 0));
    expect(state.open).toBe(false);
    expect(state.reason).toBe('scheduled_closed');
    expect(state.reopensAtText).toBe('07:00');
  });

  test('হিসাব সার্ভারের লোকাল সময়ে নয়, নির্ধারিত টাইমজোনে হয়', async () => {
    // UTC-তে তখন ২০:০০ (খোলা থাকার কথা), কিন্তু ঢাকায় ০২:০০ — বন্ধ।
    const at = dhaka(2, 0);
    expect(at.getUTCHours()).toBe(20);
    const state = await withdrawalWindow.getState(at);
    expect(state.open).toBe(false);
  });
});

describe('অন্যান্য সময়সূচি', () => {
  test('একই দিনের ভেতরের জানালা (০১:০০ → ০৫:০০)', async () => {
    await setConfig({ mode: 'auto', start: '01:00', end: '05:00', timezone: 'Asia/Dhaka' });
    expect((await withdrawalWindow.getState(dhaka(3))).open).toBe(false);
    expect((await withdrawalWindow.getState(dhaka(6))).open).toBe(true);
    expect((await withdrawalWindow.getState(dhaka(23))).open).toBe(true);
  });

  test('শুরু ও শেষ এক হলে কোনো বন্ধ সময় থাকে না', async () => {
    await setConfig({ mode: 'auto', start: '00:00', end: '00:00', timezone: 'Asia/Dhaka' });
    for (const h of [0, 6, 12, 23]) {
      expect((await withdrawalWindow.getState(dhaka(h))).open).toBe(true);
    }
  });
});

// ==================== ম্যানুয়াল ওভাররাইড ====================
describe('ম্যানুয়াল ওভাররাইড', () => {
  test('জোর করে খোলা — বন্ধের সময়েও খোলা থাকে', async () => {
    await setConfig({ mode: 'open', start: '23:00', end: '07:00', timezone: 'Asia/Dhaka' });
    const state = await withdrawalWindow.getState(dhaka(2));
    expect(state.open).toBe(true);
    expect(state.reason).toBe('forced_open');
  });

  test('জোর করে বন্ধ — খোলার সময়েও বন্ধ থাকে', async () => {
    await setConfig({ mode: 'closed', start: '23:00', end: '07:00', timezone: 'Asia/Dhaka' });
    const state = await withdrawalWindow.getState(dhaka(12));
    expect(state.open).toBe(false);
    expect(state.reason).toBe('forced_closed');
  });

  test('অটোতে ফিরিয়ে দিলে আবার সময়সূচি অনুযায়ী চলে', async () => {
    await setConfig({ mode: 'closed' });
    expect((await withdrawalWindow.getState(dhaka(12))).open).toBe(false);
    await setConfig({ mode: 'auto' });
    expect((await withdrawalWindow.getState(dhaka(12))).open).toBe(true);
    expect((await withdrawalWindow.getState(dhaka(2))).open).toBe(false);
  });
});

// ==================== ভ্যালিডেশন ও ডিফল্ট ====================
describe('ভ্যালিডেশন ও ডিফল্ট', () => {
  test('কিছু সেট না থাকলে ডিফল্ট ২৩:০০–০৭:০০ Asia/Dhaka', async () => {
    const cfg = await withdrawalWindow.readConfig();
    expect(cfg.mode).toBe('auto');
    expect(cfg.start.text).toBe('23:00');
    expect(cfg.end.text).toBe('07:00');
    expect(cfg.timezone).toBe('Asia/Dhaka');
  });

  test('অবৈধ ইনপুট গ্রহণ করা হয় না এবং আগের মান অক্ষত থাকে', async () => {
    await setConfig({ mode: 'auto', start: '23:00', end: '07:00', timezone: 'Asia/Dhaka' });
    for (const bad of [{ mode: 'sometimes' }, { start: '25:00' }, { end: '7' }, { timezone: 'Mars/Olympus' }]) {
      const res = await withdrawalWindow.saveConfig(bad);
      expect(res.ok).toBe(false);
    }
    const cfg = await withdrawalWindow.readConfig();
    expect(cfg.mode).toBe('auto');
    expect(cfg.start.text).toBe('23:00');
    expect(cfg.timezone).toBe('Asia/Dhaka');
  });

  test('ডাটাবেসে আবর্জনা থাকলেও ডিফল্টে ফিরে যায়, ক্র্যাশ করে না', async () => {
    for (const [k, v] of [[withdrawalWindow.KEYS.mode, 'nonsense'], [withdrawalWindow.KEYS.start, 'abc'], [withdrawalWindow.KEYS.timezone, '???']]) {
      await pool.query(
        `INSERT INTO site_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]
      );
    }
    const state = await withdrawalWindow.getState(dhaka(12));
    expect(state.open).toBe(true);
    expect(state.timezone).toBe('Asia/Dhaka');
  });
});

// ==================== আসল রুটে প্রয়োগ ====================
describe('উইথড্র রুট', () => {
  test('বন্ধ থাকলে POST /payment/withdraw গৃহীত হয় না এবং কোনো রিকোয়েস্ট তৈরি হয় না', async () => {
    await setConfig({ mode: 'closed' });
    const user = await makeUser('wwpost');
    await pool.query('UPDATE users SET coins = 5000 WHERE id = $1', [user.id]);
    const before = await pool.query("SELECT COUNT(*)::int AS c FROM payment_requests WHERE user_id = $1", [user.id]);

    const page = await user.agent.get('/payment/withdraw');
    const res = await user.agent.post('/payment/withdraw').type('form').send({
      method: 'bkash', account_number: '01712345678', amount: 500,
      _csrf: extractCsrfToken(page.text)
    });
    expect(res.status).not.toBe(200);

    const after = await pool.query("SELECT COUNT(*)::int AS c FROM payment_requests WHERE user_id = $1", [user.id]);
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  test('বন্ধ থাকলেও ব্যালেন্স অপরিবর্তিত থাকে', async () => {
    await setConfig({ mode: 'closed' });
    const user = await makeUser('wwbal');
    await pool.query('UPDATE users SET coins = 5000 WHERE id = $1', [user.id]);
    const page = await user.agent.get('/payment/withdraw');
    await user.agent.post('/payment/withdraw').type('form').send({
      method: 'bkash', account_number: '01712345678', amount: 500,
      _csrf: extractCsrfToken(page.text)
    });
    const coins = await pool.query('SELECT coins FROM users WHERE id = $1', [user.id]);
    expect(Number(coins.rows[0].coins)).toBe(5000);
  });

  test('বন্ধ থাকলেও উইথড্র পেজ খোলা যায় (ইউজার কারণ জানতে পারেন)', async () => {
    await setConfig({ mode: 'closed' });
    const user = await makeUser('wwpage');
    const res = await user.agent.get('/payment/withdraw');
    expect(res.status).toBe(200);
  });

  test('বন্ধ থাকলে পেজে কারণ দেখায় এবং সাবমিট বাটন নিষ্ক্রিয় থাকে', async () => {
    // E2E (tests/e2e/criticalFlows.spec.js) একই জিনিস ব্রাউজারে যাচাই করে;
    // এখানে রেন্ডার করা HTML দেখে নেওয়া হচ্ছে যাতে ব্রাউজার ছাড়াও প্রমাণ থাকে।
    await setConfig({ mode: 'closed' });
    const user = await makeUser('wwui');
    const res = await user.agent.get('/payment/withdraw');
    expect(res.status).toBe(200);
    expect(res.text).toContain('withdrawSubmitBtn');
    const btn = res.text.match(/<button[^>]*id="withdrawSubmitBtn"[^>]*>/)[0];
    expect(btn).toContain('disabled');
  });

  test('খোলা থাকলে বন্ধের নোটিশ দেখানো হয় না', async () => {
    await setConfig({ mode: 'open' });
    const user = await makeUser('wwuiopen');
    const res = await user.agent.get('/payment/withdraw');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('উইথড্র সাময়িকভাবে বন্ধ');
  });

  test('উইথড্র বন্ধ থাকলেও ডিপোজিট পেজ স্বাভাবিক থাকে', async () => {
    await setConfig({ mode: 'closed' });
    const user = await makeUser('wwdep');
    const res = await user.agent.get('/payment/deposit');
    expect(res.status).toBe(200);
  });

  test('জোর করে খোলা রাখলে রুট আর সময়সূচির কারণে আটকায় না', async () => {
    await setConfig({ mode: 'open' });
    const user = await makeUser('wwopen');
    const page = await user.agent.get('/payment/withdraw');
    const res = await user.agent.post('/payment/withdraw').type('form').send({
      method: 'bkash', account_number: '01712345678', amount: 500,
      _csrf: extractCsrfToken(page.text)
    });
    // অন্য কারণে (ব্যালেন্স/কার্ড/ইমেইল যাচাই) আটকাতে পারে, কিন্তু
    // সময়সূচির বার্তা আসা চলবে না।
    expect(res.text || '').not.toContain('উইথড্র সাময়িকভাবে বন্ধ');
  });
});

// ==================== অ্যাডমিন পেজ ====================
describe('অ্যাডমিন অ্যাক্সেস', () => {
  test('guest সময়সূচি পেজে ঢুকতে পারে না', async () => {
    const res = await freshRequest().get('/payment/admin/withdrawal-window');
    expect([302, 403]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  test('সাধারণ ইউজার সময়সূচি বদলাতে পারে না', async () => {
    await setConfig({ mode: 'auto' });
    const user = await makeUser('wwperm');
    const page = await user.agent.get('/payment/withdraw');
    const res = await user.agent.post('/payment/admin/withdrawal-window').type('form')
      .send({ mode: 'open', _csrf: extractCsrfToken(page.text) });
    expect(res.status).not.toBe(200);
    const cfg = await withdrawalWindow.readConfig();
    expect(cfg.mode).toBe('auto');
  });
});
