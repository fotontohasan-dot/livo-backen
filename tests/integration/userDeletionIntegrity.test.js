// tests/integration/userDeletionIntegrity.test.js
// ---------------------------------------------------------------------------
// PHASE 02 — নিরাপদ ইউজার ডিলিশন ও login_logs FK ভ্যালিডেশন।
// আসল PostgreSQL-এর বিরুদ্ধে চলে; ডাটাবেজের যে আচরণ পরীক্ষা করা হচ্ছে তা mock করা হয়নি।
//
// পটভূমি: users-এর দিকে ২৯টা ফরেন কী RESTRICT (payment_requests, bets,
// referral_commissions, kyc_requests ...), তাই আর্থিক রেকর্ডওয়ালা ইউজারের
// `DELETE FROM users` ব্যর্থ হয়। আগে অ্যাডমিন শুধু "ডিলিট করতে সমস্যা!" দেখতেন।
// এখন FK অক্ষত রেখেই — সুরক্ষিত রেকর্ড না থাকলে হার্ড ডিলিট, থাকলে অ্যানোনিমাইজ
// ও নিষ্ক্রিয়করণ।
// ---------------------------------------------------------------------------

const request = require('supertest');
const { pool } = require('../../db');
const { deleteOrDeactivateUser, UNUSABLE_PASSWORD } = require('../../services/userDeletion');
const { getCsrfAgent, uniqueUsername, uniquePhone, freshRequest } = require('../helpers/app');

async function makeUser() {
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, coins)
     VALUES ($1, $2, 'x', 100) RETURNING id, username`,
    [uniqueUsername(), uniquePhone()]
  );
  return r.rows[0];
}

async function giveFinancialRecord(userId) {
  await pool.query(
    `INSERT INTO payment_requests (user_id, type, amount, status)
     VALUES ($1, 'deposit', 500, 'approved')`, [userId]
  );
}

describe('login_logs ফরেন কী — চূড়ান্ত অবস্থা', () => {
  test('fk_login_logs_user বিদ্যমান এবং VALIDATED', async () => {
    const r = await pool.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'fk_login_logs_user'`
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].convalidated).toBe(true);
  });

  test('কোনো অরফান login_logs সারি অবশিষ্ট নেই', async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM login_logs l
        WHERE l.user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id)`
    );
    expect(r.rows[0].c).toBe(0);
  });

  test('deleted_user_id সেট থাকা প্রতিটা সারিতে user_id NULL — মেরামতের invariant', async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM login_logs
        WHERE deleted_user_id IS NOT NULL AND user_id IS NOT NULL`
    );
    expect(r.rows[0].c).toBe(0);
  });

  // Task: "migration behavior with existing orphan login_logs"
  // ফ্রেশ ডাটাবেজে কোনো অরফান থাকে না, তাই মেরামতের পথটা সত্যিই কাজ করে কিনা দেখতে
  // এখানে ইচ্ছাকৃতভাবে একটা অরফান তৈরি করা হয়: কনস্ট্রেইন্ট সাময়িকভাবে সরিয়ে, ইউজার
  // মুছে ফেলে অরফান সারি রেখে দেওয়া হয় — ঠিক যেভাবে FK যোগ হওয়ার আগে হতো। তারপর
  // মাইগ্রেশন চালিয়ে দেখা হয় সারিটা রক্ষা পেল, আইডি সংরক্ষিত হলো ও FK আবার VALID হলো।
  test('বিদ্যমান অরফান থাকলেও মাইগ্রেশন সারি না মুছে মেরামত করে ও FK ভ্যালিডেট করে', async () => {
    const user = await makeUser();
    const marker = `orphan-probe-${Date.now()}`;

    await pool.query('ALTER TABLE login_logs DROP CONSTRAINT IF EXISTS fk_login_logs_user');
    await pool.query(`INSERT INTO login_logs (user_id, ip) VALUES ($1, $2)`, [user.id, marker]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);

    // এখন সারিটা সত্যিই অরফান
    const orphanBefore = await pool.query(
      `SELECT user_id FROM login_logs WHERE ip = $1`, [marker]
    );
    expect(orphanBefore.rows[0].user_id).toBe(user.id);

    const totalBefore = await pool.query('SELECT COUNT(*)::int AS c FROM login_logs');

    const runMigrations = require('../../migrations');
    await runMigrations();

    const totalAfter = await pool.query('SELECT COUNT(*)::int AS c FROM login_logs');
    expect(totalAfter.rows[0].c).toBe(totalBefore.rows[0].c); // কোনো সারি মোছা হয়নি

    const repaired = await pool.query(
      `SELECT user_id, deleted_user_id, ip FROM login_logs WHERE ip = $1`, [marker]
    );
    expect(repaired.rows.length).toBe(1);
    expect(repaired.rows[0].user_id).toBeNull();            // SET NULL সিমান্টিক্স
    expect(repaired.rows[0].deleted_user_id).toBe(user.id); // মূল আইডি সংরক্ষিত
    expect(repaired.rows[0].ip).toBe(marker);               // অডিট ডেটা অক্ষত

    const fk = await pool.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'fk_login_logs_user'`
    );
    expect(fk.rows[0].convalidated).toBe(true); // অরফান মেরামতের পর ভ্যালিডেট হয়েছে

    await pool.query('DELETE FROM login_logs WHERE ip = $1', [marker]);
  }, 300000);

  test('অস্তিত্বহীন user_id দিয়ে নতুন login_logs সারি লেখা যায় না', async () => {
    await expect(
      pool.query(`INSERT INTO login_logs (user_id, ip) VALUES (999999999, '1.2.3.4')`)
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('ইউজার হার্ড-ডিলিট হলে login_logs সারি থেকে যায়, user_id NULL হয়', async () => {
    const user = await makeUser();
    await pool.query(`INSERT INTO login_logs (user_id, ip) VALUES ($1, '9.9.9.9')`, [user.id]);

    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);

    const r = await pool.query(`SELECT user_id FROM login_logs WHERE ip = '9.9.9.9'`);
    expect(r.rows.length).toBe(1);          // অডিট সারি হারায়নি
    expect(r.rows[0].user_id).toBeNull();   // ON DELETE SET NULL কার্যকর
    await pool.query(`DELETE FROM login_logs WHERE ip = '9.9.9.9'`);
  });
});

describe('ইউজার ডিলিশন — সুরক্ষিত রেকর্ড নেই', () => {
  test('সত্যিকারের হার্ড ডিলিট হয় (আগের আচরণ অক্ষত)', async () => {
    const user = await makeUser();

    const outcome = await deleteOrDeactivateUser(user.id, 'test-admin');
    expect(outcome.mode).toBe('deleted');

    const r = await pool.query('SELECT id FROM users WHERE id = $1', [user.id]);
    expect(r.rows.length).toBe(0);
  });

  test('অস্তিত্বহীন ইউজারে not_found ফেরত দেয়', async () => {
    const outcome = await deleteOrDeactivateUser(999999999, 'test-admin');
    expect(outcome.mode).toBe('not_found');
  });
});

describe('ইউজার ডিলিশন — সুরক্ষিত আর্থিক রেকর্ড আছে', () => {
  let user;
  let outcome;

  beforeAll(async () => {
    user = await makeUser();
    await giveFinancialRecord(user.id);
    outcome = await deleteOrDeactivateUser(user.id, 'test-admin');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM payment_requests WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]).catch(() => {});
  });

  test('হার্ড ডিলিট হয় না — deactivated ফেরত দেয়', () => {
    expect(outcome.mode).toBe('deactivated');
  });

  test('ইউজার সারি টিকে থাকে (হিসাবরক্ষণের রেফারেন্সের জন্য)', async () => {
    const r = await pool.query('SELECT id, is_banned, deleted_at FROM users WHERE id = $1', [user.id]);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].is_banned).toBe(true);
    expect(r.rows[0].deleted_at).not.toBeNull();
  });

  test('ব্যক্তিগত তথ্য অ্যানোনিমাইজ হয়েছে', async () => {
    const r = await pool.query('SELECT username, email, phone, password FROM users WHERE id = $1', [user.id]);
    expect(r.rows[0].username).toBe(`deleted_user_${user.id}`);
    expect(r.rows[0].username).not.toBe(user.username);
    expect(r.rows[0].email).toBeNull();
    expect(r.rows[0].phone).toBeNull();
    expect(r.rows[0].password).toBe(UNUSABLE_PASSWORD);
  });

  test('আর্থিক রেকর্ড সম্পূর্ণ অক্ষত — কোনো cascade ডিলিট হয়নি', async () => {
    const r = await pool.query(
      `SELECT amount, type, status FROM payment_requests WHERE user_id = $1`, [user.id]
    );
    expect(r.rows.length).toBe(1);
    expect(Number(r.rows[0].amount)).toBe(500);
    expect(r.rows[0].type).toBe('deposit');
    expect(r.rows[0].status).toBe('approved');
  });

  test('আর্থিক FK RESTRICT দুর্বল করা হয়নি', async () => {
    const r = await pool.query(
      `SELECT rc.delete_rule FROM information_schema.referential_constraints rc
       WHERE rc.constraint_name = 'payment_requests_user_id_fkey'`
    );
    expect(r.rows[0].delete_rule).toBe('NO ACTION');
  });

  test('অ্যানোনিমাইজেশন idempotent — দ্বিতীয়বার চালালেও ভাঙে না', async () => {
    const again = await deleteOrDeactivateUser(user.id, 'test-admin');
    expect(again.mode).toBe('deactivated');
    const r = await pool.query('SELECT username FROM users WHERE id = $1', [user.id]);
    expect(r.rows[0].username).toBe(`deleted_user_${user.id}`);
  });
});

describe('সেশন বাতিলকরণ ও লগইন প্রতিরোধ', () => {
  test('নিষ্ক্রিয় করার পর ইউজার আর অথেন্টিকেট করতে পারে না', async () => {
    // আসল রেজিস্ট্রেশন দিয়ে ইউজার তৈরি, যাতে পাসওয়ার্ড hash আসল হয়
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    const password = 'SecurePass123';
    await agent.post('/register').type('form').send({
      username, phone: uniquePhone(), password, confirmPassword: password, _csrf: token
    });

    const created = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    const userId = created.rows[0].id;

    // লগইন করা সেশন সত্যিই কাজ করছে
    const before = await agent.get('/profile');
    expect(before.status).toBe(200);

    await giveFinancialRecord(userId);
    const outcome = await deleteOrDeactivateUser(userId, 'test-admin');
    expect(outcome.mode).toBe('deactivated');

    // পুরনো সেশন আর সুরক্ষিত পেজে ঢুকতে পারে না
    const after = await agent.get('/profile');
    expect(after.status).toBe(302);

    // পুরনো ক্রেডেনশিয়ালে নতুন লগইনও সম্ভব নয়
    const login = await getCsrfAgent('/login');
    const res = await login.agent.post('/login').type('form')
      .send({ username, password, _csrf: login.token });
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toMatch(/\/profile|\/$/);

    const stillOut = await login.agent.get('/profile');
    expect(stillOut.status).toBe(302);

    await pool.query('DELETE FROM payment_requests WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  });

  test('device_sessions সারি revoked হিসেবে চিহ্নিত হয়', async () => {
    const user = await makeUser();
    await pool.query(
      `INSERT INTO device_sessions (user_id, sid, device_name, ip)
       VALUES ($1, $2, 'Probe', '1.1.1.1')`, [user.id, `sid-del-${user.id}`]
    );
    await giveFinancialRecord(user.id);

    await deleteOrDeactivateUser(user.id, 'test-admin');

    const r = await pool.query(
      'SELECT revoked_at FROM device_sessions WHERE user_id = $1', [user.id]
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].revoked_at).not.toBeNull();

    await pool.query('DELETE FROM device_sessions WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM payment_requests WHERE user_id = $1', [user.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]).catch(() => {});
  });
});

describe('মাইগ্রেশন idempotency (login_logs মেরামতসহ)', () => {
  test('মাইগ্রেশন দুইবার চালালেও ভাঙে না ও FK VALID থাকে', async () => {
    const runMigrations = require('../../migrations');
    const before = await pool.query('SELECT COUNT(*)::int AS c FROM login_logs');

    await runMigrations();
    await runMigrations();

    const after = await pool.query('SELECT COUNT(*)::int AS c FROM login_logs');
    expect(after.rows[0].c).toBe(before.rows[0].c); // কোনো সারি হারায়নি

    const fk = await pool.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'fk_login_logs_user'`
    );
    expect(fk.rows[0].convalidated).toBe(true);

    const dupes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM pg_constraint WHERE conname = 'fk_login_logs_user'`
    );
    expect(dupes.rows[0].c).toBe(1);
  }, 300000);
});
