// tests/security/authorizationBoundary.test.js
// ---------------------------------------------------------------------------
// PHASE 09 — অথরাইজেশন, IDOR/BOLA ও প্রিভিলেজ-বাউন্ডারি।
//
// এই অডিটে কোনো শোষণযোগ্য দুর্বলতা পাওয়া যায়নি। কিন্তু যে সীমানাগুলো হাতে-কলমে
// (দুটো আসল ইউজার দিয়ে) যাচাই করা হয়েছে, সেগুলো এখানে লক করা হচ্ছে — যাতে ভবিষ্যতে
// কোনো রিফ্যাক্টর নীরবে ওই সুরক্ষা সরিয়ে ফেললে টেস্ট ধরে ফেলে।
//
// প্রতিটা describe ব্লক একটা আসল আক্রমণ-প্যাটার্ন যাচাই করে, ইমপ্লিমেন্টেশন মিরর করে না:
//   • অনুভূমিক: B কি A-র রিসোর্স পড়তে/বদলাতে/মুছতে পারে?
//   • উল্লম্ব: সাধারণ ইউজার কি অ্যাডমিন মিউটেশন চালাতে পারে?
//   • auth-state: ব্যান/অ্যানোনিমাইজ/সেশন-রিভোকের পর পুরনো সেশন কি কাজ করে?
//   • টোকেন: রিসেট টোকেন কি একবারের বেশি ব্যবহার করা যায়?
//   • এনিউমারেশন: অস্তিত্বশীল বনাম অনস্তিত্ব অ্যাকাউন্টের উত্তর কি আলাদা?
//
// আসল PostgreSQL ও আসল Redis ব্যবহার করা হয়।
// ---------------------------------------------------------------------------

const { pool } = require('../../db');
const cache = require('../../services/cache');
const cacheKeys = require('../../services/cacheKeys');
const { getCsrfAgent, uniqueUsername, uniquePhone, freshRequest } = require('../helpers/app');

async function makeUser() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123',
    confirmPassword: 'SecurePass123', _csrf: token
  });
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  const page = await agent.get('/profile');
  const csrf = /<meta name="csrf-token" content="([^"]*)"/.exec(page.text)[1];
  return { agent, username, userId: r.rows[0].id, csrf };
}

async function dropUser(id) {
  for (const t of ['free_bets', 'device_sessions', 'bank_cards', 'payment_requests', 'coin_transactions']) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]).catch(() => {});
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
}

describe('অনুভূমিক প্রিভিলেজ — B কি A-র রিসোর্সে হাত দিতে পারে', () => {
  let A; let B; let cardId; let deviceId; let freeBetId;

  beforeAll(async () => {
    A = await makeUser();
    B = await makeUser();

    await pool.query(
      `INSERT INTO bank_cards (user_id, bank_name, account_number, holder_name)
       VALUES ($1, 'ProbeBank', 'A-ONLY-SECRET', 'A Holder')`, [A.userId]
    );
    cardId = (await pool.query('SELECT id FROM bank_cards WHERE user_id = $1', [A.userId])).rows[0].id;

    await pool.query(
      `INSERT INTO device_sessions (user_id, sid, device_name, ip)
       VALUES ($1, $2, 'A Device', '1.1.1.1')`, [A.userId, `sid-A-${A.userId}`]
    );
    deviceId = (await pool.query('SELECT id FROM device_sessions WHERE user_id = $1', [A.userId])).rows[0].id;

    await pool.query(`INSERT INTO free_bets (user_id, amount, status) VALUES ($1, 50, 'active')`, [A.userId]);
    freeBetId = (await pool.query('SELECT id FROM free_bets WHERE user_id = $1', [A.userId])).rows[0].id;
  });

  afterAll(async () => {
    await dropUser(A.userId);
    await dropUser(B.userId);
  });

  test('B, A-র ব্যাংক কার্ড মুছতে পারে না (দুটো রুটেই)', async () => {
    await B.agent.post(`/profile/cards/delete/${cardId}`)
      .set('X-CSRF-Token', B.csrf).type('form').send({});
    await B.agent.post(`/profile/delete-bank-card/${cardId}`)
      .set('X-CSRF-Token', B.csrf).type('form').send({});

    const still = await pool.query('SELECT id FROM bank_cards WHERE id = $1', [cardId]);
    expect(still.rows.length).toBe(1); // কার্ড অক্ষত
  });

  test('B, A-র ডিভাইস সেশন রিভোক করতে পারে না', async () => {
    await B.agent.post(`/profile/devices/${deviceId}/logout`)
      .set('X-CSRF-Token', B.csrf).type('form').send({});

    const r = await pool.query('SELECT revoked_at FROM device_sessions WHERE id = $1', [deviceId]);
    expect(r.rows[0].revoked_at).toBeNull();
  });

  test('B, A-র ফ্রি বেট ক্লেইম করতে পারে না', async () => {
    await B.agent.post(`/profile/freebet/claim/${freeBetId}`)
      .set('X-CSRF-Token', B.csrf).type('form').send({});

    const r = await pool.query('SELECT status FROM free_bets WHERE id = $1', [freeBetId]);
    expect(r.rows[0].status).toBe('active');
  });

  test('B-র পেজে A-র ব্যাংক অ্যাকাউন্ট নম্বর দেখা যায় না', async () => {
    for (const p of ['/profile/cards', '/profile/security', '/profile']) {
      const res = await B.agent.get(p);
      expect(res.text || '').not.toContain('A-ONLY-SECRET');
    }
  });

  test('মালিক নিজে পারে — সুরক্ষা বৈধ ব্যবহার আটকায়নি', async () => {
    await A.agent.post(`/profile/devices/${deviceId}/logout`)
      .set('X-CSRF-Token', A.csrf).type('form').send({});
    const r = await pool.query('SELECT revoked_at FROM device_sessions WHERE id = $1', [deviceId]);
    expect(r.rows[0].revoked_at).not.toBeNull();
  });
});

describe('উল্লম্ব প্রিভিলেজ — সাধারণ ইউজার বনাম অ্যাডমিন', () => {
  let U; let victim;

  beforeAll(async () => {
    U = await makeUser();
    victim = await makeUser();
    await pool.query('UPDATE users SET coins = 100 WHERE id = $1', [victim.userId]);
  });

  afterAll(async () => {
    await dropUser(U.userId);
    await dropUser(victim.userId);
  });

  const adminPages = [
    '/admin', '/admin/users', '/admin/backups', '/admin/games', '/admin/telegram',
    '/admin/leaderboard', '/admin/system-diagnostics', '/admin/api/system-diagnostics',
    '/admin/api/analytics'
  ];

  test.each(adminPages)('সাধারণ ইউজার %s দেখতে পায় না', async (p) => {
    const res = await U.agent.get(p);
    expect(res.status).not.toBe(200);
  });

  test('সাধারণ ইউজার অ্যাডমিন মিউটেশন চালাতে পারে না, ভিকটিমের ডেটা অক্ষত থাকে', async () => {
    const mutations = [
      [`/admin/users/${victim.userId}/ban`, {}],
      [`/admin/users/${victim.userId}/delete`, {}],
      [`/admin/users/${victim.userId}/coins/add`, { amount: 999999 }],
      ['/admin/games/add', { name: 'hack' }],
      ['/admin/telegram/token', { token: 'hack' }],
      ['/payment/admin/approve/1', {}],
      ['/admin/api/withdrawals/1/reject', {}]
    ];

    for (const [p, body] of mutations) {
      const res = await U.agent.post(p).set('X-CSRF-Token', U.csrf).type('form').send(body);
      expect(res.status).not.toBe(200);
    }

    const v = await pool.query('SELECT coins, is_banned FROM users WHERE id = $1', [victim.userId]);
    expect(v.rows.length).toBe(1);            // মুছে যায়নি
    expect(Number(v.rows[0].coins)).toBe(100); // কয়েন বাড়েনি
    expect(v.rows[0].is_banned).toBe(false);   // ব্যান হয়নি
  });

  test('লগআউট অবস্থায় অ্যাডমিন API সরাসরি কল করা যায় না', async () => {
    for (const p of ['/admin/api/analytics', '/admin/api/system-diagnostics']) {
      const res = await freshRequest().get(p);
      expect(res.status).not.toBe(200);
    }
  });
});

describe('auth-state বদলের পর পুরনো সেশন', () => {
  test('ব্যান করার পর পুরনো সেশন সুরক্ষিত পেজে ঢুকতে পারে না', async () => {
    const U = await makeUser();
    expect((await U.agent.get('/profile')).status).toBe(200);

    await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [U.userId]);
    await cache.del(cacheKeys.userActiveStatus(U.userId)).catch(() => {});

    expect((await U.agent.get('/profile')).status).toBe(302);
    expect((await U.agent.get('/profile/api/balance')).status).toBe(302);

    await dropUser(U.userId);
  });

  test('অ্যানোনিমাইজ করার পর পুরনো সেশন কাজ করে না', async () => {
    const U = await makeUser();
    await pool.query(
      `INSERT INTO payment_requests (user_id, type, amount, status)
       VALUES ($1, 'deposit', 100, 'approved')`, [U.userId]
    );

    const { deleteOrDeactivateUser } = require('../../services/userDeletion');
    const outcome = await deleteOrDeactivateUser(U.userId, 'phase09-test');
    expect(outcome.mode).toBe('deactivated');

    expect((await U.agent.get('/profile')).status).toBe(302);
    await dropUser(U.userId);
  });

  test('সব সেশন রিভোক করার পর পুরনো সেশন কাজ করে না', async () => {
    const U = await makeUser();
    expect((await U.agent.get('/profile')).status).toBe(200);

    const { revokeAllOtherSessions } = require('../../services/deviceTracking');
    await revokeAllOtherSessions(U.userId, '', 'phase09-test');

    expect((await U.agent.get('/profile')).status).toBe(302);
    await dropUser(U.userId);
  });
});

describe('টোকেন সীমানা', () => {
  test('রিসেট টোকেন একবারই ব্যবহার করা যায়, রিপ্লে হয় না', async () => {
    const U = await makeUser();
    const token = `phase09probe${Date.now()}`;
    await pool.query(
      `UPDATE users SET reset_token = $2, reset_token_expiry = NOW() + INTERVAL '1 hour' WHERE id = $1`,
      [U.userId, token]
    );

    const first = await getCsrfAgent(`/reset-password/${token}`);
    await first.agent.post(`/reset-password/${token}`).type('form')
      .send({ password: 'BrandNewPass12', confirmPassword: 'BrandNewPass12', _csrf: first.token });

    const consumed = await pool.query('SELECT reset_token FROM users WHERE id = $1', [U.userId]);
    expect(consumed.rows[0].reset_token).toBeNull();

    // একই টোকেন দ্বিতীয়বার — পাসওয়ার্ড আর বদলানো যাবে না
    const hashBefore = (await pool.query('SELECT password FROM users WHERE id = $1', [U.userId])).rows[0].password;
    const second = await getCsrfAgent('/login');
    await second.agent.post(`/reset-password/${token}`).type('form')
      .send({ password: 'AttackerPass9', confirmPassword: 'AttackerPass9', _csrf: second.token });
    const hashAfter = (await pool.query('SELECT password FROM users WHERE id = $1', [U.userId])).rows[0].password;

    expect(hashAfter).toBe(hashBefore);

    await dropUser(U.userId);
  });

  test('অবৈধ রিসেট টোকেন কোনো তথ্য ফাঁস করে না', async () => {
    const res = await freshRequest().get('/reset-password/not-a-real-token-xyz');
    expect(res.status).toBe(302);
    expect(res.text || '').not.toMatch(/SELECT|node_modules|at Object\./);
  });
});

describe('অ্যাকাউন্ট এনিউমারেশন', () => {
  test('forgot-password অস্তিত্বশীল ও অনস্তিত্ব ইমেইলে একই উত্তর দেয়', async () => {
    const U = await makeUser();

    const a = await getCsrfAgent('/forgot-password');
    const known = await a.agent.post('/forgot-password').type('form')
      .send({ email: `${U.username}@probe.test`, _csrf: a.token });
    const b = await getCsrfAgent('/forgot-password');
    const unknown = await b.agent.post('/forgot-password').type('form')
      .send({ email: 'definitely-no-such-user-xyz@probe.test', _csrf: b.token });

    expect(known.status).toBe(unknown.status);
    expect(known.headers.location || '').toBe(unknown.headers.location || '');

    await dropUser(U.userId);
  });

  test('লগইন ভুল পাসওয়ার্ড ও অজানা ইউজারে একই উত্তর দেয়', async () => {
    const U = await makeUser();

    const a = await getCsrfAgent('/login');
    const wrongPw = await a.agent.post('/login').type('form')
      .send({ username: U.username, password: 'WrongPass999', _csrf: a.token });
    const b = await getCsrfAgent('/login');
    const noUser = await b.agent.post('/login').type('form')
      .send({ username: 'no-such-user-xyz-123', password: 'WrongPass999', _csrf: b.token });

    expect(wrongPw.status).toBe(noUser.status);
    expect(wrongPw.headers.location || '').toBe(noUser.headers.location || '');

    await dropUser(U.userId);
  });
});

describe('ক্লায়েন্ট-নিয়ন্ত্রিত পরিচয় ব্যবহার করা হয় না', () => {
  test('কোনো রুট req.body/req.query থেকে user_id নেয় না', () => {
    const fs = require('fs');
    const path = require('path');
    for (const dir of ['routes', 'services']) {
      const base = path.join(__dirname, '..', '..', dir);
      for (const f of fs.readdirSync(base).filter((x) => x.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(base, f), 'utf8');
        expect(src).not.toMatch(/req\.(body|query)\.(user_id|userId|account_id|accountId)\b/);
      }
    }
  });
});
