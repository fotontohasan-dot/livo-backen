// tests/render/criticalPageUiStates.test.js
// ---------------------------------------------------------------------------
// Phase 13 (খ) — গুরুত্বপূর্ণ স্ক্রিনে empty ও error state।
//
// roadmap-এর দাবি: প্রতিটা গুরুত্বপূর্ণ পেজে loading / error / empty state
// আলাদাভাবে থাকতে হবে। টাকার পেজে এটা কেবল সৌন্দর্যের প্রশ্ন নয় —
// tests/render/adminLoadErrorPages.test.js-এ অ্যাডমিন দিকে যে সমস্যাটা ধরা
// পড়েছিল, ইউজার দিকেও হুবহু সেটাই ছিল: ক্যোয়ারি ব্যর্থ হলে খালি তালিকা
// রেন্ডার হত, ফলে "ডেটাবেস ডাউন" আর "সত্যিই কোনো রেকর্ড নেই" দেখতে
// একরকম লাগত।
//
// এই sweep লেখার সময় তিনটে আসল ত্রুটি পাওয়া গেছে (সবগুলোই এই কমিটে ঠিক):
//   1. GET /kyc — catch ব্লকে `{ kyc: null }` রেন্ডার হত, যা হুবহু "আপনি
//      এখনো জমা দেননি" অবস্থা। approved ইউজারও আবার জমা দিতে যেত।
//   2. GET /payment/history — রুট `loadError: true` পাঠাত, কিন্তু
//      views/payment/history.ejs সেটা ব্যবহারই করত না। ব্যানারটা কখনো
//      দেখা যেত না; শুধু "এই সময়ে কোনো রেকর্ড নেই" দেখাত।
//   3. GET /payment/withdraw — catch ব্লকে `res.redirect('/')`, কোনো
//      বার্তা ছাড়া। ইউজার নীরবে হোমপেজে পৌঁছাত।
//
// পদ্ধতি: শুধু ওই পেজের নিজস্ব ক্যোয়ারিটাই ব্যর্থ করা হয় (marker দিয়ে),
// বাকি সব আসল DB-তে পাস-থ্রু — কারণ auth/RBAC মিডলওয়্যারও DB পড়ে, পুরো
// pool.query mock করলে লগইনই ভেঙে যেত।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const withdrawalWindow = require('../../services/withdrawalWindow');

jest.setTimeout(60000);

// ইচ্ছাকৃতভাবে SQL-গন্ধযুক্ত বার্তা — রেসপন্সে এর কোনো অংশ দেখা গেলেই
// বুঝতে হবে ডেটাবেসের internals ব্রাউজারে লিক করছে।
const LEAKY_DB_ERROR =
  'relation "secret_internal_table" does not exist — SELECT hash FROM api_keys WHERE token=$1';

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
  if (!r.rows[0]) throw new Error('টেস্ট ইউজার তৈরি হয়নি');
  return { agent, id: r.rows[0].id, username };
}

/** শুধু যেসব ক্যোয়ারিতে `marker` আছে সেগুলো ব্যর্থ করে; বাকি সব আসল DB-তে যায়। */
function failQueriesMatching(marker) {
  const real = pool.query.bind(pool);
  return jest.spyOn(pool, 'query').mockImplementation((text, params) => {
    const sql = typeof text === 'string' ? text : (text && text.text) || '';
    if (sql.includes(marker)) return Promise.reject(new Error(LEAKY_DB_ERROR));
    return real(text, params);
  });
}

function assertNoDbLeak(body) {
  expect(body).not.toContain('secret_internal_table');
  expect(body).not.toContain('api_keys');
  expect(body).not.toMatch(/relation "/);
  expect(body).not.toMatch(/at \w+ \(.*:\d+:\d+\)/); // স্ট্যাক ট্রেস
}

let user;
beforeAll(async () => { user = await makeUser(); });
afterEach(() => { jest.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// empty state — নতুন অ্যাকাউন্ট, কোনো ডেটা নেই। পেজ ভাঙে না, আর "খালি"
// অবস্থাটা ইউজারকে স্পষ্ট করে বলা হয়।
// ---------------------------------------------------------------------------
describe('Phase 13 — গুরুত্বপূর্ণ পেজে empty state', () => {
  const CASES = [
    ['/payment/wallet', /কোনো লেনদেন|no transaction/i],
    ['/payment/history', /কোনো রেকর্ড/],
    ['/profile/history', /কোনো বেট/],
    ['/payment/withdraw', /কার্ড|card/i]
  ];

  test.each(CASES)('%s — খালি অবস্থায় রেন্ডার হয় ও তা স্পষ্ট বলা হয়', async (path, re) => {
    const res = await user.agent.get(path);
    // "পেজটা সত্যিই এসেছে" — নাহলে নিচের regex রিডাইরেক্টের খালি বডিতে
    // মিলত না, আর টেস্টটা ভুল কারণে ফেল/পাস করত।
    expect(res.status).toBe(200);
    expect(res.text.length).toBeGreaterThan(500);
    expect(res.text).toMatch(re);
  });

  test('/extra/kyc — জমা না দেওয়া অবস্থায় ফর্ম দেখায়, কোনো এরর ব্যানার নয়', async () => {
    const res = await user.agent.get('/extra/kyc');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('id="kycLoadError"');
  });
});

// ---------------------------------------------------------------------------
// error state — পেজের নিজস্ব ক্যোয়ারি ব্যর্থ। খালি তালিকার মতো দেখানো
// চলবে না, আর DB internals ফাঁস হওয়া চলবে না।
// ---------------------------------------------------------------------------
describe('Phase 13 — গুরুত্বপূর্ণ পেজে error state', () => {
  test('/extra/kyc — লোড ব্যর্থ হলে "জমা দেননি"-র মতো দেখায় না', async () => {
    failQueriesMatching('FROM kyc_requests');
    const res = await user.agent.get('/extra/kyc');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="kycLoadError"');
    assertNoDbLeak(res.text);
  });

  test('/payment/history — লোড ব্যর্থ হলে "কোনো রেকর্ড নেই" বলে না', async () => {
    failQueriesMatching('FROM payment_requests');
    const res = await user.agent.get('/payment/history');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="historyLoadError"');
    // এটাই আসল দাবি: ব্যর্থতাকে "খালি" বলে চালিয়ে দেওয়া যাবে না
    expect(res.text).not.toContain('এই সময়ে কোনো রেকর্ড নেই');
    assertNoDbLeak(res.text);
  });

  test('/payment/deposit — মেথড লোড ব্যর্থ হলে এরর ব্যানার দেখায়', async () => {
    failQueriesMatching('FROM payment_methods');
    const res = await user.agent.get('/payment/deposit');
    expect(res.status).toBe(200);
    // loadError=true হলে methodError থেকে hidden ক্লাসটা সরে যায়
    expect(res.text).toMatch(/id="methodError" class="\s*rounded/);
    assertNoDbLeak(res.text);
  });

  test('/payment/withdraw — লোড ব্যর্থ হলে নীরবে হোমপেজে ফেলে দেয় না', async () => {
    failQueriesMatching('SELECT coins FROM users');
    const res = await user.agent.get('/payment/withdraw');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/profile');

    // flash বার্তাটা সত্যিই দেখানো হয় কি না — রিডাইরেক্ট নিজে কিছু প্রমাণ
    // করে না, গন্তব্য পেজে বার্তাটা থাকতেই হবে।
    const landed = await user.agent.get('/profile');
    expect(landed.status).toBe(200);
    expect(landed.text).toMatch(/উইথড্র পেজ লোড করা যায়নি|withdraw page could not be loaded/i);
    assertNoDbLeak(landed.text);
  });

  test('/payment/wallet — লোড ব্যর্থ হলে বার্তাসহ প্রোফাইলে ফেরত', async () => {
    failQueriesMatching('FROM payment_requests');
    const res = await user.agent.get('/payment/wallet');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/profile');
    const landed = await user.agent.get('/profile');
    expect(landed.text).toMatch(/ওয়ালেট লোড করতে সমস্যা|wallet/i);
    assertNoDbLeak(landed.text);
  });

  test('/profile/history — লোড ব্যর্থ হলে বার্তাসহ প্রোফাইলে ফেরত', async () => {
    failQueriesMatching('FROM bets b');
    const res = await user.agent.get('/profile/history');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/profile');
    const landed = await user.agent.get('/profile');
    expect(landed.text).toMatch(/ইতিহাস লোড করতে সমস্যা|history/i);
    assertNoDbLeak(landed.text);
  });
});

// ---------------------------------------------------------------------------
// disabled state — roadmap Phase 13-এর চতুর্থ দাবি। withdraw পেজে কার্ড না
// থাকলে সাবমিট বোতাম নিষ্ক্রিয় থাকতে হবে, নইলে ইউজার এমন ফর্ম পাঠাত যা
// সার্ভার নিশ্চিতভাবে বাতিল করত।
// ---------------------------------------------------------------------------
describe('Phase 13 — কয়েন লেজার ও সংরক্ষিত কার্ড', () => {
  // দ্বিতীয় স্লাইস। একই শ্রেণির ত্রুটি profile.js-এর আরও ~২০টা রুটে আছে
  // (নিচে সীমা দেখুন); এখানে টাকার সাথে সরাসরি জড়িত দুটো আগে করা হলো।

  test('/profile/transactions — খালি অবস্থায় "কোনো লেনদেন নেই"', async () => {
    const res = await user.agent.get('/profile/transactions');
    expect(res.status).toBe(200);
    expect(res.text).toContain('কোনো লেনদেন নেই');
    expect(res.text).not.toContain('id="txLoadError"');
  });

  test('/profile/transactions — লোড ব্যর্থ হলে "কোনো লেনদেন নেই" বলে না', async () => {
    failQueriesMatching('FROM coin_transactions');
    const res = await user.agent.get('/profile/transactions');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="txLoadError"');
    expect(res.text).not.toContain('কোনো লেনদেন নেই');
    assertNoDbLeak(res.text);
  });

  test('/profile/account-record — একই ভিউ, একই সুরক্ষা', async () => {
    failQueriesMatching('FROM coin_transactions');
    const res = await user.agent.get('/profile/account-record');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="txLoadError"');
    assertNoDbLeak(res.text);
  });

  test('/profile/cards — খালি অবস্থায় empty state, গণনা ০', async () => {
    const res = await user.agent.get('/profile/cards');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('id="cardsLoadError"');
    expect(res.text).toMatch(/যোগ করা হয়েছে:[\s\S]{0,120}>0</);
  });

  test('/profile/cards — লোড ব্যর্থ হলে "কার্ড নেই"-র মতো দেখায় না', async () => {
    failQueriesMatching('FROM bank_cards');
    const res = await user.agent.get('/profile/cards');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="cardsLoadError"');
    // গণনাটাও "০" বলা যাবে না — সেটাও একটা ভুল দাবি
    expect(res.text).not.toMatch(/যোগ করা হয়েছে:[\s\S]{0,120}>0</);
    assertNoDbLeak(res.text);
  });
});

describe('Phase 13 — disabled state', () => {
  // প্রথম চেষ্টায় এই টেস্টটা নিরর্থক ছিল: নতুন ইউজারের withdraw PIN সেট
  // থাকে না, তাই টেমপ্লেটের `formGated` এমনিতেই true — বোতামটা কার্ড আছে
  // কি নেই তার সাথে কোনো সম্পর্ক ছাড়াই disabled থাকত। মিউটেশন যাচাইয়ে
  // ধরা পড়ে: শর্ত থেকে cards সরিয়ে দিলেও টেস্ট সবুজ থাকত।
  //
  // তাই এখানে আগে PIN সেট করে formGated মিথ্যা করা হয়, যাতে disabled
  // অবস্থাটা সত্যিই কার্ড না-থাকার কারণেই হয়। শেষে কার্ড যোগ করে দেখা হয়
  // বোতামটা সক্রিয় হয় — নাহলে "সবসময় disabled" দিয়েও টেস্ট পাস করত।
  let pinUser;
  let savedWindowMode;

  // সাবধানতা: ক্লাস তালিকায় `disabled:opacity-40` আছে, তাই স্রেফ
  // toContain('disabled') সবসময় সত্য হত — দুটো টেস্টই নিরর্থক থাকত।
  // তাই আসল HTML অ্যাট্রিবিউটটাই খোঁজা হয়, ক্লাসের অংশ নয়।
  const isDisabled = (html) => {
    const m = /<button[^>]*id="withdrawSubmitBtn"[^>]*>/.exec(html);
    expect(m).not.toBeNull();
    return /\sdisabled(?=[\s>])/.test(m[0]);
  };

  beforeAll(async () => {
    pinUser = await makeUser();
    await pool.query(
      `UPDATE users SET withdraw_pin_hash='x', withdraw_pin_created_at=NOW(),
              withdraw_pin_failed_attempts=0, withdraw_pin_locked_until=NULL
       WHERE id=$1`,
      [pinUser.id]
    );
    // উইথড্র উইন্ডো সময়সূচি-নির্ভর (ডিফল্টে রাত ২৩:০০–০৭:০০ বন্ধ)। সেটা
    // formGated-এ ঢোকে, অর্থাৎ টেস্টটা দিনের কোন সময়ে চলছে তার উপর ফল
    // বদলে যেত — একবার সেভাবেই ভুল সবুজ পাওয়া গেছে। তাই উইন্ডোটা
    // স্পষ্ট করে খোলা রাখা হচ্ছে; বন্ধ-অবস্থার আচরণ আলাদা সুটের বিষয়।
    savedWindowMode = await withdrawalWindow.readConfig().then((c) => c.mode).catch(() => null);
    await withdrawalWindow.saveConfig({ mode: 'open' });
  });

  afterAll(async () => {
    if (savedWindowMode) await withdrawalWindow.saveConfig({ mode: savedWindowMode });
    await pool.query('DELETE FROM bank_cards WHERE user_id=$1', [pinUser.id]);
  });

  test('PIN সেট আছে কিন্তু কার্ড নেই — সাবমিট বোতাম disabled', async () => {
    const res = await pinUser.agent.get('/payment/withdraw');
    expect(res.status).toBe(200);
    // formGated সত্যিই মিথ্যা হয়েছে কি না — নাহলে নিচের দাবি অর্থহীন
    expect(res.text).not.toContain('id="pinNotConfiguredNotice"');
    expect(isDisabled(res.text)).toBe(true);
  });

  test('কার্ড যোগ করলে বোতাম সক্রিয় হয় (সবসময় disabled নয়)', async () => {
    await pool.query(
      `INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name)
       VALUES ($1, 'Test Bank', '0000000000', 'Test Holder')`,
      [pinUser.id]
    );
    const res = await pinUser.agent.get('/payment/withdraw');
    expect(res.status).toBe(200);
    expect(isDisabled(res.text)).toBe(false);
  });
});
