// tests/integration/gatewayReconcile.test.js
// ---------------------------------------------------------------------------
// আটকে থাকা গেটওয়ে ডিপোজিট রিকনসিলিয়েশন।
//
// AUDIT FINDING (এখানে ঠিক করা হয়েছে): SSLCommerz ডিপোজিট ক্রেডিট হওয়ার দুটোই পথ
// (/success ব্রাউজার রিডাইরেক্ট ও /ipn সার্ভার কলব্যাক) একসাথে ব্যর্থ হতে পারত —
// ইউজার পেমেন্ট করেই ট্যাব বন্ধ করল, আর ঠিক তখনই সার্ভার ডাউন থাকায় IPN হারিয়ে গেল।
// তখন টাকা কাটা হয়েছে অথচ payment_requests রো চিরকাল 'pending', ইউজার কয়েন পায় না,
// আর এটা ধরার কোনো স্বয়ংক্রিয় উপায়ই ছিল না।
//
// এখানে গেটওয়ে মডিউলটা stub করা হয়েছে (আসল HTTP কল ছাড়া), কিন্তু যাচাইয়ের যুক্তি
// services/paymentVerification.js-এ থাকায় amount/currency চেক stub দিয়ে নিষ্ক্রিয়
// হয় না — তাই mismatch টেস্টগুলো আসল যাচাই-ই পরীক্ষা করছে।
//
// ⚠️ এটি আসল SSLCommerz স্যান্ডবক্স E2E নয়। গেটওয়ের সাথে প্রকৃত যোগাযোগ
// (credentials প্রয়োজন) এখানে যাচাই হয়নি এবং সেটা UNVERIFIED-ই রয়ে গেছে।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const sslcommerz = require('../../services/sslcommerz');
const reconcile = require('../../services/gatewayReconcile');

let seq = 0;

async function makeUser(coins = 0) {
  seq++;
  const username = `recon_${Date.now()}_${seq}`;
  const res = await pool.query(
    `INSERT INTO users (username, phone, password, coins) VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, `0198${String(Date.now()).slice(-7)}${seq}`.slice(0, 14), 'x', coins]
  );
  return res.rows[0].id;
}

// ageMinutes — রো কত পুরনো দেখানো হবে (MIN_AGE_MINUTES গেট পরীক্ষা করার জন্য)
async function makePendingDeposit(userId, amount, { ageMinutes = 60 } = {}) {
  seq++;
  const tranId = `RECON${Date.now()}${seq}`;
  const res = await pool.query(
    `INSERT INTO payment_requests
       (user_id, type, method, amount, status, gateway, gateway_tran_id, created_at)
     VALUES ($1, 'deposit', 'sslcommerz', $2, 'pending', 'sslcommerz', $3,
             NOW() - ($4 || ' minutes')::interval)
     RETURNING id`,
    [userId, amount, tranId, String(ageMinutes)]
  );
  return { id: res.rows[0].id, tranId };
}

const statusOf = async (id) =>
  (await pool.query('SELECT status FROM payment_requests WHERE id=$1', [id])).rows[0].status;
const coinsOf = async (id) =>
  Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);
const ledgerSum = async (id) => Number(
  (await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions WHERE user_id=$1 AND type='deposit'`,
    [id]
  )).rows[0].s
);

// গেটওয়ে ক্রেডেনশিয়াল সেট করা হচ্ছে যাতে isConfigured() true হয়; আসল কল
// validateByTransactionId spy দিয়ে বদলে ফেলা হচ্ছে, তাই নেটওয়ার্কে কিছু যায় না।
let spy;
beforeAll(() => {
  process.env.SSLCZ_STORE_ID = 'test_store';
  process.env.SSLCZ_STORE_PASSWD = 'test_pass';
});
afterEach(() => { if (spy) spy.mockRestore(); spy = null; });
afterAll(async () => {
  delete process.env.SSLCZ_STORE_ID;
  delete process.env.SSLCZ_STORE_PASSWD;
  await pool.end().catch(() => {});
});

function stubGateway(impl) {
  spy = jest.spyOn(sslcommerz, 'validateByTransactionId').mockImplementation(impl);
  return spy;
}

// reconcileStuckDeposits() পুরো টেবিল স্ক্যান করে, আর টেস্ট DB অন্য suite-এর সাথে
// শেয়ার্ড। আগের টেস্টের ইচ্ছাকৃতভাবে pending রেখে দেওয়া রো (mismatch কেস) জমতে
// থাকলে ব্যাচ ভরে যায় এবং পরের টেস্টের রো স্ক্যানই হয় না। প্রতিটা টেস্ট তাই
// পরিষ্কার অবস্থা থেকে শুরু করে।
beforeEach(async () => {
  await pool.query(
    `DELETE FROM payment_requests WHERE gateway = 'sslcommerz' AND status = 'pending'`
  );
});

describe('reconcileStuckDeposits — সফল পেমেন্ট ক্রেডিট', () => {
  test('গেটওয়ে VALID বললে ব্যালেন্স ও লেজার দুটোতেই ডিপোজিট যোগ হয়', async () => {
    const u = await makeUser(0);
    const dep = await makePendingDeposit(u, 500);
    stubGateway(async () => ({ status: 'VALID', amount: 500, currency: 'BDT' }));

    const s = await reconcile.reconcileStuckDeposits();
    expect(s.skipped).toBe(false);
    expect(s.credited).toBeGreaterThanOrEqual(1);
    expect(await statusOf(dep.id)).toBe('approved');
    expect(await coinsOf(u)).toBe(500);
    expect(await ledgerSum(u)).toBe(500);
  });

  test('দ্বিতীয়বার রান করলে একই ডিপোজিট আবার ক্রেডিট হয় না (idempotent)', async () => {
    const u = await makeUser(0);
    await makePendingDeposit(u, 300);
    stubGateway(async () => ({ status: 'VALIDATED', amount: 300, currency: 'BDT' }));

    await reconcile.reconcileStuckDeposits();
    const afterFirst = await coinsOf(u);
    await reconcile.reconcileStuckDeposits();

    expect(await coinsOf(u)).toBe(afterFirst);
    expect(await ledgerSum(u)).toBe(300);
  });

  test('সমান্তরাল দুটি রান — ক্রেডিট ঠিক একবারই হয়', async () => {
    const u = await makeUser(0);
    await makePendingDeposit(u, 250);
    stubGateway(async () => ({ status: 'VALID', amount: 250, currency: 'BDT' }));

    await Promise.all([
      reconcile.reconcileStuckDeposits(),
      reconcile.reconcileStuckDeposits()
    ]);
    expect(await coinsOf(u)).toBe(250);
    expect(await ledgerSum(u)).toBe(250);
  });
});

describe('reconcileStuckDeposits — ব্যর্থ/অনুপস্থিত পেমেন্ট', () => {
  test('গেটওয়েতে ট্রানজেকশন না থাকলে (NOT_FOUND) reject হয়, কোনো কয়েন যায় না', async () => {
    const u = await makeUser(0);
    const dep = await makePendingDeposit(u, 400);
    stubGateway(async () => ({ status: 'NOT_FOUND', amount: null, raw: {} }));

    await reconcile.reconcileStuckDeposits();
    expect(await statusOf(dep.id)).toBe('rejected');
    expect(await coinsOf(u)).toBe(0);
  });

  test.each(reconcile.FAILED_STATUSES)('গেটওয়ে status=%s হলে reject হয়', async (st) => {
    const u = await makeUser(0);
    const dep = await makePendingDeposit(u, 200);
    stubGateway(async () => ({ status: st, amount: 200, currency: 'BDT' }));

    await reconcile.reconcileStuckDeposits();
    expect(await statusOf(dep.id)).toBe('rejected');
    expect(await coinsOf(u)).toBe(0);
  });
});

describe('reconcileStuckDeposits — কারচুপি ও অস্পষ্টতা', () => {
  test('amount না মিললে ক্রেডিটও হয় না, rejectও নয় — pending থাকে (অ্যাডমিন রিভিউ)', async () => {
    const u = await makeUser(0);
    const dep = await makePendingDeposit(u, 1000);
    // গেটওয়ে বলছে পেমেন্ট সফল, কিন্তু মাত্র ১০ টাকার
    stubGateway(async () => ({ status: 'VALID', amount: 10, currency: 'BDT' }));

    await reconcile.reconcileStuckDeposits();
    expect(await statusOf(dep.id)).toBe('pending');
    expect(await coinsOf(u)).toBe(0);
  });

  test('currency না মিললে ক্রেডিট হয় না (সংখ্যা মিলে গেলেও)', async () => {
    const u = await makeUser(0);
    const dep = await makePendingDeposit(u, 100);
    // 100 USD ≠ 100 BDT — সংখ্যাগত তুলনা পাস করত, currency যাচাই আটকায়
    stubGateway(async () => ({ status: 'VALID', amount: 100, currency: 'USD' }));

    await reconcile.reconcileStuckDeposits();
    expect(await statusOf(dep.id)).toBe('pending');
    expect(await coinsOf(u)).toBe(0);
  });

  test('অজানা status-এ কিছুই বদলায় না (ভুল reject করার চেয়ে নিরাপদ)', async () => {
    const u = await makeUser(0);
    const dep = await makePendingDeposit(u, 150);
    stubGateway(async () => ({ status: 'PROCESSING', amount: 150, currency: 'BDT' }));

    await reconcile.reconcileStuckDeposits();
    expect(await statusOf(dep.id)).toBe('pending');
    expect(await coinsOf(u)).toBe(0);
  });

  test('গেটওয়ে কল থ্রো করলে রো অক্ষত থাকে, পরের রানে আবার চেষ্টা হয়', async () => {
    const u = await makeUser(0);
    const dep = await makePendingDeposit(u, 600);
    stubGateway(async () => { throw new Error('gateway timeout'); });

    const s = await reconcile.reconcileStuckDeposits();
    expect(s.errors).toBeGreaterThanOrEqual(1);
    expect(await statusOf(dep.id)).toBe('pending');

    spy.mockRestore();
    stubGateway(async () => ({ status: 'VALID', amount: 600, currency: 'BDT' }));
    await reconcile.reconcileStuckDeposits();
    expect(await statusOf(dep.id)).toBe('approved');
    expect(await coinsOf(u)).toBe(600);
  });
});

describe('reconcileStuckDeposits — গেট ও কনফিগ', () => {
  test('খুব সাম্প্রতিক রিকোয়েস্টে হাত দেওয়া হয় না (ইউজার তখনো গেটওয়ে পেজে থাকতে পারে)', async () => {
    const u = await makeUser(0);
    const dep = await makePendingDeposit(u, 700, { ageMinutes: 1 });
    stubGateway(async () => ({ status: 'VALID', amount: 700, currency: 'BDT' }));

    await reconcile.reconcileStuckDeposits();
    expect(await statusOf(dep.id)).toBe('pending');
    expect(await coinsOf(u)).toBe(0);
  });

  test('ক্রেডেনশিয়াল না থাকলে কিছুই করা হয় না — অনুমান করে credit/reject নয়', async () => {
    const savedId = process.env.SSLCZ_STORE_ID;
    const savedPw = process.env.SSLCZ_STORE_PASSWD;
    delete process.env.SSLCZ_STORE_ID;
    delete process.env.SSLCZ_STORE_PASSWD;
    try {
      const u = await makeUser(0);
      const dep = await makePendingDeposit(u, 800);
      const called = stubGateway(async () => ({ status: 'VALID', amount: 800, currency: 'BDT' }));

      const s = await reconcile.reconcileStuckDeposits();
      expect(s.skipped).toBe(true);
      expect(called).not.toHaveBeenCalled();
      expect(await statusOf(dep.id)).toBe('pending');
      expect(await coinsOf(u)).toBe(0);
    } finally {
      process.env.SSLCZ_STORE_ID = savedId;
      process.env.SSLCZ_STORE_PASSWD = savedPw;
    }
  });
});

describe('cron রেজিস্ট্রেশন', () => {
  test('gateway_deposit_reconcile জব scheduler-এ সংজ্ঞায়িত আছে', () => {
    const { JOB_DEFINITIONS } = require('../../services/scheduler');
    expect(Object.keys(JOB_DEFINITIONS)).toContain('gateway_deposit_reconcile');
    expect(typeof JOB_DEFINITIONS.gateway_deposit_reconcile.handler).toBe('function');
  });

  test('ক্রেডেনশিয়াল ছাড়া হ্যান্ডলার চললে স্পষ্টভাবে "কিছু করা হয়নি" বলে', async () => {
    const savedId = process.env.SSLCZ_STORE_ID;
    const savedPw = process.env.SSLCZ_STORE_PASSWD;
    delete process.env.SSLCZ_STORE_ID;
    delete process.env.SSLCZ_STORE_PASSWD;
    try {
      const { JOB_DEFINITIONS } = require('../../services/scheduler');
      const msg = await JOB_DEFINITIONS.gateway_deposit_reconcile.handler();
      expect(msg).toMatch(/ক্রেডেনশিয়াল/);
    } finally {
      process.env.SSLCZ_STORE_ID = savedId;
      process.env.SSLCZ_STORE_PASSWD = savedPw;
    }
  });
});
