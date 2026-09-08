// ---------------------------------------------------------------------------
// tests/security/referralBonusLock.test.js
//
// ফাঁকটা ছিল: services/referral.js রেফারেল বোনাস সরাসরি `users.coins`-এ যোগ
// করত, কিন্তু `bonuses` টেবিলে কোনো সারি তৈরি করত না। canWithdraw() শুধু
// `bonuses` দেখে, তাই রেফারেল বোনাস কোনো ওয়েজারিং ছাড়াই তোলা যেত —
// ৫০+ রেফারে জনপ্রতি ১৫০০ কয়েন, শর্ত মাত্র ৫০০ ডিপোজিট। ভুয়া অ্যাকাউন্ট
// বানিয়ে ৫০০ ঢুকিয়ে ১৫০০ বের করা ছিল সরাসরি লাভজনক।
//
// ইনভেরিয়েন্ট যা এখানে লক করা হচ্ছে:
//   রেফারেল পেআউট হলে `bonuses`-এ একটা সারি থাকতেই হবে, এবং সেটা active
//   থাকা অবস্থায় canWithdraw() false ফেরত দিতেই হবে।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const { processReferralDeposit } = require('../../services/referral');
const { canWithdraw, RULES } = require('../../services/turnover');
const { uniqueUsername, uniquePhone } = require('../helpers/app');

async function createUser(prefix) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins, referral_code)
     VALUES ($1, $2, 'x', 0, $3) RETURNING id`,
    [uniqueUsername(prefix), uniquePhone(), uniqueUsername('code')]
  );
  return r.rows[0].id;
}

describe('রেফারেল বোনাসে টার্নওভার লক', () => {
  let referrerId;
  let referredId;

  beforeEach(async () => {
    referrerId = await createUser('rf');
    referredId = await createUser('rd');
    await pool.query(
      `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)
       ON CONFLICT (referred_id) DO NOTHING`,
      [referrerId, referredId]
    );
  });

  test('RULES-এ referral এন্ট্রি আছে এবং স্পোর্টস মাল্টিপ্লায়ার শূন্যের বেশি', () => {
    // এই এন্ট্রি না থাকলে createBonus() নীরবে কিছুই না করে ফিরে যেত —
    // অর্থাৎ লকটা আবার হারিয়ে যেত, কোনো এরর ছাড়াই।
    expect(RULES.referral).toBeDefined();
    expect(RULES.referral.sports).toBeGreaterThan(0);
  });

  test('রেফারেল পেআউটের পর bonuses টেবিলে active সারি তৈরি হয়', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await processReferralDeposit(client, referredId, 500);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const bonuses = await pool.query(
      `SELECT bonus_type, bonus_amount, sports_required, status
       FROM bonuses WHERE user_id = $1`,
      [referrerId]
    );

    expect(bonuses.rows.length).toBe(1);
    expect(bonuses.rows[0].bonus_type).toBe('referral');
    expect(Number(bonuses.rows[0].bonus_amount)).toBeGreaterThan(0);
    // ওয়েজারিং শর্ত আসলেই বসেছে কি না — শূন্য হলে লকটা কাগজে-কলমে থেকেও কাজ করত না
    expect(Number(bonuses.rows[0].sports_required)).toBeGreaterThan(0);
  });

  test('রেফারেল বোনাস active থাকলে canWithdraw() false দেয়', async () => {
    // পেআউটের আগে কোনো লক নেই
    const before = await canWithdraw(referrerId);
    expect(before.allowed).toBe(true);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await processReferralDeposit(client, referredId, 500);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const after = await canWithdraw(referrerId);
    expect(after.allowed).toBe(false);
    expect(after.pending.some(p => p.type === 'referral' && p.sportsLeft > 0)).toBe(true);
  });

  test('ন্যূনতম ডিপোজিটের নিচে হলে বোনাসও নেই, লকও নেই', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await processReferralDeposit(client, referredId, 100);   // ৫০০-র নিচে
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const bonuses = await pool.query('SELECT id FROM bonuses WHERE user_id = $1', [referrerId]);
    expect(bonuses.rows.length).toBe(0);

    const check = await canWithdraw(referrerId);
    expect(check.allowed).toBe(true);
  });
});
