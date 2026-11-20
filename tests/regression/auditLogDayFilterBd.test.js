// tests/regression/auditLogDayFilterBd.test.js
// অ্যাডমিন audit-log তারিখ-ফিল্টার (from/to = ব্যবসায়িক Asia/Dhaka দিন)। আগে: `created_at >= 'YYYY-MM-DD'`
// (UTC মধ্যরাত) ও `created_at <= to::date + 1 day` (পরের UTC মধ্যরাত, সীমাসহ) — দুটোই BD দিনের সীমা থেকে ৬ ঘণ্টা সরে।
// আসল Postgres; audit_logs.created_at TIMESTAMPTZ। ঘড়ি স্থির করার দরকার নেই (from/to ইউজার-দেওয়া তারিখ)।
const { pool } = require('../../db');
const { listAuditLogs } = require('../../services/auditLog');

jest.setTimeout(60000);
const TAG = `ALB${Date.now().toString(36)}`;
const ins = (label, ts) => pool.query(
  `INSERT INTO audit_logs (actor_type, actor_username, action, category, status, risk_level, details)
   VALUES ('admin',$1,$2,'other','success','low','{}')`, [TAG, `${TAG}-${label}`]
).then(() => pool.query(`UPDATE audit_logs SET created_at=$1::timestamptz WHERE action=$2`, [ts, `${TAG}-${label}`]));
const labels = async (filters) =>
  (await listAuditLogs({ q: TAG, ...filters }, { page: 1, limit: 100 })).rows.map(r => r.action.replace(`${TAG}-`, '')).sort();

beforeAll(async () => {
  await ins('EARLY', '2026-03-09T19:00:00Z');  // BD ১০ মার্চ ০১:০০
  await ins('LATE', '2026-03-10T17:59:00Z');   // BD ১০ মার্চ ২৩:৫৯
  await ins('PREV', '2026-03-09T17:59:00Z');   // BD ৯ মার্চ ২৩:৫৯
  await ins('EDGE', '2026-03-10T18:00:00Z');   // BD ১১ মার্চ ০০:০০:০০ ঠিক
  await ins('NEXT', '2026-03-10T18:00:10Z');   // BD ১১ মার্চ ০০:০০:১০
});
afterAll(async () => {
  await pool.query('DELETE FROM audit_logs WHERE actor_username=$1', [TAG]).catch(() => {});
  await pool.end().catch(() => {});
});

test('from=to=2026-03-10 → BD ১০ মার্চের দুটো সারি (০১:০০ ও ২৩:৫৯); ৯ ও ১১ মার্চেরটা নয়', async () => {
  expect(await labels({ from: '2026-03-10', to: '2026-03-10' })).toEqual(['EARLY', 'LATE']);
});
test('to=2026-03-10: ঠিক BD ১১ মার্চ ০০:০০:০০-এর সারি বাদ (পরের দিনের শুরু)', async () => {
  expect(await labels({ to: '2026-03-10' })).toEqual(expect.not.arrayContaining(['EDGE', 'NEXT']));
  expect(await labels({ to: '2026-03-10' })).toEqual(expect.arrayContaining(['EARLY', 'LATE', 'PREV']));
});
test('from=2026-03-11 → ১১ মার্চ ০০:০০:০০ থেকে: EDGE ও NEXT', async () => {
  expect(await labels({ from: '2026-03-11', to: '2026-03-11' })).toEqual(['EDGE', 'NEXT']);
});
test('আগের মতো: তারিখ-ফরম্যাট ছাড়া from (টাইমস্ট্যাম্প) অপরিবর্তিত কাজ করে', async () => {
  expect(await labels({ from: '2026-03-10T18:00:05Z' })).toEqual(['NEXT']);
});
