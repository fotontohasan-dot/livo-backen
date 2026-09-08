// tests/integration/providerWalletIdempotency.test.js
// ---------------------------------------------------------------------------
// PHASE 2 — Seamless Wallet-এর সবচেয়ে গুরুত্বপূর্ণ ইনভেরিয়েন্টগুলো।
//
// প্রোভাইডাররা টাইমআউট হলে একই কল আবার পাঠায়, প্রায়ই মিলিসেকেন্ডের ব্যবধানে
// সমান্তরালে। এখানে যা লক করা হচ্ছে:
//
//   ১. একই provider_tx_id ১০০ বার সমান্তরালে পাঠালেও ব্যালেন্স ঠিক একবারই বদলায়
//      (UNIQUE (provider, provider_tx_id)-এর উপর ভরসা, SELECT-চেক নয়)।
//   ২. ব্যালেন্স কম থাকলে ডেবিট ব্যালেন্স স্পর্শই করে না — কোনো লেজার সারি,
//      কোনো provider_transactions সারি তৈরি হয় না।
//   ৩. rollback bet ফেরত দেয়, আর দ্বিতীয় rollback no-op।
//   ৪. প্রতিটা কলের সম্পূর্ণ trail provider_transactions-এ থাকে।
//
// আসল PostgreSQL-এর বিরুদ্ধে চলে; ডাটাবেজ আচরণ mock করা হয়নি — কারণ যে
// race condition-টা ঠেকানোর কথা সেটা কেবল সত্যিকারের সমান্তরাল ট্রানজেকশনেই
// প্রকাশ পায়।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const wallet = require('../../services/wallet');

const PROVIDER = 'test-provider';
const START = 1000;

async function makeUser(coins = START) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ('pw_'||floor(random()*1e9), '019'||floor(random()*1e8), 'x', $1)
     RETURNING id`, [coins]
  );
  return r.rows[0].id;
}

async function balanceOf(userId) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].coins);
}

function txId() {
  return `tx_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

describe('provider wallet — idempotency ও atomicity', () => {
  test('একই tx_id ১০০ বার সমান্তরালে — ব্যালেন্স একবারই বদলায়', async () => {
    const userId = await makeUser();
    const id = txId();

    const calls = Array.from({ length: 100 }, () =>
      wallet.debit({
        provider: PROVIDER, providerTxId: id, roundId: 'r1',
        userId, gameId: 'g1', amount: 100
      }).catch(e => ({ error: e.code }))
    );
    const results = await Promise.all(calls);

    expect(await balanceOf(userId)).toBe(START - 100);

    // ঠিক একটা সারি — বাকি ৯৯টা কল ডুপ্লিকেট হিসেবে চিহ্নিত হয়ে একই ফল পেয়েছে
    const rows = await pool.query(
      'SELECT COUNT(*)::int AS c FROM provider_transactions WHERE provider=$1 AND provider_tx_id=$2',
      [PROVIDER, id]
    );
    expect(rows.rows[0].c).toBe(1);

    const succeeded = results.filter(r => !r.error);
    expect(succeeded.length).toBe(100);
    succeeded.forEach(r => expect(r.balance).toBe(START - 100));
  });

  test('ব্যালেন্স কম হলে ব্যালেন্স স্পর্শ হয় না, কোনো সারিও লেখা হয় না', async () => {
    const userId = await makeUser(50);
    const id = txId();

    await expect(wallet.debit({
      provider: PROVIDER, providerTxId: id, userId, gameId: 'g1', amount: 500
    })).rejects.toMatchObject({ code: wallet.CODES.INSUFFICIENT_FUNDS });

    expect(await balanceOf(userId)).toBe(50);
    const rows = await pool.query(
      'SELECT COUNT(*)::int AS c FROM provider_transactions WHERE provider=$1 AND provider_tx_id=$2',
      [PROVIDER, id]
    );
    expect(rows.rows[0].c).toBe(0);
  });

  test('win ক্রেডিট হয় এবং লেজারে সঠিক চিহ্নে লেখা হয়', async () => {
    const userId = await makeUser();
    await wallet.credit({
      provider: PROVIDER, providerTxId: txId(), roundId: 'r2',
      userId, gameId: 'g1', amount: 250
    });
    expect(await balanceOf(userId)).toBe(START + 250);

    const led = await pool.query(
      `SELECT amount, type FROM coin_transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [userId]
    );
    expect(Number(led.rows[0].amount)).toBe(250);
    expect(led.rows[0].type).toBe('game_play');
  });

  test('rollback bet ফেরত দেয়; দ্বিতীয় rollback no-op', async () => {
    const userId = await makeUser();
    const betId = txId();
    await wallet.debit({
      provider: PROVIDER, providerTxId: betId, roundId: 'r3',
      userId, gameId: 'g1', amount: 200
    });
    expect(await balanceOf(userId)).toBe(START - 200);

    await wallet.rollback({
      provider: PROVIDER, providerTxId: txId(), roundId: 'r3',
      referenceTxId: betId, userId, gameId: 'g1'
    });
    expect(await balanceOf(userId)).toBe(START);

    // দ্বিতীয়বার — নতুন tx_id, কিন্তু মূল bet ইতিমধ্যে rolled_back
    await wallet.rollback({
      provider: PROVIDER, providerTxId: txId(), roundId: 'r3',
      referenceTxId: betId, userId, gameId: 'g1'
    });
    expect(await balanceOf(userId)).toBe(START);
  });

  test('প্রতিটা কলের সম্পূর্ণ trail থাকে (before/after সহ)', async () => {
    const userId = await makeUser();
    const id = txId();
    await wallet.debit({ provider: PROVIDER, providerTxId: id, userId, gameId: 'g1', amount: 75 });

    const r = await pool.query(
      `SELECT type, amount, balance_before, balance_after, status, raw_payload
         FROM provider_transactions WHERE provider=$1 AND provider_tx_id=$2`,
      [PROVIDER, id]
    );
    const row = r.rows[0];
    expect(row.type).toBe('bet');
    expect(Number(row.amount)).toBe(75);
    expect(Number(row.balance_before)).toBe(START);
    expect(Number(row.balance_after)).toBe(START - 75);
    expect(row.status).toBe('completed');
  });

  test('অবৈধ অঙ্ক ("50abc", ঋণাত্মক) প্রত্যাখ্যাত', async () => {
    const userId = await makeUser();
    for (const bad of ['50abc', '10; DROP TABLE users', -5, NaN, null]) {
      await expect(wallet.debit({
        provider: PROVIDER, providerTxId: txId(), userId, gameId: 'g1', amount: bad
      })).rejects.toMatchObject({ code: wallet.CODES.INVALID_AMOUNT });
    }
    expect(await balanceOf(userId)).toBe(START);
  });
});
