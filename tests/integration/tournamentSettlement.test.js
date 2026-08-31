// tests/integration/tournamentSettlement.test.js
// ---------------------------------------------------------------------------
// টুর্নামেন্ট সেটেলমেন্ট — পুরস্কার হিসাব, বিতরণ, idempotency, race condition
// ও বাতিলে entry fee ফেরত।
//
// যে বাস্তব ফাঁকগুলো এখানে লক করা হচ্ছে (আগে কোডে এর কিছুই ছিল না):
//   • টুর্নামেন্ট 'completed' করা হলে prize_pool কেউ পেত না।
//   • 'cancelled' করা হলে কাটা entry fee চিরতরে হারিয়ে যেত।
//   • একই টুর্নামেন্ট বারবার settle করলে একই পুরস্কার বারবার বিলি হওয়া
//     ঠেকানোর কোনো উপায় ছিল না।
//
// আসল PostgreSQL ব্যবহার — কোনো mock নেই।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const {
  computePrizeSplit, settleTournament, cancelTournament, DEFAULT_DISTRIBUTION
} = require('../../services/tournamentSettlement');

// ---- হেল্পার ----
let seq = 0;
async function makeUser(coins = 0) {
  seq++;
  const username = `tsettle_${Date.now()}_${seq}`;
  const res = await pool.query(
    `INSERT INTO users (username, phone, password, coins) VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, `0199${String(Date.now()).slice(-7)}${seq}`.slice(0, 14), 'x', coins]
  );
  return res.rows[0].id;
}

async function makeTournament({ entryFee = 0, prizePool = 0, status = 'live' } = {}) {
  const res = await pool.query(
    `INSERT INTO tournaments (name, entry_fee, prize_pool, max_participants, status)
     VALUES ($1, $2, $3, 100, $4) RETURNING id`,
    [`settle-test-${Date.now()}-${++seq}`, entryFee, prizePool, status]
  );
  return res.rows[0].id;
}

async function addParticipant(tid, userId, points, entryFeePaid = 0) {
  await pool.query(
    `INSERT INTO tournament_participants (tournament_id, user_id, points, entry_fee_paid)
     VALUES ($1, $2, $3, $4)`,
    [tid, userId, points, entryFeePaid]
  );
}

const coinsOf = async (id) =>
  Number((await pool.query('SELECT coins FROM users WHERE id=$1', [id])).rows[0].coins);

const ledgerSum = async (id, type) => Number(
  (await pool.query(
    'SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions WHERE user_id=$1 AND type=$2',
    [id, type]
  )).rows[0].s
);

afterAll(async () => { await pool.end().catch(() => {}); });

// =========================================================================
describe('computePrizeSplit — বিশুদ্ধ হিসাব', () => {
  test('স্কোর ছাড়া (সবার points = 0) কোনো টাকাই বিলি হয় না', () => {
    const r = computePrizeSplit([{ user_id: 1, points: 0 }, { user_id: 2, points: 0 }], 1000);
    expect(r.awards).toEqual([]);
    expect(r.distributed).toBe(0);
    expect(r.undistributed).toBe(1000);
  });

  test('৩ জন ভিন্ন স্কোরে ৫০/৩০/২০ ভাগ, মোট ঠিক prize_pool', () => {
    const r = computePrizeSplit(
      [{ user_id: 1, points: 30 }, { user_id: 2, points: 20 }, { user_id: 3, points: 10 }], 1000
    );
    expect(r.awards.map(a => [a.userId, a.rank, a.amount]))
      .toEqual([[1, 1, 500], [2, 2, 300], [3, 3, 200]]);
    expect(r.distributed).toBe(1000);
  });

  test('একজনই যোগ্য হলে শেয়ার normalize হয়ে পুরো pool তার — pool আটকে থাকে না', () => {
    const r = computePrizeSplit([{ user_id: 7, points: 5 }, { user_id: 8, points: 0 }], 1000);
    expect(r.awards).toEqual([{ userId: 7, points: 5, rank: 1, amount: 1000 }]);
    expect(r.distributed).toBe(1000);
  });

  test('টাই — একই স্কোরের সবাই একই র‍্যাঙ্ক ও সমান পুরস্কার পায়', () => {
    const r = computePrizeSplit(
      [{ user_id: 1, points: 10 }, { user_id: 2, points: 10 }, { user_id: 3, points: 5 }], 1000
    );
    // ১ম+২য় স্লট (৫০%+৩০% = ৮০%) দুজনে সমান ভাগ = ৪০০ করে, ৩য় পায় ২০০
    expect(r.awards.map(a => [a.rank, a.amount])).toEqual([[1, 400], [1, 400], [3, 200]]);
    expect(r.distributed).toBe(1000);
  });

  test('ভগ্নাংশ থাকলেও বিতরিত মোট ঠিক prize_pool-এর সমান (largest remainder)', () => {
    for (const poolAmt of [1, 7, 101, 999, 12345]) {
      const r = computePrizeSplit(
        [{ user_id: 1, points: 3 }, { user_id: 2, points: 2 }, { user_id: 3, points: 1 }], poolAmt
      );
      expect(r.distributed).toBe(poolAmt);
      expect(r.awards.every(a => Number.isInteger(a.amount) && a.amount >= 0)).toBe(true);
    }
  });

  test('কেউই কখনো ঋণাত্মক বা pool-এর বেশি পায় না', () => {
    const parts = Array.from({ length: 20 }, (_, i) => ({ user_id: i + 1, points: (i % 4) + 1 }));
    const r = computePrizeSplit(parts, 5000);
    expect(r.distributed).toBe(5000);
    expect(r.awards.every(a => a.amount >= 0 && a.amount <= 5000)).toBe(true);
  });

  test('distribution-এর মোট শেয়ার ১ (কনফিগ ভুল হলে ধরা পড়বে)', () => {
    expect(DEFAULT_DISTRIBUTION.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

// =========================================================================
describe('settleTournament — বিতরণ ও idempotency', () => {
  test('পুরস্কার ইউজারের ব্যালেন্সে যোগ হয় এবং ledger এন্ট্রি লেখা হয়', async () => {
    const [a, b] = [await makeUser(100), await makeUser(100)];
    const tid = await makeTournament({ prizePool: 1000 });
    await addParticipant(tid, a, 50);
    await addParticipant(tid, b, 10);

    const res = await settleTournament(tid);
    expect(res.success).toBe(true);
    expect(res.distributed).toBe(1000);

    // ২ জন যোগ্য → শেয়ার normalize (৫০/৩০ → ৬২.৫/৩৭.৫)
    expect(await coinsOf(a)).toBe(100 + 625);
    expect(await coinsOf(b)).toBe(100 + 375);
    expect(await ledgerSum(a, 'tournament_prize')).toBe(625);
    expect(await ledgerSum(b, 'tournament_prize')).toBe(375);

    const t = await pool.query('SELECT status, settled_at FROM tournaments WHERE id=$1', [tid]);
    expect(t.rows[0].status).toBe('completed');
    expect(t.rows[0].settled_at).not.toBeNull();
  });

  test('দ্বিতীয়বার settle করলে একটি কয়েনও দ্বিতীয়বার যায় না', async () => {
    const u = await makeUser(0);
    const tid = await makeTournament({ prizePool: 500 });
    await addParticipant(tid, u, 10);

    await settleTournament(tid);
    const after = await coinsOf(u);
    expect(after).toBe(500);

    const again = await settleTournament(tid);
    expect(again.alreadySettled).toBe(true);
    expect(await coinsOf(u)).toBe(after);
    expect(await ledgerSum(u, 'tournament_prize')).toBe(500);
  });

  test('সমান্তরাল ৫টি settle কল — পুরস্কার ঠিক একবারই বিলি হয়', async () => {
    const u = await makeUser(0);
    const tid = await makeTournament({ prizePool: 900 });
    await addParticipant(tid, u, 10);

    const results = await Promise.all(Array.from({ length: 5 }, () => settleTournament(tid)));
    const paid = results.filter(r => r.success && !r.alreadySettled);
    expect(paid).toHaveLength(1);
    expect(await coinsOf(u)).toBe(900);
    expect(await ledgerSum(u, 'tournament_prize')).toBe(900);
  });

  test('স্কোর রেকর্ড না থাকলে টুর্নামেন্ট completed হয় কিন্তু কোনো টাকা বেরোয় না', async () => {
    const u = await makeUser(0);
    const tid = await makeTournament({ prizePool: 1000 });
    await addParticipant(tid, u, 0);

    const res = await settleTournament(tid);
    expect(res.success).toBe(true);
    expect(res.distributed).toBe(0);
    expect(res.undistributed).toBe(1000);
    expect(await coinsOf(u)).toBe(0);
  });

  test('অস্তিত্বহীন টুর্নামেন্টে settle ব্যর্থ হয়, throw করে না', async () => {
    const res = await settleTournament(99999999);
    expect(res.success).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  test('বাতিল হওয়া টুর্নামেন্ট আর settle করা যায় না', async () => {
    const u = await makeUser(0);
    const tid = await makeTournament({ entryFee: 50, prizePool: 500 });
    await addParticipant(tid, u, 10, 50);
    await cancelTournament(tid);

    const res = await settleTournament(tid);
    expect(res.success).toBe(false);
    expect(res.reason).toBe('already_cancelled');
    expect(await ledgerSum(u, 'tournament_prize')).toBe(0);
  });
});

// =========================================================================
describe('cancelTournament — entry fee ফেরত', () => {
  test('প্রত্যেকের প্রকৃত entry fee ফেরত যায় এবং ledger এন্ট্রি লেখা হয়', async () => {
    const [a, b] = [await makeUser(0), await makeUser(0)];
    const tid = await makeTournament({ entryFee: 50, prizePool: 500 });
    await addParticipant(tid, a, 0, 50);
    await addParticipant(tid, b, 0, 50);

    const res = await cancelTournament(tid);
    expect(res.success).toBe(true);
    expect(res.refunded).toBe(100);
    expect(res.refundCount).toBe(2);
    expect(await coinsOf(a)).toBe(50);
    expect(await ledgerSum(b, 'tournament_refund')).toBe(50);

    const t = await pool.query('SELECT status, refunded_at FROM tournaments WHERE id=$1', [tid]);
    expect(t.rows[0].status).toBe('cancelled');
    expect(t.rows[0].refunded_at).not.toBeNull();
  });

  test('entry_fee পরে বদলে গেলেও ফেরত যায় যা আসলে কাটা হয়েছিল', async () => {
    const u = await makeUser(0);
    const tid = await makeTournament({ entryFee: 50, prizePool: 0 });
    await addParticipant(tid, u, 0, 50);
    await pool.query('UPDATE tournaments SET entry_fee = 5000 WHERE id=$1', [tid]);

    const res = await cancelTournament(tid);
    expect(res.refunded).toBe(50);
    expect(await coinsOf(u)).toBe(50);
  });

  test('দ্বিতীয়বার বাতিল করলে দ্বিতীয়বার ফেরত হয় না', async () => {
    const u = await makeUser(0);
    const tid = await makeTournament({ entryFee: 80 });
    await addParticipant(tid, u, 0, 80);

    await cancelTournament(tid);
    const again = await cancelTournament(tid);
    expect(again.alreadyRefunded).toBe(true);
    expect(await coinsOf(u)).toBe(80);
    expect(await ledgerSum(u, 'tournament_refund')).toBe(80);
  });

  test('সমান্তরাল ৫টি বাতিল কল — ফেরত ঠিক একবারই যায়', async () => {
    const u = await makeUser(0);
    const tid = await makeTournament({ entryFee: 70 });
    await addParticipant(tid, u, 0, 70);

    const results = await Promise.all(Array.from({ length: 5 }, () => cancelTournament(tid)));
    expect(results.filter(r => r.success && !r.alreadyRefunded)).toHaveLength(1);
    expect(await coinsOf(u)).toBe(70);
  });

  test('settle হয়ে যাওয়া টুর্নামেন্ট বাতিল করা যায় না (একই টাকা দুবার বেরোনো ঠেকায়)', async () => {
    const u = await makeUser(0);
    const tid = await makeTournament({ entryFee: 50, prizePool: 500 });
    await addParticipant(tid, u, 10, 50);
    await settleTournament(tid);

    const res = await cancelTournament(tid);
    expect(res.success).toBe(false);
    expect(res.reason).toBe('already_settled');
    expect(await ledgerSum(u, 'tournament_refund')).toBe(0);
    expect(await coinsOf(u)).toBe(500);
  });
});

// =========================================================================
describe('লেজার ইনভেরিয়েন্ট', () => {
  test('settle ও cancel — দুটোতেই ব্যালেন্স পরিবর্তন = ledger এন্ট্রির যোগফল', async () => {
    const u = await makeUser(0);
    const t1 = await makeTournament({ prizePool: 333 });
    await addParticipant(t1, u, 9);
    await settleTournament(t1);

    const t2 = await makeTournament({ entryFee: 44 });
    await addParticipant(t2, u, 0, 44);
    await cancelTournament(t2);

    const total = Number((await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS s FROM coin_transactions
       WHERE user_id=$1 AND type IN ('tournament_prize','tournament_refund')`, [u]
    )).rows[0].s);
    expect(await coinsOf(u)).toBe(total);
  });
});
