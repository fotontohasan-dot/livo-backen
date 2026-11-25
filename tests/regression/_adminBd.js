// টেস্ট-সাহায্যকারী (এটি নিজে টেস্ট নয়): routes/admin.js রিপোর্ট-তারিখ রিগ্রেশন টেস্টগুলোর শেয়ার্ড অংশ।
// আসল Postgres + আসল HTTP। res.render শুধু call-through স্পাই (locals পড়তে; কিছু বদলায় না)।
const express = require('express');
const { pool } = require('../../db');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { cleanupUsers } = require('../helpers/cleanup');

// স্থির দিন D = 2026-03-10 (BD)। BD মধ্যরাত = UTC আগের দিন ১৮:০০। DB সেশন UTC, কলাম TIMESTAMP (naive UTC)।
//   BEFORE = BD ৯ মার্চ ২৩:৩০   | AFTER = BD ১০ মার্চ ০০:৩০ | LATE = BD ১০ মার্চ ২৩:৩০
//   EDGE   = BD ১১ মার্চ ০০:০০:০০ ঠিক (পরের দিনের প্রথম মুহূর্ত — `<=` হলে ভুলভাবে ১০ মার্চে ঢুকত)
//   NEXT   = BD ১১ মার্চ ০০:৩০
// UTC দিনে কাটলে: BEFORE+AFTER → ৯ মার্চ; LATE+EDGE+NEXT → ১০ মার্চ — অর্থাৎ পুরোনো কোডে ভুল বাকেট।
const SEED = {
  BEFORE: '2026-03-09 17:30:00',
  AFTER: '2026-03-09 18:30:00',
  LATE: '2026-03-10 17:30:00',
  EDGE: '2026-03-10 18:00:00',
  NEXT: '2026-03-10 18:30:00'
};
const D = '2026-03-10';

// pg `d::date` → JS Date (TZ=UTC), JSON → 'YYYY-MM-DD…' স্ট্রিং; দুটোই 'YYYY-MM-DD'-এ
const dayOf = (v) => (v && typeof v.toISOString === 'function' ? v.toISOString() : String(v)).slice(0, 10);
const entry = (arr, day) => (arr.find(x => dayOf(x.day) === day) || {});
const num = (v) => Number(v || 0);

function newCtx(label) {
  const TAG = `${label}${Date.now().toString(36).toUpperCase()}`;
  const ctx = {
    TAG, agent: null, adminId: null, userIds: [],
    last: {}, lastErr: {},
    origRender: express.response.render
  };

  ctx.installRenderSpy = () => {
    jest.spyOn(express.response, 'render').mockImplementation(function (view, opts, cb) {
      if (opts && typeof opts === 'object') (opts.loadError ? ctx.lastErr : ctx.last)[view] = opts;
      return ctx.origRender.call(this, view, opts, cb);
    });
  };

  ctx.login = async () => {
    const { agent, token } = await getCsrfAgent('/register');
    const username = uniqueUsername();
    await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
      username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123', _csrf: token });
    const r = await pool.query('UPDATE users SET role=$1 WHERE username=$2 RETURNING id', ['admin', username]);
    ctx.agent = agent; ctx.adminId = r.rows[0].id;
  };

  // পেজ GET → সেই ভিউয়ের locals
  ctx.page = async (path, view) => {
    delete ctx.last[view];
    delete ctx.lastErr[view];
    const res = await ctx.agent.get(path);
    if (ctx.lastErr[view]) throw new Error(`render('${view}') loadError (রুটের catch) দিয়ে হয়েছে: ${path}`);
    if (!ctx.last[view]) throw new Error(`render('${view}') হয়নি: ${path} → ${res.status}`);
    return ctx.last[view];
  };
  ctx.json = async (path) => {
    const r = await ctx.agent.get(path);
    expect(r.status).toBe(200);
    return r.body;
  };

  // ---- সিড ----
  ctx.dep = (type, label, when, amount, status = 'approved') => pool.query(
    `INSERT INTO payment_requests (user_id, type, method, amount, transaction_id, status, created_at, updated_at)
     VALUES ($1,$2,'bkash',$3,$4,$5,$6::timestamp,$6::timestamp)`,
    [ctx.adminId, type, amount, `${TAG}-${label}`, status, when]);
  ctx.bet = (label, when, stake, status, odd = 2) => pool.query(
    `INSERT INTO bets (user_id, stake, odd, status, created_at, client_ref) VALUES ($1,$2,$3,$4,$5::timestamp,$6)`,
    [ctx.adminId, stake, odd, status, when, `${TAG}-${label}`]);
  ctx.newUser = async (label, when) => {
    const r = await pool.query(
      `INSERT INTO users (username, phone, password, coins, created_at) VALUES ($1,$2,'x',0,$3::timestamp) RETURNING id`,
      [`${TAG}${label}`.slice(0, 18).toLowerCase(), uniquePhone(), when]);
    ctx.userIds.push(r.rows[0].id);
  };
  ctx.apiLog = (label, when) => pool.query(
    `INSERT INTO api_usage_logs (endpoint, method, status_code, response_time_ms, created_at) VALUES ($1,'GET',200,5,$2::timestamp)`,
    [`/${TAG}/${label}`, when]);
  ctx.botLog = (label, when, blocked = false) => pool.query(
    `INSERT INTO bot_activity_logs (ip, endpoint, risk_level, reason, blocked, created_at) VALUES ($1,$2,'low',$3,$4,$5::timestamp)`,
    ['203.0.113.77', `/${TAG}`, `${TAG}-${label}`, blocked, when]);
  ctx.fraudFlag = (label, when) => pool.query(
    `INSERT INTO fraud_flags (user_id, risk_level, reason, created_at) VALUES ($1,'low',$2,$3::timestamp)`,
    [ctx.adminId, `${TAG}-${label}`, when]);
  ctx.loginLog = (label, when) => pool.query(
    `INSERT INTO login_logs (user_id, ip, location, created_at) VALUES ($1,'203.0.113.78',$2,$3::timestamp)`,
    [ctx.adminId, `${TAG}-${label}`, when]);

  ctx.cleanup = async () => {
    jest.restoreAllMocks();
    const like = `${TAG}-%`;
    await pool.query('DELETE FROM payment_requests WHERE transaction_id LIKE $1', [like]).catch(() => {});
    await pool.query('DELETE FROM bets WHERE client_ref LIKE $1', [like]).catch(() => {});
    await pool.query('DELETE FROM api_usage_logs WHERE endpoint LIKE $1', [`/${TAG}%`]).catch(() => {});
    await pool.query('DELETE FROM bot_activity_logs WHERE reason LIKE $1', [like]).catch(() => {});
    await pool.query('DELETE FROM fraud_flags WHERE reason LIKE $1', [like]).catch(() => {});
    await pool.query('DELETE FROM login_logs WHERE location LIKE $1', [like]).catch(() => {});
    await cleanupUsers([...ctx.userIds, ctx.adminId]);
    await pool.end().catch(() => {});
  };
  return ctx;
}

module.exports = { newCtx, SEED, D, dayOf, entry, num };
