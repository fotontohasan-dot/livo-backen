// tests/security/metricsAuthBanCheck.test.js
// ---------------------------------------------------------------------------
// HIGH-4 — ban-bypass-এর চতুর্থ কপি
//
// middleware/metricsAuth.js শুধু role দেখত, ban/deleted state নয়। ফলে ban
// করা admin-এর session দিয়ে /metrics পড়া যেত — যেখানে request volume,
// error rate, queue depth ইত্যাদি operational তথ্য থাকে।
//
// এটি একই bug class-এর চতুর্থ অবস্থান (আগে: middleware/auth.js,
// routes/chat.js, services/socket.js)।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA, freshRequest } = require('../helpers/app');

const PASSWORD = 'SecurePass123';

async function makeLoggedInUser(role = 'user') {
  const username = uniqueUsername('mx');
  const phone = uniquePhone();
  const hash = await bcrypt.hash(PASSWORD, 10);
  const r = await pool.query(
    `INSERT INTO users (username, phone, password, role) VALUES ($1,$2,$3,$4) RETURNING id`,
    [username, phone, hash, role]
  );
  const { agent, token } = await getCsrfAgent('/login');
  await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form')
    .send({ identifier: phone, password: PASSWORD, _csrf: token });
  return { agent, id: r.rows[0].id, username, phone };
}

describe('HIGH-4: /metrics ban enforcement', () => {
  test('unauthenticated request /metrics পড়তে পারে না', async () => {
    const res = await freshRequest().get('/metrics');
    expect(res.status).toBe(401);
  });

  test('সাধারণ user /metrics পড়তে পারে না', async () => {
    const user = await makeLoggedInUser('user');
    const res = await user.agent.get('/metrics');
    expect(res.status).toBe(401);
  });

  test('সক্রিয় admin /metrics পড়তে পারে (zero-regression)', async () => {
    const user = await makeLoggedInUser('user');
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);

    const res = await user.agent.get('/metrics');
    expect(res.status).toBe(200);
  });

  test('ban করা admin /metrics পড়তে পারে না', async () => {
    const user = await makeLoggedInUser('user');
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    expect((await user.agent.get('/metrics')).status).toBe(200);

    //   session ,  ban 
    await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [user.id]);

    const res = await user.agent.get('/metrics');
    expect(res.status).toBe(401);
    expect(res.text).not.toMatch(/process_cpu|nodejs_|http_request/);
  });

  test('soft-deleted admin /metrics পড়তে পারে না', async () => {
    const user = await makeLoggedInUser('user');
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [user.id]);
    expect((await user.agent.get('/metrics')).status).toBe(200);

    await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [user.id]);

    expect((await user.agent.get('/metrics')).status).toBe(401);
  });

  test('source-এ ban/deleted যাচাই বিদ্যমান', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'middleware', 'metricsAuth.js'), 'utf8'
    );
    expect(src).toMatch(/SELECT role, is_banned, deleted_at FROM users/);
    expect(src).toMatch(/!row\.is_banned && !row\.deleted_at/);
    //  role-only check   
    expect(src).not.toMatch(/SELECT role FROM users WHERE id = \$1/);
  });
});
