// tests/render/adminDashboardOperational.test.js
// ---------------------------------------------------------------------------
// ড্যাশবোর্ডের অপারেশনাল উপযোগিতা (Phase 6) ও পরিসংখ্যান নির্ভুলতা।
//
// যে বাগগুলো এই টেস্ট লক করছে — দুটোই নীরব ছিল, কারণ `|| 0` fallback
// অনুপস্থিত ভেরিয়েবলকে বৈধ শূন্য বানিয়ে দিচ্ছিল:
//
//   ১. views/admin/dashboard.ejs `stats.pending_kyc` ও `stats.pending_total`
//      পড়ত, কিন্তু রুট সেগুলো কখনো পাঠাত না → "Review Pending KYC (0)"
//      সবসময় ০ দেখাত, এমনকি ডজন ডজন KYC অপেক্ষমাণ থাকলেও।
//   ২. ভিউ `stats.total_deposits_all_time` / `total_withdrawals_all_time`
//      পড়ত, রুট পাঠাত `total_deposit_all` / `total_withdraw_all` →
//      লাইফটাইম কার্ড দুটো সবসময় ৳0 দেখাত।
// ---------------------------------------------------------------------------

const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const { cleanupUsers } = require('../helpers/cleanup');

const createdUserIds = [];

// এই suite ইচ্ছাকৃতভাবে pending KYC ও পেমেন্ট সারি তৈরি করে (ড্যাশবোর্ডের
// সংখ্যা যাচাই করতে)। সেগুলো রেখে গেলে পরে চলা গণনা-নির্ভর suite ভুল সংখ্যা
// দেখত, তাই শেষে পরিষ্কার করা হয়।
afterAll(async () => { await cleanupUsers(createdUserIds); });

async function makeAdminAgent() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('dash');
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123',
            confirmPassword: 'SecurePass123', _csrf: token });
  const row = (await pool.query(
    "UPDATE users SET role='admin' WHERE username=$1 RETURNING id", [username])).rows[0];
  createdUserIds.push(row.id);
  return { agent, username, userId: row.id };
}

describe('অ্যাডমিন ড্যাশবোর্ড — পরিসংখ্যান নির্ভুলতা', () => {
  let admin;
  beforeAll(async () => { admin = await makeAdminAgent(); });

  test('পেন্ডিং KYC সংখ্যা আসল DB সংখ্যার সাথে মেলে (আগে সবসময় ০ দেখাত)', async () => {
    await pool.query(
      "INSERT INTO kyc_requests (user_id, full_name, status) VALUES ($1,'Dash Test','pending')",
      [admin.userId]);
    const actual = (await pool.query(
      "SELECT COUNT(*)::int c FROM kyc_requests WHERE status='pending'")).rows[0].c;
    expect(actual).toBeGreaterThan(0);

    const res = await admin.agent.get('/admin');
    expect(res.status).toBe(200);
    const shown = res.text.match(/Review Pending KYC \((\d+)\)/);
    expect(shown).not.toBeNull();
    expect(parseInt(shown[1], 10)).toBe(actual);
  });

  test('লাইফটাইম ডিপোজিট শূন্য নয় যখন অনুমোদিত ডিপোজিট আছে', async () => {
    await pool.query(
      "INSERT INTO payment_requests (user_id, type, amount, status) VALUES ($1,'deposit',7500,'approved')",
      [admin.userId]);
    const total = Number((await pool.query(
      "SELECT COALESCE(SUM(amount),0) t FROM payment_requests WHERE type='deposit' AND status='approved'")).rows[0].t);
    expect(total).toBeGreaterThan(0);

    const res = await admin.agent.get('/admin');
    // থাউজেন্ড সেপারেটরসহ রেন্ডার হয়; শুধু যাচাই করা হচ্ছে যে ৳0 নয়।
    const expected = total.toLocaleString('en-US');
    expect(res.text).toContain(expected);
  });

  test('pending_total তিনটা কিউয়ের যোগফল', async () => {
    const res = await admin.agent.get('/admin');
    const [d, w, k] = await Promise.all([
      pool.query("SELECT COUNT(*)::int c FROM payment_requests WHERE type='deposit' AND status='pending'"),
      pool.query("SELECT COUNT(*)::int c FROM payment_requests WHERE type='withdraw' AND status='pending'"),
      pool.query("SELECT COUNT(*)::int c FROM kyc_requests WHERE status='pending'")
    ]);
    const sum = d.rows[0].c + w.rows[0].c + k.rows[0].c;
    const m = res.text.match(/Pending Actions[\s\S]{0,200}?metric-value text-orange-600 mt-2">(\d+)</);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 10)).toBe(sum);
  });
});

describe('অ্যাডমিন ড্যাশবোর্ড — অপারেশনাল ওভারভিউ (Phase 6)', () => {
  let admin, html;
  beforeAll(async () => {
    admin = await makeAdminAgent();
    html = (await admin.agent.get('/admin')).text;
  });

  test('প্রায়োরিটি কিউ সেকশন আছে', () => {
    expect(html).toMatch(/priority-heading/);
    expect(html).toContain(require('../../locales/bn.json').admin_dash_needs_attention);
  });

  test('পাঁচটা প্রায়োরিটি কিউয়ের প্রতিটাই আছে ও সঠিক গন্তব্যে যায়', () => {
    const bn = require('../../locales/bn.json');
    for (const [key, href] of [
      ['admin_dash_pending_deposits', '/payment/admin/payments'],
      ['admin_dash_pending_withdrawals', '/admin/withdrawals'],
      ['admin_dash_pending_kyc', '/admin/kyc'],
      ['admin_dash_unread_support', '/chat/admin'],
      ['admin_dash_fraud_alerts', '/admin/fraud-monitoring']
    ]) {
      expect(html).toContain(bn[key]);
      expect(html).toContain(`href="${href}"`);
    }
  });

  test('সিস্টেম হেলথ সেকশনে সব উপাদান আছে', () => {
    expect(html).toMatch(/health-heading/);
    // লেবেলগুলো এখন লোকালাইজড (Phase 10) — হার্ডকোড ইংরেজি নয়, locale থেকে আসে।
    // ডিফল্ট ভাষা বাংলা, তাই bn.json-এর মানই প্রত্যাশিত।
    const bn = require('../../locales/bn.json');
    for (const key of ['admin_dash_hc_database', 'admin_dash_hc_redis', 'admin_dash_hc_queue',
                       'admin_dash_hc_cron', 'admin_dash_hc_backup']) {
      expect(html).toContain(bn[key]);
    }
  });

  test('Quick Actions-এ Feature Management আছে', () => {
    const bn = require('../../locales/bn.json');
    expect(html).toContain(bn.admin_ff_title);
    expect(html).toContain('href="/admin/features"');
  });

  test('অবস্থা শুধু রঙে নয়, টেক্সটেও বোঝানো হয় (a11y)', () => {
    // সিস্টেম হেলথে প্রতিটা অবস্থার পাশে পাঠযোগ্য লেবেল থাকে
    const bn = require('../../locales/bn.json');
    const connectivity = [bn.admin_dash_st_connected, bn.admin_dash_st_disconnected, bn.admin_dash_st_inactive];
    expect(connectivity.some(v => html.includes(v))).toBe(true);
    const queueState = [bn.admin_dash_st_running, bn.admin_dash_st_stopped, bn.admin_dash_st_view_schedule];
    expect(queueState.some(v => html.includes(v))).toBe(true);
  });

  test('প্রায়োরিটি কিউয়ের প্রতিটা লিংক আসল রুটে যায় — কোনো ডেড লিংক নেই', async () => {
    for (const href of ['/payment/admin/payments', '/admin/withdrawals', '/admin/kyc',
                        '/chat/admin', '/admin/fraud-monitoring', '/admin/features']) {
      const r = await admin.agent.get(href);
      expect(r.status).not.toBe(404);
      expect(r.status).not.toBe(500);
    }
  });
});
