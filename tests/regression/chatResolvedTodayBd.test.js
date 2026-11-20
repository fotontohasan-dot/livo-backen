// tests/regression/chatResolvedTodayBd.test.js
// GET <chat>/admin/stats-এর "resolved" = আজ সমাধান-করা কনভারসেশন; "আজ" এখন Asia/Dhaka দিন
// (আগে `date_trunc('day', NOW())` = DB-টাইমজোনের (UTC) মধ্যরাত)। আসল Postgres + HTTP, শুধু Date ঘড়ি স্থির।
// শুধু "আজ"-এর সীমানা বদলেছে; total/active/pending গণনা অপরিবর্তিত।
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { cleanupUsers } = require('../helpers/cleanup');
const { at } = require('./_bdClock');

jest.setTimeout(60000);
let agent, adminId; const userIds = [];

async function convo(utcResolvedAt) {
  const tag = `${Date.now().toString(36)}${userIds.length}`.slice(-9);
  const u = await pool.query(
    `INSERT INTO users (username, phone, password, coins, support_status, support_status_updated_at)
     VALUES ($1,$2,'x',0,'resolved',$3::timestamp) RETURNING id`,
    [`cs${tag}`, uniquePhone(), utcResolvedAt]);
  userIds.push(u.rows[0].id);
  await pool.query(`INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin) VALUES ($1,NULL,'hi',false)`, [u.rows[0].id]);
}
const resolved = async (isoNow) =>
  (await at(isoNow, () => agent.get('/chat/admin/stats'))).body.resolved;

beforeAll(async () => {
  const { agent: a, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await a.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
  const r = await pool.query('UPDATE users SET role=$1 WHERE username=$2 RETURNING id', ['admin', username]);
  agent = a; adminId = r.rows[0].id;
  // বেসলাইন: এই DB-তে আগে থেকে থাকা resolved সারি গণনায় ঢুকে না পড়ুক — আমরা পার্থক্য মাপি।
});
afterAll(async () => {
  await pool.query('DELETE FROM chat_messages WHERE sender_id = ANY($1)', [userIds]).catch(() => {});
  await cleanupUsers([...userIds, adminId]);
  await pool.end().catch(() => {});
});

test('BD ১০ মার্চ ০১:০০-এ (UTC ৯ মার্চ ১৯:০০) resolved: ১০ মার্চ ২৩:৫৯:৩০-এ আজকের গণনায় ঢোকে; ১১ মার্চ ০০:০০:৩০-এ নয়', async () => {
  const base1 = await resolved('2026-03-10T17:59:30Z');
  const base2 = await resolved('2026-03-10T18:00:30Z');
  await convo('2026-03-09 19:00:00');
  expect(await resolved('2026-03-10T17:59:30Z')).toBe(base1 + 1);
  expect(await resolved('2026-03-10T18:00:30Z')).toBe(base2);
});

test('BD ১০ মার্চ ২৩:৩০-এ (UTC ১৭:৩০) resolved: ১০ মার্চ ২৩:৫৯:৩০-এ গণনায় থাকে', async () => {
  const base = await resolved('2026-03-10T17:59:30Z');
  await convo('2026-03-10 17:30:00');
  expect(await resolved('2026-03-10T17:59:30Z')).toBe(base + 1);
});

test('BD ১১ মার্চ ০০:০০:১০-এ (UTC ১০ মার্চ ১৮:০০:১০) resolved: ১০ মার্চ ২৩:৫৯:৩০-এ নয়, ১১ মার্চ ০০:০০:৩০-এ গণনায়', async () => {
  const base1 = await resolved('2026-03-10T17:59:30Z');
  const base2 = await resolved('2026-03-10T18:00:30Z');
  await convo('2026-03-10 18:00:10');
  expect(await resolved('2026-03-10T17:59:30Z')).toBe(base1);
  expect(await resolved('2026-03-10T18:00:30Z')).toBe(base2 + 1);
});
