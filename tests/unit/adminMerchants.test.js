// tests/unit/adminMerchants.test.js
// ---------------------------------------------------------------------------
// মার্চেন্ট ম্যানেজমেন্ট (routes/adminMerchants.js + views/admin/merchants.ejs) —
// ডেটাবেস ছাড়া চলা টেস্ট: ফর্ম যাচাই, রুট-গার্ড, নেভ/পারমিশন সংযোগ, লোকালাইজেশন
// কভারেজ, মাইগ্রেশন স্কিমা ও ভিউ রেন্ডার (XSS escape সহ)।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const routeSrc = read('routes/adminMerchants.js');
const viewSrc = read('views/admin/merchants.ejs');
const en = require('../../locales/en.json');
const bn = require('../../locales/bn.json');

const { parseMerchantForm, escapeLike, MAX_DEPTH } = require('../../routes/adminMerchants');

describe('parseMerchantForm — ইনপুট যাচাই', () => {
  const ok = { code: 'dhaka-01', name: 'Dhaka Agent', commission_rate: '2.5', status: 'active' };

  test('বৈধ ইনপুট: কোড বড় হাতের হয়, খালি ঐচ্ছিক ঘর null হয়', () => {
    const r = parseMerchantForm(ok);
    expect(r.errorKey).toBeUndefined();
    expect(r.values).toMatchObject({
      code: 'DHAKA-01', name: 'Dhaka Agent', commission_rate: 2.5, status: 'active',
      parent_id: null, user_id: null, phone: null, email: null, notes: null
    });
  });

  test.each([
    [{ ...ok, code: '' }, 'merchant_err_code'],
    [{ ...ok, code: 'a' }, 'merchant_err_code'],
    [{ ...ok, code: 'bad code!' }, 'merchant_err_code'],
    [{ ...ok, name: '   ' }, 'merchant_err_name'],
    [{ ...ok, email: 'not-an-email' }, 'merchant_err_email'],
    [{ ...ok, phone: 'abc' }, 'merchant_err_phone'],
    [{ ...ok, commission_rate: '101' }, 'merchant_err_commission'],
    [{ ...ok, commission_rate: '-1' }, 'merchant_err_commission'],
    [{ ...ok, commission_rate: '1.234' }, 'merchant_err_commission'],
    [{ ...ok, commission_rate: '1e2' }, 'merchant_err_commission'],
    [{ ...ok, parent_id: 'abc' }, 'merchant_err_parent_missing'],
    [{ ...ok, parent_id: '0' }, 'merchant_err_parent_missing'],
    [{ ...ok, user_id: '1; DROP TABLE users' }, 'merchant_err_user_missing']
  ])('অবৈধ ইনপুট প্রত্যাখ্যাত: %j → %s', (body, key) => {
    expect(parseMerchantForm(body).errorKey).toBe(key);
  });

  test('কমিশন ফাঁকা হলে ০; সীমার ঠিক ০ ও ১০০ বৈধ', () => {
    expect(parseMerchantForm({ ...ok, commission_rate: '' }).values.commission_rate).toBe(0);
    expect(parseMerchantForm({ ...ok, commission_rate: '100' }).values.commission_rate).toBe(100);
    expect(parseMerchantForm({ ...ok, commission_rate: '0' }).values.commission_rate).toBe(0);
  });

  test('অজানা status হলে active-এ ফিরে যায় (DB CHECK ভাঙে না)', () => {
    expect(parseMerchantForm({ ...ok, status: 'banned' }).values.status).toBe('active');
    expect(parseMerchantForm({ ...ok, status: 'suspended' }).values.status).toBe('suspended');
  });

  test('প্যারেন্ট ও ইউজার আইডি সংখ্যা হিসেবে পার্স হয়', () => {
    const r = parseMerchantForm({ ...ok, parent_id: '12', user_id: '7' });
    expect(r.values.parent_id).toBe(12);
    expect(r.values.user_id).toBe(7);
  });

  test('দীর্ঘ ইনপুট ছাঁটা হয়', () => {
    const r = parseMerchantForm({ ...ok, name: 'x'.repeat(500), notes: 'y'.repeat(5000) });
    expect(r.values.name.length).toBe(100);
    expect(r.values.notes.length).toBe(1000);
  });
});

describe('escapeLike', () => {
  test('% _ \\ escape হয়', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('রুট-গার্ড', () => {
  const routeLines = routeSrc.split('\n').filter((l) => /^router\.(get|post|put|delete|patch)\(/.test(l));

  test('রুট আছে: লিস্ট, তৈরি, সাব-তৈরি (Add), সাধারণ-তৈরি (Ordinary), আপডেট, লগইন-অ্যাজ, কী-রিজেনারেট, স্ট্যাটাস, ডিলিট', () => {
    expect(routeLines.length).toBe(9);
    for (const frag of ["'/sub'", "'/ordinary'", "'/:id/login-as'", "'/:id/regenerate-key'"]) {
      expect(routeLines.some((l) => l.includes(frag))).toBe(true);
    }
  });

  test("'/sub' রুট '/:id'-এর আগে বসানো (পাথ-শ্যাডোইং ঠেকাতে)", () => {
    expect(routeSrc.indexOf("router.post('/sub'")).toBeLessThan(routeSrc.indexOf("router.post('/:id',"));
  });

  test('প্রতিটা রুটে requireManage (merchants_manage) আছে — GET সহ', () => {
    expect(routeSrc).toMatch(/requirePermission\('merchants_manage'\)/);
    for (const l of routeLines) expect(l).toMatch(/requireManage/);
  });

  test('requireManage ID-যাচাইয়ের আগে বসে (পারমিশনহীন অ্যাডমিন ID-ফিডব্যাকও পায় না)', () => {
    for (const l of routeLines.filter((x) => x.includes('requireIntParam'))) {
      expect(l.indexOf('requireManage')).toBeLessThan(l.indexOf('requireIntParam'));
    }
  });

  test('app.js-এ isAdmin-সহ /admin/merchants-এ মাউন্ট করা', () => {
    expect(read('app.js')).toMatch(/app\.use\('\/admin\/merchants',\s*require\('\.\/middleware\/auth'\)\.isAdmin,\s*require\('\.\/routes\/adminMerchants'\)\)/);
  });

  test('ইনলাইন ইভেন্ট হ্যান্ডলার নেই (CSP scriptSrcAttr: none)', () => {
    expect(viewSrc).not.toMatch(/\son(submit|click|change)=/i);
  });

  test('হায়ারার্কি: চক্র ও গভীরতা যাচাই tree-lock ট্রানজেকশনের ভেতরে', () => {
    expect(routeSrc).toMatch(/pg_advisory_xact_lock/);
    expect(routeSrc).toMatch(/merchant_err_cycle/);
    expect(routeSrc).toMatch(/merchant_err_depth/);
    expect(MAX_DEPTH).toBeGreaterThanOrEqual(2);
  });
});

describe('পারমিশন ও নেভিগেশন', () => {
  const rbac = require('../../services/rbac');
  const adminNav = require('../../utils/adminNav');

  test('merchants_manage ক্যাটালগে আছে', () => {
    expect(rbac.PERMISSIONS.merchants_manage).toBeTruthy();
    expect(rbac.PERMISSIONS.merchants_manage.label).toBeTruthy();
  });

  test('নেভে /admin/merchants আছে এবং merchants_manage চায়', () => {
    const item = adminNav.allItems().find((i) => i.href === '/admin/merchants');
    expect(item).toBeTruthy();
    expect(item.permission).toBe('merchants_manage');
    expect(item.active).toBe('merchants');
  });

  test('permission ছাড়া অ্যাডমিন লিংক দেখে না; পারমিশন থাকলে দেখে; super admin সবসময় দেখে', () => {
    const hrefs = (nav) => nav.reduce((a, g) => a.concat(g.items.map((i) => i.href)), []);
    expect(hrefs(adminNav.navFor(false, { users_view: true }))).not.toContain('/admin/merchants');
    expect(hrefs(adminNav.navFor(false, { merchants_manage: true }))).toContain('/admin/merchants');
    expect(hrefs(adminNav.navFor(true, {}))).toContain('/admin/merchants');
  });
});

describe('মাইগ্রেশন স্কিমা', () => {
  const mig = read('migrations.js');
  test('merchants টেবিলে প্যারেন্ট লিংক (self-FK, RESTRICT) ও সুরক্ষা-constraint আছে', () => {
    expect(mig).toMatch(/CREATE TABLE IF NOT EXISTS merchants/);
    expect(mig).toMatch(/parent_id INTEGER REFERENCES merchants\(id\) ON DELETE RESTRICT/);
    expect(mig).toMatch(/merchants_not_own_parent CHECK \(parent_id IS NULL OR parent_id <> id\)/);
    expect(mig).toMatch(/commission_rate NUMERIC\(5,2\)[^,]*CHECK \(commission_rate >= 0 AND commission_rate <= 100\)/);
    expect(mig).toMatch(/idx_merchants_parent/);
  });
});

describe('লোকালাইজেশন কভারেজ (bn + en)', () => {
  function keysUsed() {
    const keys = new Set();
    for (const m of viewSrc.matchAll(/\bt\('([a-z0-9_]+)'\)/g)) keys.add(m[1]);
    for (const m of routeSrc.matchAll(/['"](merchant_[a-z0-9_]+)['"]/g)) keys.add(m[1]);
    for (const k of ['admin_nav_merchants', 'admin_nav_item_merchants']) keys.add(k);
    return [...keys];
  }

  test('ভিউ ও রুটে ব্যবহৃত প্রতিটা key দুই ভাষাতেই আছে এবং খালি নয়', () => {
    const used = keysUsed();
    expect(used.length).toBeGreaterThan(40);
    const missing = used.filter((k) => !en[k] || !bn[k]);
    expect(missing).toEqual([]);
  });

  test('en ও bn-এর merchant_* key-সেট হুবহু এক', () => {
    const pick = (o) => Object.keys(o).filter((k) => k.startsWith('merchant_')).sort();
    expect(pick(bn)).toEqual(pick(en));
  });

  test('{placeholder}-গুলো দুই ভাষায় মেলে', () => {
    for (const k of Object.keys(en).filter((x) => x.startsWith('merchant_'))) {
      const ph = (s) => (s.match(/\{[a-z]+\}/g) || []).sort().join(',');
      expect(ph(bn[k])).toBe(ph(en[k]));
    }
  });
});

describe('ভিউ রেন্ডার', () => {
  // admin-layout-এর বদলে শুধু body বের করে আনা — লেআউট আলাদা টেস্টেড, এখানে ভিউয়ের লজিক দেখছি
  const bodyOnly = viewSrc.replace("include('partials/admin-layout', ", '((o) => o.body)(');
  const t = (k) => en[k] || '[[' + k + ']]';

  const base = () => ({
    t,
    merchants: [], total: 0, page: 1, totalPages: 1, pageSize: 25,
    filters: { q: '', status: '', parent: '' },
    stats: { total: 0, active: 0, suspended: 0, sub: 0 },
    parents: [], editing: null, maxDepth: 5
  });

  test('খালি অবস্থায় রেন্ডার হয়; কোনো অনুবাদ-key মিসিং নয়', () => {
    const html = ejs.render(bodyOnly, base());
    expect(html).toContain(en.merchant_empty);
    expect(html).toContain('action="/admin/merchants"');
    expect(html).not.toContain('[[');
  });

  test('সারি: প্যারেন্ট, সাব-মার্চেন্ট সংখ্যা ও ডিলিটের শর্ত (সাব থাকলে ডিলিট বাটন নেই)', () => {
    const d = base();
    d.merchants = [
      { id: 1, code: 'TOP', name: 'Top', parent_id: null, child_count: 2, commission_rate: '1.00', status: 'active' },
      { id: 2, code: 'SUB', name: 'Sub', parent_id: 1, parent_code: 'TOP', child_count: 0, commission_rate: '0.50', status: 'suspended' }
    ];
    d.total = 2;
    const html = ejs.render(bodyOnly, d);
    expect(html).toContain('/admin/merchants/2/delete');
    expect(html).not.toContain('/admin/merchants/1/delete');
    expect(html).toContain('/admin/merchants?parent=1');
    expect(html).toContain(en.merchant_top_level);
    expect(html).toContain(en.merchant_status_suspended);
  });

  test('এডিট মোডে ফর্ম আপডেট-রুটে যায়, নিজেকে প্যারেন্ট-তালিকা থেকে বাদ দেয়', () => {
    const d = base();
    d.editing = { id: 5, code: 'E5', name: 'Edit Me', parent_id: 3, commission_rate: '4.00', status: 'active', user_id: null };
    d.parents = [{ id: 3, code: 'P3', name: 'Parent' }, { id: 5, code: 'E5', name: 'Edit Me' }];
    const html = ejs.render(bodyOnly, d);
    expect(html).toContain('action="/admin/merchants/5"');
    // শুধু ফর্মের parent_id সিলেক্ট দেখা হচ্ছে — নিচের ফিল্টার-ড্রপডাউনে নিজের কোড থাকা স্বাভাবিক
    const parentSelect = html.match(/<select name="parent_id"[\s\S]*?<\/select>/)[0];
    expect(parentSelect).toContain('<option value="3" selected>');
    expect(parentSelect).not.toContain('<option value="5"');
  });

  test('XSS: নাম/নোট/সার্চ-টার্ম escape হয়', () => {
    const d = base();
    const evil = '<img src=x onerror=alert(1)>';
    d.filters.q = '"><script>alert(1)</script>';
    d.merchants = [{ id: 9, code: 'X', name: evil, contact_name: evil, parent_id: null, child_count: 0, commission_rate: '0', status: 'active' }];
    d.editing = { id: 9, code: 'X', name: evil, notes: '</textarea><script>alert(2)</script>', commission_rate: '0', status: 'active', parent_id: null };
    const html = ejs.render(bodyOnly, d);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;img src=x');
  });

  test('পেজিনেশন: ফিল্টার ধরে রেখে পরের পেজের লিংক', () => {
    const d = base();
    d.page = 1; d.totalPages = 3; d.total = 60; d.filters.status = 'active';
    const html = ejs.render(bodyOnly, d);
    expect(html).toContain('/admin/merchants?status=active&amp;page=2');
  });
});
