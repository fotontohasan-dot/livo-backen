// tests/integration/merchantPortal.test.js
// ---------------------------------------------------------------------------
// মার্চেন্ট ক্রেডেনশিয়াল (Merchant ID + API Key), "Add" বাটনের POST /sub, অ্যাডমিনের
// "Login" (login-as), ও মার্চেন্ট পোর্টালের রাউট (খরগোশ-আইকনের /credentials) —
// আসল Postgres-এর বিরুদ্ধে। adminMerchants.test.js-এর মতোই ছোট এক্সপ্রেস অ্যাপে রাউটার মাউন্ট।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { pool } = require('../../db');
const creds = require('../../services/merchantCredentials');

const PFX = 'ZP' + Date.now().toString(36).toUpperCase().slice(-5);
let adminId, otherAdminId, limitedId, flashes, currentUserId, session, app;

function buildApp() {
  const a = express();
  a.use(express.urlencoded({ extended: false }));
  a.use((req, res, next) => {
    // একই `session` অবজেক্ট রিকোয়েস্টজুড়ে টিকে থাকে — আসল express-session-এর মতো
    req.session = session;
    req.session.user = { id: currentUserId, username: 'test-admin' };
    req.session.save = (cb) => cb && cb();
    req.t = (k) => k;
    req.flash = (kind, msg) => { flashes.push({ kind, msg }); };
    res.render = (view, data) => res.json({ view, data });
    next();
  });
  a.use('/admin/merchants', require('../../routes/adminMerchants'));
  a.use('/merchant', require('../../routes/merchantPortal'));
  return a;
}

const post = (url, body) => request(app).post(url).type('form').send(body || {});
const lastFlash = () => flashes[flashes.length - 1] || {};
const byId = async (id) => (await pool.query('SELECT * FROM merchants WHERE id = $1', [id])).rows[0];
const byName = async (n) => (await pool.query('SELECT * FROM merchants WHERE name = $1', [n])).rows[0];
const nm = (s) => `${PFX}-${s}`;

async function cleanup() {
  for (let i = 0; i < 10; i++) {
    const r = await pool.query(
      `DELETE FROM merchants m WHERE (m.name LIKE $1 OR m.code LIKE $1)
         AND NOT EXISTS (SELECT 1 FROM merchants c WHERE c.parent_id = m.id)`, [PFX + '%']);
    if (r.rowCount === 0) break;
  }
}

beforeAll(async () => {
  const mk = async (suffix, role, roleKey) => (await pool.query(
    `INSERT INTO users (username, password, role, role_key) VALUES ($1,'x',$2,$3) RETURNING id`,
    [`${PFX.toLowerCase()}_${suffix}`, role, roleKey])).rows[0].id;
  adminId = await mk('adm', 'admin', null);
  otherAdminId = await mk('adm2', 'admin', null);
  limitedId = await mk('lim', 'admin', 'support'); // merchants_manage নেই
  app = buildApp();
});
beforeEach(() => { flashes = []; currentUserId = adminId; session = {}; });
afterAll(async () => {
  await cleanup();
  const ids = [adminId, otherAdminId, limitedId];
  await pool.query('DELETE FROM admin_logs WHERE admin_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM audit_logs WHERE actor_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM activity_logs WHERE user_id = ANY($1)', [ids]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
});

// ---------------------------------------------------------------------------
describe('ক্রেডেনশিয়াল হেল্পার', () => {
  test('Merchant ID ও API Key-এর ফরম্যাট', () => {
    expect(creds.generateMerchantUid()).toMatch(creds.UID_RE);
    expect(creds.generateApiKey()).toMatch(creds.KEY_RE);
  });

  test('১০,০০০টা তৈরিতে কোনো ডুপ্লিকেট নেই (আইডি ও কী)', () => {
    const uids = new Set(); const keys = new Set();
    for (let i = 0; i < 10000; i++) { uids.add(creds.generateMerchantUid()); keys.add(creds.generateApiKey()); }
    expect(uids.size).toBe(10000);
    expect(keys.size).toBe(10000);
  });

  test('এনক্রিপ্ট→রিভিল রাউন্ডট্রিপ; হ্যাশ কী-র সাথে মেলে; প্লেইন কী সংরক্ষিত মানে নেই', () => {
    const k = creds.newKeyFields();
    expect(creds.revealApiKey(k.api_key_enc)).toBe(k.raw);
    expect(creds.hashApiKey(k.raw)).toBe(k.api_key_hash);
    expect(k.api_key_enc).not.toContain(k.raw);
    expect(k.api_key_hash).not.toContain(k.raw);
    expect(k.api_key_prefix).toBe(k.raw.slice(0, 7));
  });

  test('করাপ্ট/ফাঁকা এনক্রিপ্টেড মানে রিভিল null দেয়, ক্র্যাশ করে না', () => {
    expect(creds.revealApiKey(null)).toBeNull();
    expect(creds.revealApiKey('v1:aaaa:bbbb:cccc')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('"Add" বাটন → POST /admin/merchants/sub', () => {
  let parentId;
  beforeAll(async () => {
    currentUserId = adminId; flashes = [];
    await post('/admin/merchants', { code: nm('PARENT'), name: nm('parent'), commission_rate: '5' });
    parentId = (await byName(nm('parent'))).id;
  });

  test('সাব-মার্চেন্ট তৈরি হয়; অটো Merchant ID + API Key বসে; code = Merchant ID', async () => {
    const res = await post('/admin/merchants/sub', {
      parent_id: String(parentId), name: nm('sub1'), contact_name: 'Rahim', phone: '01700000000',
      email: 'sub1@example.com', commission_rate: '2.5'
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/merchants');
    expect(lastFlash().kind).toBe('success');
    expect(lastFlash().msg).toBe('merchant_sub_created'); // req.t স্টাব key ফেরত দেয়

    const m = await byName(nm('sub1'));
    expect(m.parent_id).toBe(parentId);
    expect(m.merchant_uid).toMatch(creds.UID_RE);
    expect(m.code).toBe(m.merchant_uid);
    expect(m.api_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.api_key_prefix).toMatch(/^mk_/);
    expect(m.api_key_created_at).not.toBeNull();
    expect(Number(m.commission_rate)).toBe(2.5);
    expect(m.created_by).toBe(adminId);
    // সংরক্ষিত এনক্রিপ্টেড কী আসলেই হ্যাশের সাথে মেলে
    expect(creds.hashApiKey(creds.revealApiKey(m.api_key_enc))).toBe(m.api_key_hash);
  });

  test('দুটো সাব-মার্চেন্টের ID ও কী আলাদা', async () => {
    await post('/admin/merchants/sub', { parent_id: String(parentId), name: nm('sub2') });
    await post('/admin/merchants/sub', { parent_id: String(parentId), name: nm('sub3') });
    const a = await byName(nm('sub2')); const b = await byName(nm('sub3'));
    expect(a.merchant_uid).not.toBe(b.merchant_uid);
    expect(a.api_key_hash).not.toBe(b.api_key_hash);
  });

  test('প্যারেন্ট ছাড়া / ভুল প্যারেন্ট / ফাঁকা নাম প্রত্যাখ্যাত — কিছু তৈরি হয় না', async () => {
    const before = (await pool.query('SELECT COUNT(*)::int c FROM merchants')).rows[0].c;
    await post('/admin/merchants/sub', { name: nm('noparent') });
    expect(lastFlash().msg).toBe('merchant_err_parent_required');
    await post('/admin/merchants/sub', { parent_id: '999999999', name: nm('badparent') });
    expect(lastFlash().msg).toBe('merchant_err_parent_missing');
    await post('/admin/merchants/sub', { parent_id: String(parentId), name: '   ' });
    expect(lastFlash().msg).toBe('merchant_err_name');
    expect((await pool.query('SELECT COUNT(*)::int c FROM merchants')).rows[0].c).toBe(before);
  });

  test('ক্লায়েন্ট code/status/user_id পাঠালেও উপেক্ষিত (code সবসময় অটো ID)', async () => {
    await post('/admin/merchants/sub', {
      parent_id: String(parentId), name: nm('sneaky'), code: 'HACK', status: 'suspended', user_id: String(limitedId)
    });
    const m = await byName(nm('sneaky'));
    expect(m.code).toBe(m.merchant_uid);
    expect(m.code).not.toBe('HACK');
    expect(m.status).toBe('active');
    expect(m.user_id).toBeNull();
  });

  test('পারমিশনহীন অ্যাডমিন পারে না', async () => {
    currentUserId = limitedId;
    const res = await post('/admin/merchants/sub', { parent_id: String(parentId), name: nm('denied') });
    expect(res.headers.location).toBe('/admin');
    expect(await byName(nm('denied'))).toBeUndefined();
  });

  test('বিদ্যমান POST / ফর্মেও নতুন মার্চেন্ট ক্রেডেনশিয়াল পায়', async () => {
    await post('/admin/merchants', { code: nm('VIAFORM'), name: nm('viaform'), parent_id: String(parentId) });
    const m = await byName(nm('viaform'));
    expect(m.code).toBe(nm('VIAFORM'));
    expect(m.merchant_uid).toMatch(creds.UID_RE);
    expect(m.api_key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('লিস্ট-ভিউতে কী-এর হ্যাশ/এনক্রিপ্টেড মান যায় না (শুধু prefix)', async () => {
    const res = await request(app).get('/admin/merchants');
    expect(res.body.view).toBe('admin/merchants');
    const rows = res.body.data.merchants;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r).not.toHaveProperty('api_key_hash');
      expect(r).not.toHaveProperty('api_key_enc');
    }
    expect(rows.some((r) => r.api_key_prefix)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('অ্যাডমিনের "Login" ও মার্চেন্ট পোর্টাল', () => {
  let m;
  beforeAll(async () => {
    currentUserId = adminId; session = {}; flashes = [];
    await post('/admin/merchants', { code: nm('PORTAL'), name: nm('portal') });
    m = await byName(nm('portal'));
  });

  test('পোর্টাল-সেশন ছাড়া /merchant → অ্যাডমিন তালিকায় রিডাইরেক্ট; /credentials কিছু দেয় না', async () => {
    session = {};
    let res = await request(app).get('/merchant');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/merchants');
    res = await post('/merchant/credentials');
    expect(res.status).toBe(302);
    expect(JSON.stringify(res.body)).not.toMatch(/mk_/);
  });

  test('login-as: পোর্টাল-মার্কার বসে, অ্যাডমিনের নিজের সেশন-ইউজার অপরিবর্তিত, /merchant-এ রিডাইরেক্ট', async () => {
    session = {};
    const res = await post(`/admin/merchants/${m.id}/login-as`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/merchant');
    expect(session.merchantPortal).toMatchObject({ merchantId: m.id, adminId });
    expect(session.user.id).toBe(adminId);
  });

  test('login-as অডিট-লগে high-risk হিসেবে লেখা হয়', async () => {
    await new Promise((r) => setTimeout(r, 200)); // অডিট non-blocking
    const r = await pool.query(
      `SELECT details FROM admin_logs WHERE admin_id = $1 AND action_type = 'MERCHANT_PORTAL_LOGIN' ORDER BY id DESC LIMIT 1`, [adminId]);
    expect(r.rows[0].details).toContain(m.merchant_uid);
  });

  test('না-থাকা মার্চেন্টে login-as ব্যর্থ, মার্কার বসে না', async () => {
    session = {};
    await post('/admin/merchants/999999999/login-as');
    expect(lastFlash().msg).toBe('merchant_err_not_found');
    expect(session.merchantPortal).toBeUndefined();
  });

  test('পারমিশনহীন অ্যাডমিন login-as করতে পারে না', async () => {
    session = {}; currentUserId = limitedId;
    const res = await post(`/admin/merchants/${m.id}/login-as`);
    expect(res.headers.location).toBe('/admin');
    expect(session.merchantPortal).toBeUndefined();
  });

  test('ড্যাশবোর্ড: নিজের তথ্য ও সরাসরি সাব-মার্চেন্ট; কী-এর কোনো মান ভিউ-ডেটায় নেই', async () => {
    currentUserId = adminId;
    await post('/admin/merchants/sub', { parent_id: String(m.id), name: nm('portal-child') });
    session = { merchantPortal: { merchantId: m.id, adminId } };
    const res = await request(app).get('/merchant');
    expect(res.body.view).toBe('merchant/dashboard');
    expect(res.body.data.merchant.merchant_uid).toBe(m.merchant_uid);
    expect(res.body.data.subMerchants.map((s) => s.name)).toEqual([nm('portal-child')]);
    const dump = JSON.stringify(res.body.data);
    expect(dump).not.toMatch(/mk_[A-Za-z0-9_-]{32}/);
    expect(dump).not.toMatch(/api_key_hash|api_key_enc/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
  });

  test('খরগোশ-আইকন: POST /credentials সঠিক Merchant ID ও API Key দেয় (no-store)', async () => {
    session = { merchantPortal: { merchantId: m.id, adminId } };
    const res = await post('/merchant/credentials');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.merchantId).toBe(m.merchant_uid);
    expect(res.body.apiKey).toMatch(creds.KEY_RE);
    expect(creds.hashApiKey(res.body.apiKey)).toBe((await byId(m.id)).api_key_hash);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  test('GET /credentials নেই (ক্রেডেনশিয়াল GET-এ ফাঁস হয় না)', async () => {
    session = { merchantPortal: { merchantId: m.id, adminId } };
    const res = await request(app).get('/merchant/credentials');
    expect(res.status).toBe(404);
  });

  test('অন্য অ্যাডমিনের নামে বসানো পোর্টাল-মার্কার কাজ করে না', async () => {
    currentUserId = otherAdminId;
    session = { merchantPortal: { merchantId: m.id, adminId } }; // adminId ≠ otherAdminId
    const res = await post('/merchant/credentials');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/merchants');
    expect(session.merchantPortal).toBeUndefined();
  });

  test('ডিমোট/পারমিশন-হারানো অ্যাডমিনের চলমান পোর্টাল-সেশনও অচল', async () => {
    currentUserId = limitedId;
    session = { merchantPortal: { merchantId: m.id, adminId: limitedId } };
    const res = await post('/merchant/credentials');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
    expect(JSON.stringify(res.body)).not.toMatch(/mk_/);
  });

  test('মার্চেন্ট মুছে গেলে পোর্টাল-মার্কার পরিষ্কার হয়', async () => {
    currentUserId = adminId;
    await post('/admin/merchants', { code: nm('GONE'), name: nm('gone') });
    const g = await byName(nm('gone'));
    session = { merchantPortal: { merchantId: g.id, adminId } };
    await pool.query('DELETE FROM merchants WHERE id = $1', [g.id]);
    const res = await request(app).get('/merchant');
    expect(res.headers.location).toBe('/admin/merchants');
    expect(session.merchantPortal).toBeUndefined();
  });

  test('কী অপাঠযোগ্য (এনক্রিপশন-কী বদল) হলে 409 — ক্র্যাশ বা ভুল মান নয়', async () => {
    const saved = (await byId(m.id)).api_key_enc;
    await pool.query(`UPDATE merchants SET api_key_enc = 'v1:AAAA:BBBB:CCCC' WHERE id = $1`, [m.id]);
    try {
      session = { merchantPortal: { merchantId: m.id, adminId } };
      const res = await post('/merchant/credentials');
      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/mk_/);
    } finally {
      await pool.query('UPDATE merchants SET api_key_enc = $1 WHERE id = $2', [saved, m.id]);
    }
  });

  test('POST /exit: মার্কার মোছে ও অ্যাডমিন তালিকায় ফেরায়', async () => {
    session = { merchantPortal: { merchantId: m.id, adminId } };
    const res = await post('/merchant/exit');
    expect(res.headers.location).toBe('/admin/merchants');
    expect(session.merchantPortal).toBeUndefined();
  });

  test('প্রতিটা ক্রেডেনশিয়াল-দেখা অডিট হয়', async () => {
    await new Promise((r) => setTimeout(r, 200));
    const r = await pool.query(
      `SELECT COUNT(*)::int c FROM admin_logs WHERE admin_id = $1 AND action_type = 'MERCHANT_CREDENTIALS_VIEWED'`, [adminId]);
    expect(r.rows[0].c).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
describe('API Key রিজেনারেট', () => {
  test('নতুন কী তৈরি হয়; পুরনো কী-এর হ্যাশ আর কোথাও মেলে না; Merchant ID অপরিবর্তিত', async () => {
    currentUserId = adminId;
    await post('/admin/merchants', { code: nm('ROT'), name: nm('rot') });
    const before = await byName(nm('rot'));
    const oldKey = creds.revealApiKey(before.api_key_enc);

    const res = await post(`/admin/merchants/${before.id}/regenerate-key`);
    expect(res.status).toBe(302);
    expect(lastFlash().msg).toBe('merchant_key_regenerated');

    const after = await byId(before.id);
    const newKey = creds.revealApiKey(after.api_key_enc);
    expect(newKey).toMatch(creds.KEY_RE);
    expect(newKey).not.toBe(oldKey);
    expect(after.api_key_hash).toBe(creds.hashApiKey(newKey));
    expect(after.merchant_uid).toBe(before.merchant_uid);
    const stale = await pool.query('SELECT 1 FROM merchants WHERE api_key_hash = $1', [creds.hashApiKey(oldKey)]);
    expect(stale.rows.length).toBe(0);
  });

  test('না-থাকা মার্চেন্টে ব্যর্থ; পারমিশনহীন অ্যাডমিন পারে না', async () => {
    currentUserId = adminId;
    await post('/admin/merchants/999999999/regenerate-key');
    expect(lastFlash().msg).toBe('merchant_err_not_found');

    const m = await byName(nm('rot'));
    const hash = m.api_key_hash;
    currentUserId = limitedId;
    const res = await post(`/admin/merchants/${m.id}/regenerate-key`);
    expect(res.headers.location).toBe('/admin');
    expect((await byId(m.id)).api_key_hash).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
describe('মাইগ্রেশন ব্যাকফিল', () => {
  test('ক্রেডেনশিয়াল ছাড়া বিদ্যমান মার্চেন্ট মাইগ্রেশন পুনরায় চালালে ID + কী পায়; যাদের আছে তাদের বদলায় না', async () => {
    const { rows: [old] } = await pool.query(
      `INSERT INTO merchants (code, name) VALUES ($1, $2) RETURNING id`, [nm('LEGACY'), nm('legacy')]);
    await post('/admin/merchants', { code: nm('KEEP'), name: nm('keep') });
    const keep = await byName(nm('keep'));

    await require('../../migrations')();

    const filled = await byId(old.id);
    expect(filled.merchant_uid).toMatch(creds.UID_RE);
    expect(creds.hashApiKey(creds.revealApiKey(filled.api_key_enc))).toBe(filled.api_key_hash);

    const kept = await byId(keep.id);
    expect(kept.merchant_uid).toBe(keep.merchant_uid);
    expect(kept.api_key_hash).toBe(keep.api_key_hash);
    expect(kept.api_key_enc).toBe(keep.api_key_enc);
  }, 120000);
});

// ---------------------------------------------------------------------------
describe('ভিউ/ক্লায়েন্ট কোড (স্ট্যাটিক)', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

  test('রেবিট-আইকন ফাইল আছে এবং লেআউটে উপরের ডানের হেডারে বসানো', () => {
    expect(fs.existsSync(path.join(__dirname, '..', '..', 'public', 'images', 'rabbit-piano.svg'))).toBe(true);
    const layout = read('views', 'merchant', 'partials', 'merchant-layout.ejs');
    expect(layout).toMatch(/data-merchant-creds-open/);
    expect(layout).toMatch(/\/images\/rabbit-piano\.svg/);
    // আইকন বাটন হেডারের ডান পাশের গ্রুপে — মডালের আগেই
    expect(layout.indexOf('mpRabbitBtn')).toBeLessThan(layout.indexOf('mpCredsModal'));
  });

  test('ইনলাইন স্ক্রিপ্ট/ইভেন্ট-হ্যান্ডলার নেই (CSP)', () => {
    for (const f of [['views', 'merchant', 'partials', 'merchant-layout.ejs'], ['views', 'merchant', 'dashboard.ejs']]) {
      const src = read(...f);
      expect(src).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
      expect(src).not.toMatch(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/);
    }
  });

  test('API Key লেআউট/ভিউ টেমপ্লেটে বসানো হয় না — শুধু fetch-এ আসে', () => {
    expect(read('views', 'merchant', 'partials', 'merchant-layout.ejs')).not.toMatch(/api_?key_?enc|revealApiKey/i);
    expect(read('public', 'js', 'merchant-portal.js')).toMatch(/fetch\('\/merchant\/credentials'/);
  });

  test('app.js-এ /merchant isAdmin-সহ মাউন্ট করা', () => {
    expect(read('app.js')).toMatch(/app\.use\('\/merchant',\s*require\('\.\/middleware\/auth'\)\.isAdmin,\s*require\('\.\/routes\/merchantPortal'\)\)/);
  });

  test('পোর্টালের প্রতিটা রুটে requireManage গার্ড router.use-এ আছে', () => {
    const src = read('routes', 'merchantPortal.js');
    expect(src).toMatch(/router\.use\(requireManage\)/);
    expect(src.indexOf('router.use(requireManage)')).toBeLessThan(src.indexOf('router.use(portalGuard)'));
  });
});
