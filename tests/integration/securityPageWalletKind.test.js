// bank_cards.wallet_kind কলাম migration-এ বানানো হয় (আগে কোনো migration বানাত না) — না থাকলে
// /profile/security-র কার্ড SELECT ভেঙে পাতা "degraded" (loadError) মোডে রেন্ডার হতো। আসল Postgres।
const { app, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');

async function loggedInAgent() {
  const email = `${uniqueUsername('wk')}@example.test`; const pw = 'SecurePass123';
  const reg = await getCsrfAgent('/register');
  const r = await reg.agent.post('/register').type('form').send({
    username: uniqueUsername('wk'), email, phone: uniquePhone(), password: pw, confirmPassword: pw, _csrf: reg.token });
  expect(r.status).toBe(302);
  const { agent, token } = await getCsrfAgent('/login');
  const l = await agent.post('/login').set('User-Agent', REALISTIC_UA).type('form').send({ identifier: email, password: pw, _csrf: token });
  expect(l.status).toBe(302);
  return agent;
}

describe('bank_cards.wallet_kind migration ও security পাতা', () => {
  test('কলাম আছে: TEXT NOT NULL DEFAULT ewallet', async () => {
    const r = await pool.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'bank_cards' AND column_name = 'wallet_kind'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].data_type).toBe('text');
    expect(r.rows[0].is_nullable).toBe('NO');
    expect(r.rows[0].column_default).toMatch(/'ewallet'/);
  });

  test('কার্ডহীন ইউজারের /profile/security কোনো degraded লগ ছাড়া 200 রেন্ডার হয়', async () => {
    const agent = await loggedInAgent();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await agent.get('/profile/security');
      expect(res.status).toBe(200);
      const msgs = spy.mock.calls.map((c) => c.join(' '));
      expect(msgs.filter((m) => /security page error|wallet_kind/.test(m))).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  // শেষে রাখা: এটা কলাম বানিয়ে ফেলতে পারে, তাই আগের টেস্টগুলোর ফলাফল প্রভাবিত করে না
  test('migration আবার চালালে (idempotent) কিছু ভাঙে না', async () => {
    await expect(pool.query(`ALTER TABLE bank_cards ADD COLUMN IF NOT EXISTS wallet_kind TEXT NOT NULL DEFAULT 'ewallet'`)).resolves.toBeDefined();
  });
});
