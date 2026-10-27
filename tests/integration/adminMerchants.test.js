// tests/integration/adminMerchants.test.js
// ---------------------------------------------------------------------------
// routes/adminMerchants.js-এর আসল Postgres-এর বিরুদ্ধে টেস্ট — বিশেষ করে হায়ারার্কির
// অখণ্ডতা: চক্র, গভীরতা-সীমা, ডিলিট-সুরক্ষা, ইউনিক constraint, পারমিশন-গার্ড ও
// দুই অ্যাডমিনের একসাথে প্যারেন্ট-বদলের race।
//
// পুরো অ্যাপ বুট না করে শুধু এই রাউটারটা একটা ছোট এক্সপ্রেস অ্যাপে মাউন্ট করা হয়েছে
// (সেশন/ফ্ল্যাশ/অনুবাদ/render স্টাব করা) — যাতে টেস্ট দ্রুত ও বিচ্ছিন্ন থাকে।
// ---------------------------------------------------------------------------

const express = require('express');
const request = require('supertest');
const { pool } = require('../../db');

const PFX = 'ZT' + Date.now().toString(36).toUpperCase().slice(-5);   // এই রানের কোড-প্রিফিক্স
let adminId, limitedId, flashes, currentUserId;
let app;

function buildApp() {
  const a = express();
  a.use(express.urlencoded({ extended: false }));
  a.use((req, res, next) => {
    req.session = { user: { id: currentUserId, username: 'test-admin' } };
    req.t = (k) => k;
    req.flash = (kind, msg) => { flashes.push({ kind, msg }); };
    res.render = (view, data) => res.json({ view, data });
    next();
  });
  a.use('/admin/merchants', require('../../routes/adminMerchants'));
  return a;
}

const post = (url, body) => request(app).post(url).type('form').send(body);
const code = (s) => `${PFX}${s}`;
const lastFlash = () => flashes[flashes.length - 1] || {};
const byCode = async (c) => (await pool.query('SELECT * FROM merchants WHERE code = $1', [c])).rows[0];

async function create(c, parentCode, extra = {}) {
  const parent = parentCode ? (await byCode(code(parentCode))).id : '';
  return post('/admin/merchants', { code: code(c), name: 'M ' + c, parent_id: parent, commission_rate: '1', ...extra });
}

async function cleanup() {
  // ON DELETE RESTRICT → পাতা থেকে উপরের দিকে মুছতে হয়
  for (let i = 0; i < 10; i++) {
    const r = await pool.query(
      `DELETE FROM merchants m WHERE m.code LIKE $1
         AND NOT EXISTS (SELECT 1 FROM merchants c WHERE c.parent_id = m.id)`, [PFX + '%']);
    if (r.rowCount === 0) break;
  }
}

beforeAll(async () => {
  const mk = async (suffix, role, roleKey) => (await pool.query(
    `INSERT INTO users (username, password, role, role_key) VALUES ($1,'x',$2,$3) RETURNING id`,
    [`${PFX.toLowerCase()}_${suffix}`, role, roleKey])).rows[0].id;
  adminId = await mk('adm', 'admin', null);          // role_key NULL = super-admin-সমতুল্য
  limitedId = await mk('lim', 'admin', 'support');   // support role-এ merchants_manage নেই
  app = buildApp();
});
beforeEach(() => { flashes = []; currentUserId = adminId; });
afterAll(async () => {
  await cleanup();
  const ids = [adminId, limitedId];
  // অডিট-লগিং আসলেই লেখে বলে এই ইউজারদের লগ-রো (FK) আগে মুছতে হয়
  await pool.query('DELETE FROM admin_logs WHERE admin_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM audit_logs WHERE actor_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM activity_logs WHERE user_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
});

describe('তৈরি ও যাচাই', () => {
  test('টপ-লেভেল ও সাব-মার্চেন্ট তৈরি হয়, প্যারেন্ট লিংক ঠিক থাকে', async () => {
    let res = await create('A');
    expect(res.status).toBe(302);
    expect(lastFlash()).toEqual({ kind: 'success', msg: 'merchant_created' });
    res = await create('B', 'A');
    expect(lastFlash().kind).toBe('success');
    const a = await byCode(code('A')); const b = await byCode(code('B'));
    expect(a.parent_id).toBeNull();
    expect(b.parent_id).toBe(a.id);
    expect(b.created_by).toBe(adminId);
  });

  test('ডুপ্লিকেট কোড প্রত্যাখ্যাত', async () => {
    await create('A');
    expect(lastFlash()).toEqual({ kind: 'error', msg: 'merchant_err_code_taken' });
  });

  test('না-থাকা প্যারেন্ট / না-থাকা ইউজার প্রত্যাখ্যাত', async () => {
    await post('/admin/merchants', { code: code('P1'), name: 'x', parent_id: '999999999' });
    expect(lastFlash().msg).toBe('merchant_err_parent_missing');
    await post('/admin/merchants', { code: code('U1'), name: 'x', user_id: '999999999' });
    expect(lastFlash().msg).toBe('merchant_err_user_missing');
    expect(await byCode(code('P1'))).toBeUndefined();
    expect(await byCode(code('U1'))).toBeUndefined();
  });

  test('একই ইউজার দুই মার্চেন্টে যুক্ত করা যায় না', async () => {
    await post('/admin/merchants', { code: code('L1'), name: 'x', user_id: String(limitedId) });
    expect(lastFlash().kind).toBe('success');
    await post('/admin/merchants', { code: code('L2'), name: 'x', user_id: String(limitedId) });
    expect(lastFlash().msg).toBe('merchant_err_user_taken');
  });
});

describe('হায়ারার্কির অখণ্ডতা', () => {
  beforeAll(async () => { // A → B (আগের describe-এ তৈরি); C যোগ: A → B → C
    flashes = []; currentUserId = adminId;
    await create('C', 'B');
  });

  const reparent = async (child, parent) => {
    const m = await byCode(code(child));
    const p = parent ? (await byCode(code(parent))).id : '';
    return post(`/admin/merchants/${m.id}`, { code: m.code, name: m.name, parent_id: p, commission_rate: m.commission_rate, status: m.status });
  };

  test('চক্র ঠেকানো: A-কে C-র নিচে বসানো যায় না (A→B→C→A)', async () => {
    await reparent('A', 'C');
    expect(lastFlash()).toEqual({ kind: 'error', msg: 'merchant_err_cycle' });
    expect((await byCode(code('A'))).parent_id).toBeNull();
  });

  test('নিজেকে নিজের প্যারেন্ট করা যায় না', async () => {
    await reparent('B', 'B');
    expect(lastFlash().msg).toBe('merchant_err_cycle');
  });

  test('গভীরতা-সীমা: চেইন ৫ স্তর পর্যন্ত চলে, ষষ্ঠ স্তর প্রত্যাখ্যাত', async () => {
    await create('D', 'C');   // স্তর ৪
    await create('E', 'D');   // স্তর ৫
    expect(lastFlash().kind).toBe('success');
    await create('F', 'E');   // স্তর ৬ ✗
    expect(lastFlash().msg).toBe('merchant_err_depth');
    expect(await byCode(code('F'))).toBeUndefined();
  });

  test('সাবট্রিসহ সরানোর সময়ও গভীরতা মাপা হয় (B-সাবট্রি ৪ স্তর, নতুন প্যারেন্ট ২ স্তরে ✗)', async () => {
    await create('X', null); await create('Y', 'X');            // X → Y (Y স্তর ২)
    await reparent('B', 'Y');                                    // B-সাবট্রি (B,C,D,E = ৪) + ২ = ৬ ✗
    expect(lastFlash().msg).toBe('merchant_err_depth');
    expect((await byCode(code('B'))).parent_id).toBe((await byCode(code('A'))).id);
  });

  test('বৈধ প্যারেন্ট-বদল কাজ করে (টপ-লেভেলে তোলা)', async () => {
    await reparent('B', null);
    expect(lastFlash().kind).toBe('success');
    expect((await byCode(code('B'))).parent_id).toBeNull();
    await reparent('B', 'A');   // আগের অবস্থায় ফেরত
    expect(lastFlash().kind).toBe('success');
  });

  test('race: দুই অ্যাডমিন একসাথে X→Y ও Y→X করলে চক্র তৈরি হয় না (ঠিক একটা সফল)', async () => {
    await create('R1', null); await create('R2', null);
    flashes = [];
    const r1 = await byCode(code('R1')); const r2 = await byCode(code('R2'));
    const mk = (m, p) => post(`/admin/merchants/${m.id}`, { code: m.code, name: m.name, parent_id: String(p.id), commission_rate: '1', status: 'active' });
    await Promise.all([mk(r1, r2), mk(r2, r1)]);
    const ok = flashes.filter((f) => f.kind === 'success').length;
    const cyc = flashes.filter((f) => f.msg === 'merchant_err_cycle').length;
    expect(ok).toBe(1);
    expect(cyc).toBe(1);
    const rows = (await pool.query('SELECT code, parent_id FROM merchants WHERE code = ANY($1)', [[code('R1'), code('R2')]])).rows;
    expect(rows.filter((r) => r.parent_id !== null).length).toBe(1);
  });
});

describe('স্ট্যাটাস ও ডিলিট', () => {
  test('স্ট্যাটাস টগল: active ⇄ suspended', async () => {
    const a = await byCode(code('A'));
    await post(`/admin/merchants/${a.id}/status`, {});
    expect((await byCode(code('A'))).status).toBe('suspended');
    await post(`/admin/merchants/${a.id}/status`, {});
    expect((await byCode(code('A'))).status).toBe('active');
  });

  test('সাব-মার্চেন্ট থাকলে ডিলিট প্রত্যাখ্যাত; পাতা ডিলিট হয়', async () => {
    const a = await byCode(code('A'));
    await post(`/admin/merchants/${a.id}/delete`, {});
    expect(lastFlash()).toEqual({ kind: 'error', msg: 'merchant_err_has_children' });
    expect(await byCode(code('A'))).toBeTruthy();

    const e = await byCode(code('E'));
    await post(`/admin/merchants/${e.id}/delete`, {});
    expect(lastFlash()).toEqual({ kind: 'success', msg: 'merchant_deleted' });
    expect(await byCode(code('E'))).toBeUndefined();
  });

  test('না-থাকা আইডি → not_found; অবৈধ আইডি পথ-প্যারামিটারেই আটকায়', async () => {
    await post('/admin/merchants/999999999/status', {});
    expect(lastFlash().msg).toBe('merchant_err_not_found');
    flashes = [];
    const res = await post('/admin/merchants/abc/delete', {});
    expect(res.status).toBe(302);
    expect(lastFlash().kind).toBe('error');
  });
});

describe('অডিট ট্রেইল', () => {
  const waitForLog = async (action, tries = 20) => {
    for (let i = 0; i < tries; i++) {
      const r = await pool.query('SELECT * FROM admin_logs WHERE admin_id = $1 AND action_type = $2 ORDER BY id DESC LIMIT 1', [adminId, action]);
      if (r.rows[0]) return r.rows[0];
      await new Promise((ok) => setTimeout(ok, 50));
    }
    return null;
  };

  test('তৈরি, স্ট্যাটাস-বদল ও ডিলিট — প্রতিটাই admin_logs-এ অ্যাডমিনের নামে লেখা হয়', async () => {
    for (const action of ['MERCHANT_CREATED', 'MERCHANT_STATUS_CHANGED', 'MERCHANT_DELETED']) {
      const row = await waitForLog(action);
      expect(row).toBeTruthy();
      expect(row.admin_username).toBe('test-admin');
      expect(row.details).toMatch(new RegExp(PFX));
    }
  });
});

describe('পারমিশন-গার্ড', () => {
  test('merchants_manage ছাড়া অ্যাডমিন কোনো রুটেই কিছু করতে পারে না', async () => {
    currentUserId = limitedId;
    const a = await byCode(code('A'));
    const before = (await pool.query('SELECT COUNT(*)::int c FROM merchants')).rows[0].c;

    let res = await post('/admin/merchants', { code: code('NOPE'), name: 'x' });
    expect(res.status).toBe(302); expect(res.headers.location).toBe('/admin');
    res = await post(`/admin/merchants/${a.id}/status`, {});
    expect(res.headers.location).toBe('/admin');
    res = await post(`/admin/merchants/${a.id}/delete`, {});
    expect(res.headers.location).toBe('/admin');
    res = await request(app).get('/admin/merchants');
    expect(res.status).toBe(302);

    expect((await pool.query('SELECT COUNT(*)::int c FROM merchants')).rows[0].c).toBe(before);
    expect((await byCode(code('A'))).status).toBe('active');
  });

  test('রোলে merchants_manage দিলে অ্যাক্সেস মেলে', async () => {
    await pool.query(
      `INSERT INTO roles (key, name, permissions) VALUES ($1,$2,$3::jsonb)`,
      [PFX.toLowerCase() + '_role', 'Merchant Ops', JSON.stringify({ merchants_manage: true })]);
    await pool.query('UPDATE users SET role_key = $1 WHERE id = $2', [PFX.toLowerCase() + '_role', limitedId]);
    require('../../services/cache').del && await require('../../services/cache').del(`role:${PFX.toLowerCase()}_role`).catch(() => {});
    currentUserId = limitedId;
    const res = await request(app).get('/admin/merchants');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('admin/merchants');
    await pool.query('UPDATE users SET role_key = $1 WHERE id = $2', ['support', limitedId]);
    await pool.query('DELETE FROM roles WHERE key = $1', [PFX.toLowerCase() + '_role']);
  });
});

describe('লিস্ট', () => {
  test('GET / ভিউ ও ডেটা দেয়; সার্চে % আক্ষরিক ধরা হয় (wildcard নয়)', async () => {
    let res = await request(app).get('/admin/merchants').query({ q: PFX });
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('admin/merchants');
    expect(res.body.data.total).toBeGreaterThanOrEqual(3);
    expect(res.body.data.merchants[0]).toHaveProperty('child_count');

    res = await request(app).get('/admin/merchants').query({ q: '%' });
    expect(res.body.data.total).toBe(0);   // কোনো নামে আক্ষরিক '%' নেই
  });

  test('ফিল্টার: parent=root শুধু টপ-লেভেল; parent=<id> শুধু তার সাব-মার্চেন্ট; status', async () => {
    const a = await byCode(code('A'));
    let res = await request(app).get('/admin/merchants').query({ q: PFX, parent: 'root' });
    expect(res.body.data.merchants.every((m) => m.parent_id === null)).toBe(true);
    res = await request(app).get('/admin/merchants').query({ q: PFX, parent: String(a.id) });
    expect(res.body.data.merchants.length).toBeGreaterThan(0);
    expect(res.body.data.merchants.every((m) => m.parent_id === a.id)).toBe(true);
    res = await request(app).get('/admin/merchants').query({ q: PFX, status: 'suspended' });
    expect(res.body.data.merchants.every((m) => m.status === 'suspended')).toBe(true);
  });

  test('?edit=ID সংশ্লিষ্ট মার্চেন্ট লোড করে', async () => {
    const a = await byCode(code('A'));
    const res = await request(app).get('/admin/merchants').query({ edit: String(a.id) });
    expect(res.body.data.editing.code).toBe(a.code);
  });
});
