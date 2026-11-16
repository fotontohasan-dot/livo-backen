// ব্যাকআপ-রিস্টোরে অবৈধ bank_cards.wallet_kind (যেমন 'foo') — আচরণ পিন করা (শুধু পর্যবেক্ষণ, কোড অপরিবর্তিত)।
// প্রশ্ন: (১) রিস্টোর সারিটা ঢোকায়, না এরর দেয়? (২) profile/payment পাতা পরে ওই কার্ড নিয়ে ক্র্যাশ করে, না নিরাপদ ডিফল্টে যায়?
// আসল Postgres, কোনো mock নেই। bank_cards.wallet_kind কলামে CHECK constraint নেই (TEXT NOT NULL DEFAULT 'ewallet'),
// তাই 'foo' ডাটাবেস নিজেও ঠেকায় না; রিস্টোরও কলাম-ভিত্তিক যাচাই করে না (ON CONFLICT DO NOTHING সহ হুবহু INSERT)।
const backupManager = require('../../services/backupManager');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

jest.setTimeout(180000);

const FOO_ACC = 'FOO-ACCT-0001';
let userId;
let agent;
let restoreResult;
let cardIdBefore;

beforeAll(async () => {
  const username = uniqueUsername('rwk');
  const email = `${username}@example.test`;
  const pw = 'SecurePass123';
  const reg = await getCsrfAgent('/register');
  const r = await reg.agent.post('/register').type('form').send({
    username, email, phone: uniquePhone(), password: pw, confirmPassword: pw, _csrf: reg.token });
  expect(r.status).toBe(302);
  const login = await getCsrfAgent('/login');
  agent = login.agent;
  const l = await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form').send({ identifier: email, password: pw, _csrf: login.token });
  expect(l.status).toBe(302);
  userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;

  // অবৈধ wallet_kind-সহ কার্ড (এখন আর অ্যাপের রুট দিয়ে ঢোকানো যায় না — ব্যাকআপ ফাইলে যেভাবে থাকতে পারে সেভাবে সরাসরি SQL)
  const ins = await pool.query(
    `INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name, wallet_kind) VALUES ($1,'Some Bank',$2,'pw-secret-1','foo') RETURNING id`,
    [userId, FOO_ACC]);
  cardIdBefore = ins.rows[0].id;

  const record = await backupManager.createDatabaseBackup({ source: 'manual' });
  expect(record.status).toBe('completed');

  // কার্ড মুছে রিস্টোর — সারি ফিরে আসে কিনা দেখতে
  await pool.query('DELETE FROM bank_cards WHERE user_id = $1', [userId]);
  expect((await pool.query('SELECT 1 FROM bank_cards WHERE user_id = $1', [userId])).rows).toHaveLength(0);

  restoreResult = await backupManager.restoreBackup(record);
});

afterAll(async () => {
  if (!userId) return;
  await pool.query('DELETE FROM bank_cards WHERE user_id = $1', [userId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
});

describe("রিস্টোরে অবৈধ wallet_kind='foo'", () => {
  test('রিস্টোর এরর দেয় না, bank_cards-এ কোনো সারি skip হয় না', () => {
    expect(restoreResult._skipped && restoreResult._skipped.bank_cards).toBeFalsy();
    expect(restoreResult.bank_cards).toBeGreaterThanOrEqual(1);
  });

  test("সারিটা হুবহু 'foo' নিয়েই ফিরে আসে — কোনো যাচাই/ডিফল্টে রূপান্তর নেই", async () => {
    const r = await pool.query('SELECT id, wallet_kind, account_number FROM bank_cards WHERE user_id = $1', [userId]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe(cardIdBefore);
    expect(r.rows[0].wallet_kind).toBe('foo');
    expect(r.rows[0].account_number).toBe(FOO_ACC);
  });

  test('/profile/cards ক্র্যাশ করে না: কার্ড e-wallet তালিকায় যায় (crypto নয়), loadError নেই', async () => {
    const res = await agent.get('/profile/cards');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('id="cardsLoadError"');
    const counts = [...res.text.matchAll(/class="cd-count">[^<]*<b>(\d+)<\/b>/g)].map((m) => Number(m[1]));
    expect(counts).toEqual([1, 0]); // [ewallet, crypto]
    expect(res.text).toContain(FOO_ACC);
  });

  test('/profile/security ক্র্যাশ করে না: hasEwallet true, hasCryptoWallet false', async () => {
    const res = await agent.get('/profile/security');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/E-wallet linked|ই-ওয়ালেট যুক্ত আছে/);
    expect(res.text).not.toMatch(/Crypto wallet linked|ক্রিপ্টো ওয়ালেট যুক্ত আছে/);
  });

  test("/payment/withdraw ক্র্যাশ করে না: কার্ড ড্রপডাউনে আসে, methodCode নিরাপদ ডিফল্ট 'bank'", async () => {
    const res = await agent.get('/payment/withdraw');
    expect(res.status).toBe(200);
    const opts = [...res.text.matchAll(/<option value="\d+" data-method="([a-z]+)" data-number="([^"]*)"/g)]
      .map((m) => ({ method: m[1], number: m[2] }));
    expect(opts).toEqual(expect.arrayContaining([{ method: 'bank', number: FOO_ACC }]));
  });
});
