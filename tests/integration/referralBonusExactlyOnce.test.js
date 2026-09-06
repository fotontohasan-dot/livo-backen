const { pool } = require('../../db');
const referral = require('../../services/referral');

// ==================== Phase 8: referral signup bonus ====================
//
// processReferralDeposit() রেফারারকে signup bonus দেয়। বোনাসটা exactly-once
// হতে হবে — না হলে একই রেফারেলে বারবার টাকা তোলা যেত।
//
// race-টা কাল্পনিক নয়: অ্যাডমিন ম্যানুয়ালি deposit approve করার সময় আর
// গেটওয়ের success-redirect / IPN একসাথে এলে দুটো পথই একই সময়ে
// signup_bonus_paid=false দেখতে পারে।
//
// services/referral.js সঠিক প্যাটার্ন ব্যবহার করে: SELECT দিয়ে পড়ে তারপর
// UPDATE নয়, বরং একটাই atomic conditional UPDATE —
//   UPDATE referrals SET signup_bonus_paid = true
//   WHERE referred_id = $1 AND signup_bonus_paid = false RETURNING ...
// যে লেনদেন rowCount 1 পায় কেবল সে-ই বোনাস দেয়; বাকিরা 0 পেয়ে ফিরে যায়।
//
// কোনো টেস্ট এটা সমান্তরালে যাচাই করত না।

const WORKERS = 6;
const DEPOSIT = 10000;

async function makeUser(name) {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ($1, $2, 'x', 0) RETURNING id`,
    [name + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
     '9' + Date.now().toString().slice(-9) + Math.floor(Math.random() * 9)]
  );
  return r.rows[0].id;
}

async function coins(id) {
  const r = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
  return Number(r.rows[0].coins);
}

// users-এ foreign key রাখা সব টেবিল ডাইনামিকভাবে বের করে মুছি।
// হাতে তালিকা রাখায় প্রথম খসড়ায় ইউজার রয়ে যাচ্ছিল, আর তাতে
// deferredItemsIntegrity-র scanAllUsers query-count টেস্ট ভেঙে যাচ্ছিল —
// অর্থাৎ অসম্পূর্ণ cleanup অন্য সুটকে ফ্লেক করাচ্ছিল।
async function childTables() {
  const r = await pool.query(`
    SELECT DISTINCT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'users' AND ccu.column_name = 'id'
  `);
  return r.rows;
}

async function cleanup(ids) {
  const tables = await childTables();
  for (const id of ids) {
    for (const { table_name, column_name } of tables) {
      await pool.query(
        `DELETE FROM ${table_name} WHERE ${column_name} = $1`, [id]
      ).catch(() => {});
    }
  }
  for (const id of ids) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  }
}

// প্রতিটা কল নিজের client নেয় — সত্যিকারের সমান্তরাল লেনদেন
async function processOnce(referredId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await referral.processReferralDeposit(client, referredId, DEPOSIT);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return false;
  } finally {
    client.release();
  }
}

describe('Phase 8 — referral signup bonus exactly-once', () => {
  jest.setTimeout(60000);

  let referrer;
  let referred;

  beforeEach(async () => {
    referrer = await makeUser('rf');
    referred = await makeUser('rd');
    await pool.query(
      `INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)
       ON CONFLICT (referred_id) DO NOTHING`,
      [referrer, referred]
    );
  });

  afterEach(async () => {
    await cleanup([referrer, referred]);
  });

  test('atomic conditional UPDATE ব্যবহার হয়, SELECT-তারপর-UPDATE নয়', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'services', 'referral.js'), 'utf8'
    );
    expect(src).toMatch(/WHERE referred_id = \$1 AND signup_bonus_paid = false/);
  });

  test('সমান্তরাল deposit প্রক্রিয়ায় বোনাস একবারই দেওয়া হয়', async () => {
    const before = await coins(referrer);

    await Promise.all(Array.from({ length: WORKERS }, () => processOnce(referred)));

    const paid = await pool.query(
      'SELECT signup_bonus_paid FROM referrals WHERE referred_id = $1', [referred]
    );
    expect(paid.rows[0].signup_bonus_paid).toBe(true);

    // ব্যালেন্স ও commission একই স্ন্যাপশটে পড়া হয়। আলাদা query-তে পড়লে
    // মাঝখানে অন্য কমিশন/নোটিফিকেশন কাজ ঢুকে অমিল দেখাতে পারত — আগের
    // একটা টেস্টে ঠিক এই কারণেই flakiness হয়েছিল।
    const snap = await pool.query(
      `SELECT u.coins,
              (SELECT COUNT(*) FROM referral_commissions
                WHERE earner_id = u.id AND reason = 'signup') AS cnt,
              (SELECT COALESCE(SUM(amount), 0) FROM referral_commissions
                WHERE earner_id = u.id AND reason = 'signup') AS total
       FROM users u WHERE u.id = $1`,
      [referrer]
    );
    expect(Number(snap.rows[0].cnt)).toBeLessThanOrEqual(1);
    expect(Number(snap.rows[0].coins) - before).toBe(Number(snap.rows[0].total));
  });

  test('দ্বিতীয়বার প্রক্রিয়া করলে আর বোনাস যোগ হয় না', async () => {
    await processOnce(referred);
    const mid = await coins(referrer);
    await processOnce(referred);
    expect(await coins(referrer)).toBe(mid);
  });
});
