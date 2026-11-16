// bank_cards.wallet_kind সংরক্ষণ — /profile/cards/add ও /profile/add-bank-card।
// আগে দুই রুটই wallet_kind ছাড়া INSERT করত, ফলে ফর্মের 'crypto' বেছে নেওয়াও কলামের
// ডিফল্ট 'ewallet' হয়ে যেত: কার্ড-পাতায় ভুল তালিকা, security পাতায় hasCryptoWallet false,
// withdraw ড্রপডাউনে methodCode 'bank'। আসল Postgres, কোনো mock নেই।
const { app, getCsrfAgent, extractCsrfToken, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

const createdUserIds = [];

async function loggedInUser() {
  const username = uniqueUsername('wks');
  const email = `${username}@example.test`;
  const pw = 'SecurePass123';
  const reg = await getCsrfAgent('/register');
  const r = await reg.agent.post('/register').type('form').send({
    username, email, phone: uniquePhone(), password: pw, confirmPassword: pw, _csrf: reg.token });
  expect(r.status).toBe(302);
  const { agent, token } = await getCsrfAgent('/login');
  const l = await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form').send({ identifier: email, password: pw, _csrf: token });
  expect(l.status).toBe(302);
  const row = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  const userId = row.rows[0].id;
  createdUserIds.push(userId);
  return { agent, userId };
}

async function csrfFor(agent) {
  const page = await agent.get('/profile/cards');
  expect(page.status).toBe(200);
  return extractCsrfToken(page.text);
}

async function cardsOf(userId) {
  const r = await pool.query('SELECT bank_name, account_number, wallet_kind FROM bank_cards WHERE user_id = $1 ORDER BY id', [userId]);
  return r.rows;
}

const INVALID_ERROR = /Invalid wallet type|ওয়ালেটের ধরন সঠিক নয়/;

afterAll(async () => {
  if (!createdUserIds.length) return;
  await pool.query('DELETE FROM bank_cards WHERE user_id = ANY($1)', [createdUserIds]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]).catch(() => {});
});

describe.each([
  ['/profile/cards/add', '/profile/cards'],
  ['/profile/add-bank-card', '/profile/security/bank']
])('POST %s — wallet_kind সংরক্ষণ', (route, redirectTo) => {
  test.each([
    ['ewallet', 'bKash', '01711000001'],
    ['crypto', 'USDT (TRC20)', 'TXyzCryptoAddr0001']
  ])('kind=%s: ঠিক মানটাই সংরক্ষিত হয়', async (kind, bankName, account) => {
    const { agent, userId } = await loggedInUser();
    const _csrf = await csrfFor(agent);
    const res = await agent.post(route).type('form').send({
      bank_name: bankName, account_number: account, holder_name: 'pw-secret-1', wallet_kind: kind, _csrf });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(redirectTo);
    const cards = await cardsOf(userId);
    expect(cards).toEqual([{ bank_name: bankName, account_number: account, wallet_kind: kind }]);
  });

  test.each([
    ['bank'],
    ['CRYPTO'],
    [' crypto'],
    ['bitcoin'],
    ['']
  ])('অবৈধ wallet_kind %j প্রত্যাখ্যাত, কার্ড তৈরি হয় না, পরিষ্কার এরর', async (bad) => {
    const { agent, userId } = await loggedInUser();
    const _csrf = await csrfFor(agent);
    const res = await agent.post(route).type('form').send({
      bank_name: 'bKash', account_number: '01711000002', holder_name: 'pw-secret-1', wallet_kind: bad, _csrf });
    expect(res.status).toBe(302);
    expect(await cardsOf(userId)).toEqual([]);
    const next = await agent.get(redirectTo);
    expect(next.text).toMatch(INVALID_ERROR);
  });

  test('wallet_kind পাঠানো না হলে নীরবে ডিফল্ট ewallet নয় — প্রত্যাখ্যাত', async () => {
    const { agent, userId } = await loggedInUser();
    const _csrf = await csrfFor(agent);
    const res = await agent.post(route).type('form').send({
      bank_name: 'USDT (TRC20)', account_number: 'TXyzCryptoAddr0002', holder_name: 'pw-secret-1', _csrf });
    expect(res.status).toBe(302);
    expect(await cardsOf(userId)).toEqual([]);
    const next = await agent.get(redirectTo);
    expect(next.text).toMatch(INVALID_ERROR);
  });

  test('একই কার্ড-ফিল্ড পুনরাবৃত্তি (wallet_kind=a&wallet_kind=b) প্রত্যাখ্যাত', async () => {
    const { agent, userId } = await loggedInUser();
    const _csrf = await csrfFor(agent);
    const res = await agent.post(route).type('form').send(
      `bank_name=bKash&account_number=01711000003&holder_name=pw-secret-1&wallet_kind=ewallet&wallet_kind=crypto&_csrf=${encodeURIComponent(_csrf)}`);
    expect(res.status).toBe(302);
    expect(await cardsOf(userId)).toEqual([]);
  });
});

describe('crypto কার্ডের প্রভাব — কার্ড-পাতা, security পাতা, withdraw ড্রপডাউন', () => {
  let agent; let userId;
  const CRYPTO_ACC = 'TXyzCryptoAddr7777';
  const EWALLET_ACC = '01711000777';

  beforeAll(async () => {
    ({ agent, userId } = await loggedInUser());
    const _csrf = await csrfFor(agent);
    const a = await agent.post('/profile/cards/add').type('form').send({
      bank_name: 'USDT (TRC20)', account_number: CRYPTO_ACC, holder_name: 'pw-secret-1', wallet_kind: 'crypto', _csrf });
    expect(a.status).toBe(302);
    const b = await agent.post('/profile/cards/add').type('form').send({
      bank_name: 'bKash', account_number: EWALLET_ACC, holder_name: 'pw-secret-1', wallet_kind: 'ewallet', _csrf });
    expect(b.status).toBe(302);
  });

  test('কার্ড-পাতা: crypto কার্ড crypto তালিকায়, e-wallet কার্ড e-wallet তালিকায়', async () => {
    const page = await agent.get('/profile/cards');
    expect(page.status).toBe(200);
    const counts = [...page.text.matchAll(/class="cd-count">[^<]*<b>(\d+)<\/b>/g)].map((m) => Number(m[1]));
    expect(counts).toEqual([1, 1]); // [ewallet, crypto]
    const idxEwalletSection = page.text.indexOf('class="cd-count"');
    const idxCryptoSection = page.text.indexOf('class="cd-count"', idxEwalletSection + 1);
    expect(idxEwalletSection).toBeGreaterThan(-1);
    expect(idxCryptoSection).toBeGreaterThan(idxEwalletSection);
    const ewalletPart = page.text.slice(idxEwalletSection, idxCryptoSection);
    const cryptoPart = page.text.slice(idxCryptoSection);
    expect(ewalletPart).toContain(EWALLET_ACC);
    expect(ewalletPart).not.toContain(CRYPTO_ACC);
    expect(cryptoPart).toContain(CRYPTO_ACC);
    expect(cryptoPart).not.toContain(EWALLET_ACC);
  });

  test('security পাতা: hasCryptoWallet true (crypto wallet linked দেখায়)', async () => {
    const page = await agent.get('/profile/security');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/Crypto wallet linked|ক্রিপ্টো ওয়ালেট যুক্ত আছে/);
    expect(page.text).not.toMatch(/Please use a trusted crypto wallet|দয়া করে প্রতিষ্ঠানিত ক্রিপ্টো ওয়ালেট ব্যবহার করুন/);
  });

  test('withdraw ড্রপডাউন: crypto কার্ডের methodCode = crypto', async () => {
    const page = await agent.get('/payment/withdraw');
    expect(page.status).toBe(200);
    const opts = [...page.text.matchAll(/<option value="\d+" data-method="([a-z]+)" data-number="([^"]*)"/g)]
      .map((m) => ({ method: m[1], number: m[2] }));
    expect(opts).toEqual(expect.arrayContaining([
      { method: 'crypto', number: CRYPTO_ACC },
      { method: 'bkash', number: EWALLET_ACC }
    ]));
  });

  test('শুধু e-wallet কার্ড থাকলে security পাতায় crypto "linked" দেখায় না', async () => {
    const u = await loggedInUser();
    const _csrf = await csrfFor(u.agent);
    await u.agent.post('/profile/cards/add').type('form').send({
      bank_name: 'Nagad', account_number: '01811000888', holder_name: 'pw-secret-1', wallet_kind: 'ewallet', _csrf });
    const page = await u.agent.get('/profile/security');
    expect(page.status).toBe(200);
    expect(page.text).not.toMatch(/Crypto wallet linked|ক্রিপ্টো ওয়ালেট যুক্ত আছে/);
    expect(page.text).toMatch(/E-wallet linked|ই-ওয়ালেট যুক্ত আছে/);
  });
});
