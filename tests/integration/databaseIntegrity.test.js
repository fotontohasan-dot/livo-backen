// tests/integration/databaseIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 02 — ডাটাবেজ ও ডেটা ইন্টিগ্রিটি রিগ্রেশন টেস্ট।
//
// আসল PostgreSQL-এর বিরুদ্ধে চলে (কোনো mock/fake DB নয়) — globalSetup ইতিমধ্যে
// টেস্ট সুইটের আগে একবার মাইগ্রেশন চালিয়ে রাখে।
//
// যে বাস্তব ফাঁকগুলো ধরা পড়েছিল এবং এখানে লক করা হচ্ছে:
//   • accumulator_selections.match_id ও .market_id — কোডে ম্যাচ/মার্কেট আইডি দিয়ে
//     সেটলমেন্ট হয় (services/accumulator.js), অথচ কোনো ফরেন কী ছিল না। ভুল বা মুছে
//     যাওয়া আইডি নীরবে বসে যেত।
//   • login_logs / error_logs / chat_messages / news / withdraw_pin_logs — সবগুলোতেই
//     users(id) নির্দেশ করা কলাম ছিল, ফরেন কী ছিল না।
//   • users.reset_token-এ কোনো ইনডেক্স ছিল না, যদিও প্রতিটা পাসওয়ার্ড রিসেটে
//     WHERE reset_token = $1 দিয়ে খোঁজা হয়।
//   • users.google_id ও users.referral_code-এ UNIQUE কনস্ট্রেইন্টের পাশাপাশি হুবহু
//     একই কলামে দ্বিতীয় non-unique ইনডেক্স ছিল (নিখরচায় নয় — প্রতি লেখায় খরচ)।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');

async function makeUser() {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password)
     VALUES ('dbint_'||floor(random()*1e9), '019'||floor(random()*1e8), 'x') RETURNING id`
  );
  return r.rows[0].id;
}

async function makeMatch() {
  const r = await pool.query(
    `INSERT INTO matches (title, sport, team_a, team_b, status)
     VALUES ('DBInt Probe', 'cricket', 'A', 'B', 'upcoming') RETURNING id`
  );
  return r.rows[0].id;
}

async function makeAccumulator(userId) {
  const r = await pool.query(
    `INSERT INTO accumulators (user_id, stake, total_odd, potential_win, selection_count)
     VALUES ($1, 10, 2, 20, 1) RETURNING id`, [userId]
  );
  return r.rows[0].id;
}

describe('ফরেন কী — accumulator_selections', () => {
  let userId; let accaId; let matchId;

  beforeAll(async () => {
    userId = await makeUser();
    accaId = await makeAccumulator(userId);
    matchId = await makeMatch();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM accumulator_selections WHERE acca_id = $1', [accaId]);
    await pool.query('DELETE FROM accumulators WHERE id = $1', [accaId]);
    await pool.query('DELETE FROM matches WHERE id = $1', [matchId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  test('match_id-এ ফরেন কী কনস্ট্রেইন্ট বিদ্যমান', async () => {
    const r = await pool.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'fk_acca_sel_match'`
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].convalidated).toBe(true);
  });

  test('অস্তিত্বহীন match_id প্রত্যাখ্যাত হয়', async () => {
    await expect(
      pool.query(
        `INSERT INTO accumulator_selections (acca_id, match_id, odd) VALUES ($1, 999999999, 1.5)`,
        [accaId]
      )
    ).rejects.toMatchObject({ code: '23503' }); // foreign_key_violation
  });

  test('অস্তিত্বহীন market_id প্রত্যাখ্যাত হয়', async () => {
    await expect(
      pool.query(
        `INSERT INTO accumulator_selections (acca_id, market_id, odd) VALUES ($1, 999999999, 1.5)`,
        [accaId]
      )
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('বৈধ match_id গ্রহণ করা হয় — বিদ্যমান আচরণ ভাঙেনি', async () => {
    const r = await pool.query(
      `INSERT INTO accumulator_selections (acca_id, match_id, odd) VALUES ($1, $2, 1.5) RETURNING id`,
      [accaId, matchId]
    );
    expect(r.rows[0].id).toBeGreaterThan(0);
  });

  test('match_id NULL রাখা যায় — ঐচ্ছিক ফিল্ড হিসেবেই থাকে', async () => {
    const r = await pool.query(
      `INSERT INTO accumulator_selections (acca_id, match_id, odd) VALUES ($1, NULL, 1.5) RETURNING id`,
      [accaId]
    );
    expect(r.rows[0].id).toBeGreaterThan(0);
  });

  test('রেফারেন্স করা ম্যাচ মুছে অরফান তৈরি করা যায় না', async () => {
    await pool.query(
      `INSERT INTO accumulator_selections (acca_id, match_id, odd) VALUES ($1, $2, 2.0)`,
      [accaId, matchId]
    );
    await expect(
      pool.query('DELETE FROM matches WHERE id = $1', [matchId])
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('ফরেন কী — লগ/অডিট টেবিল (ON DELETE SET NULL)', () => {
  test('ইউজার মুছলে error_logs সারি থেকে যায়, user_id NULL হয়', async () => {
    const userId = await makeUser();
    await pool.query(`INSERT INTO error_logs (message, user_id) VALUES ('dbint_probe', $1)`, [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    const r = await pool.query(
      `SELECT user_id FROM error_logs WHERE message = 'dbint_probe' ORDER BY id DESC LIMIT 1`
    );
    expect(r.rows.length).toBe(1);        // অডিট ট্রেইল হারায়নি
    expect(r.rows[0].user_id).toBeNull(); // অরফান আইডি ঝুলে থাকেনি

    await pool.query(`DELETE FROM error_logs WHERE message = 'dbint_probe'`);
  });

  test('অস্তিত্বহীন user_id দিয়ে error_logs লেখা যায় না', async () => {
    await expect(
      pool.query(`INSERT INTO error_logs (message, user_id) VALUES ('bad', 999999999)`)
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('প্রত্যাশিত সব ফরেন কী তৈরি হয়েছে', async () => {
    const expected = [
      'fk_acca_sel_match', 'fk_acca_sel_market', 'fk_login_logs_user',
      'fk_error_logs_user', 'fk_chat_sender', 'fk_chat_receiver',
      'fk_news_author', 'fk_withdraw_pin_actor'
    ];
    const r = await pool.query(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`, [expected]
    );
    const found = r.rows.map((x) => x.conname);
    for (const name of expected) expect(found).toContain(name);
  });
});

describe('ইনডেক্স ইন্টিগ্রিটি', () => {
  test('users.reset_token-এ ইনডেক্স আছে (প্রতি পাসওয়ার্ড রিসেটে ব্যবহৃত)', async () => {
    const r = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename='users' AND indexname='idx_users_reset_token'`
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].indexdef).toMatch(/reset_token/);
  });

  test('accumulator_selections.match_id-এ ইনডেক্স আছে (FK যাচাই ও সেটলমেন্ট কোয়েরি)', async () => {
    const r = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE tablename='accumulator_selections' AND indexname='idx_acca_sel_match'`
    );
    expect(r.rows.length).toBe(1);
  });

  test('হুবহু ডুপ্লিকেট ইনডেক্স সরানো হয়েছে', async () => {
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_users_google_id','idx_users_referral')`
    );
    expect(r.rows).toEqual([]);
  });

  test('ডুপ্লিকেট সরানোর পরেও UNIQUE কনস্ট্রেইন্টের ইনডেক্স অক্ষত', async () => {
    const r = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE indexname IN ('users_google_id_key','users_referral_code_key')`
    );
    expect(r.rows.map((x) => x.indexname).sort()).toEqual(['users_google_id_key', 'users_referral_code_key']);
  });
});

describe('ইউনিক/ডুপ্লিকেট ইন্টিগ্রিটি (বিদ্যমান সুরক্ষা অক্ষত)', () => {
  test('ডুপ্লিকেট ইউজারনেম DB-লেভেলে আটকায়', async () => {
    const userId = await makeUser();
    const u = await pool.query('SELECT username, phone FROM users WHERE id = $1', [userId]);
    await expect(
      pool.query(`INSERT INTO users (username, phone, password) VALUES ($1, '01900000001', 'x')`,
        [u.rows[0].username])
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  test('একই প্রোভাইডারে ডুপ্লিকেট external_id আটকায়', async () => {
    const ext = 'dbint-' + Date.now();
    await pool.query(
      `INSERT INTO matches (title, sport, team_a, team_b, status, provider, external_id)
       VALUES ('p','cricket','A','B','upcoming','dbint-provider',$1)`, [ext]
    );
    await expect(
      pool.query(
        `INSERT INTO matches (title, sport, team_a, team_b, status, provider, external_id)
         VALUES ('p2','cricket','A','B','upcoming','dbint-provider',$1)`, [ext]
      )
    ).rejects.toMatchObject({ code: '23505' });
    await pool.query(`DELETE FROM matches WHERE provider = 'dbint-provider'`);
  });
});

describe('অর্থ/সংখ্যাগত ডেটা ইন্টিগ্রিটি', () => {
  test('আর্থিক কলামগুলো NUMERIC — কোনো floating point নেই', async () => {
    const r = await pool.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema='public'
         AND column_name IN ('coins','amount','stake','prize','balance','bonus_amount','demo_coins')`
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      // numeric বা integer গ্রহণযোগ্য; real/double precision নয় (গোলাকরণ ত্রুটি হয়)
      expect(['numeric', 'integer', 'bigint']).toContain(row.data_type);
    }
  });

  test('ব্যালেন্স ডেবিট atomic — নেগেটিভ ব্যালেন্স তৈরি হয় না', async () => {
    const userId = await makeUser();
    await pool.query('UPDATE users SET coins = 100 WHERE id = $1', [userId]);

    // অ্যাপের ডেবিট প্যাটার্ন: UPDATE ... WHERE coins >= $1 (check-then-update নয়)
    const debit = () => pool.query(
      'UPDATE users SET coins = coins - $1 WHERE id = $2 AND coins >= $1 RETURNING coins',
      [80, userId]
    );

    const results = await Promise.all([debit(), debit(), debit()]);
    const succeeded = results.filter((r) => r.rowCount === 1).length;

    expect(succeeded).toBe(1); // একসাথে তিনবার চেষ্টা করলেও একটাই সফল
    const after = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    expect(Number(after.rows[0].coins)).toBe(20);
    expect(Number(after.rows[0].coins)).toBeGreaterThanOrEqual(0);

    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });
});

describe('মাইগ্রেশন নিরাপত্তা', () => {
  test('মাইগ্রেশন বারবার চালালেও ভাঙে না (idempotent)', async () => {
    const runMigrations = require('../../migrations');
    await expect(runMigrations()).resolves.not.toThrow();

    // পুনরায় চালানোর পরেও কনস্ট্রেইন্ট একটাই থাকে, ডুপ্লিকেট হয় না
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM pg_constraint WHERE conname = 'fk_acca_sel_match'`
    );
    expect(r.rows[0].c).toBe(1);
  }, 240000);
});

describe('অরফান ডেটা সনাক্তকরণ', () => {
  test('ভ্যালিডেটেড FK-যুক্ত সম্পর্কগুলোতে কোনো অরফান নেই', async () => {
    const checks = [
      ['accumulator_selections', 'match_id', 'matches'],
      ['accumulator_selections', 'market_id', 'markets'],
      ['accumulator_selections', 'acca_id', 'accumulators'],
      ['bets', 'match_id', 'matches'],
      ['bets', 'user_id', 'users'],
      ['payment_requests', 'user_id', 'users'],
      ['coin_transactions', 'user_id', 'users'],
      ['referrals', 'referrer_id', 'users'],
      ['device_sessions', 'user_id', 'users']
    ];

    const orphans = [];
    for (const [table, column, refTable] of checks) {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM ${table} t
         WHERE t.${column} IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ${refTable} r WHERE r.id = t.${column})`
      );
      if (r.rows[0].c > 0) orphans.push(`${table}.${column} → ${refTable}: ${r.rows[0].c}`);
    }
    expect(orphans).toEqual([]);
  });
});
