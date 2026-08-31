// tests/render/adminLocalization.test.js
// ---------------------------------------------------------------------------
// Phase 10 — নতুন অ্যাডমিন UI টেক্সট বিদ্যমান i18n সিস্টেমে আছে কিনা।
//
// এটা শুধু "key আছে কিনা" যাচাই করে না — ভাষা বদলে **আসল রেন্ডার** করে দেখে
// যে টেক্সট সত্যিই বদলায়। key যোগ করেও টেমপ্লেটে হার্ডকোড রেখে দিলে প্রথম
// ধরনের টেস্ট পাস করত কিন্তু ইউজার ইংরেজিতে বাংলা দেখত।
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('../helpers/app');
const { pool } = require('../../db');
const { cleanupUsers } = require('../helpers/cleanup');

// তৈরি করা অ্যাডমিন ইউজার রেখে গেলে পরে চলা অ্যাডমিন-গণনা নির্ভর suite
// (admin, rbac) ভুল সংখ্যা দেখে ফেল করত — CI-এর একটানা রানে।
const createdUserIds = [];
afterAll(async () => { await cleanupUsers(createdUserIds); });

const ROOT = path.join(__dirname, '..', '..');
const bn = require('../../locales/bn.json');
const en = require('../../locales/en.json');

async function makeAdminAgent(lang) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('loc');
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: 'SecurePass123',
            confirmPassword: 'SecurePass123', _csrf: token });
  await pool.query("UPDATE users SET role='admin' WHERE username=$1", [username]);
  if (lang) await agent.get('/lang/' + lang);
  const r = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
  if (r.rows[0]) createdUserIds.push(r.rows[0].id);
  return agent;
}

describe('locale ফাইলের অখণ্ডতা', () => {
  test('bn ও en-এ একই key সেট আছে', () => {
    const a = Object.keys(bn).sort();
    const b = Object.keys(en).sort();
    expect(a).toEqual(b);
  });

  test('নতুন অ্যাডমিন key-গুলোর কোনোটাই খালি নয়', () => {
    const prefixes = ['admin_nav_', 'admin_ui_', 'admin_dash_', 'admin_ff_'];
    const keys = Object.keys(bn).filter(k => prefixes.some(p => k.startsWith(p)));
    expect(keys.length).toBeGreaterThan(100);
    for (const k of keys) {
      expect(String(bn[k]).trim().length).toBeGreaterThan(0);
      expect(String(en[k]).trim().length).toBeGreaterThan(0);
    }
  });

  test('en অনুবাদে বাংলা অক্ষর নেই (ভাষা মিশ্রণ হয়নি)', () => {
    const prefixes = ['admin_nav_', 'admin_ui_', 'admin_dash_', 'admin_ff_'];
    const mixed = Object.keys(en)
      .filter(k => prefixes.some(p => k.startsWith(p)))
      .filter(k => /[\u0980-\u09FF]/.test(String(en[k])));
    expect(mixed).toEqual([]);
  });

  test('placeholder ({value}) দুই ভাষাতেই মেলে', () => {
    const bad = Object.keys(bn).filter(k => {
      const pb = (String(bn[k]).match(/\{value\d*\}/g) || []).sort().join(',');
      const pe = (String(en[k]).match(/\{value\d*\}/g) || []).sort().join(',');
      return pb !== pe;
    });
    expect(bad).toEqual([]);
  });
});

describe('নেভিগেশন ও ফিচার রেজিস্ট্রির প্রতিটা key locale-এ আছে', () => {
  const nav = require('../../utils/adminNav');
  const registry = require('../../services/featureRegistry');

  test('প্রতিটা নেভ গ্রুপ ও আইটেমের labelKey অনুবাদযোগ্য', () => {
    const missing = [];
    for (const g of nav.NAV) {
      if (!g.labelKey || !(g.labelKey in bn) || !(g.labelKey in en)) missing.push('group:' + g.id);
      for (const i of g.items) {
        if (!i.labelKey || !(i.labelKey in bn) || !(i.labelKey in en)) missing.push('item:' + i.href);
      }
    }
    expect(missing).toEqual([]);
  });

  test('প্রতিটা ফিচারের নাম ও বর্ণনা অনুবাদযোগ্য', () => {
    const missing = [];
    for (const f of registry.FEATURES) {
      for (const k of [f.labelKey, f.descriptionKey]) {
        if (!k || !(k in bn) || !(k in en)) missing.push(f.key + ':' + k);
      }
    }
    expect(missing).toEqual([]);
  });

  test('প্রতিটা ফিচার ক্যাটাগরি অনুবাদযোগ্য', () => {
    for (const c of Object.keys(registry.CATEGORIES)) {
      const k = registry.categoryLabelKey(c);
      expect(k).toBeTruthy();
      expect(bn[k]).toBeTruthy();
      expect(en[k]).toBeTruthy();
    }
  });
});

describe('আসল রেন্ডারে ভাষা বদলায়', () => {
  let bnAgent, enAgent;
  beforeAll(async () => {
    bnAgent = await makeAdminAgent(null);   // ডিফল্ট বাংলা
    enAgent = await makeAdminAgent('en');
  });

  test('Feature Management পেজ বাংলায় বাংলা টেক্সট দেখায়', async () => {
    const res = await bnAgent.get('/admin/features');
    expect(res.status).toBe(200);
    expect(res.text).toContain(bn.admin_ff_title);
    expect(res.text).toContain(bn.admin_ff_filter_all);
  });

  test('Feature Management পেজ ইংরেজিতে ইংরেজি টেক্সট দেখায়', async () => {
    const res = await enAgent.get('/admin/features');
    expect(res.status).toBe(200);
    expect(res.text).toContain(en.admin_ff_subtitle);
    // ইংরেজি মোডে বাংলা সাবটাইটেল থাকা চলবে না
    expect(res.text).not.toContain(bn.admin_ff_subtitle);
  });

  test('ফিচারের নাম/বর্ণনা ভাষা অনুযায়ী বদলায়', async () => {
    const resEn = await enAgent.get('/admin/features');
    expect(resEn.text).toContain(en.admin_ff_name_lucky_wheel);
    expect(resEn.text).not.toContain(bn.admin_ff_desc_lucky_wheel);
    const resBn = await bnAgent.get('/admin/features');
    expect(resBn.text).toContain(bn.admin_ff_name_lucky_wheel);
  });

  test('সাইডবার নেভিগেশন ভাষা অনুযায়ী বদলায়', async () => {
    // EJS `&` কে `&amp;` করে escape করে (যেমন "Security & Risk"), তাই
    // তুলনার আগে একই escape প্রয়োগ করা হয়।
    const esc = (v) => String(v).replace(/&/g, '&amp;');
    const resEn = await enAgent.get('/admin');
    expect(resEn.text).toContain(esc(en.admin_nav_security));
    const resBn = await bnAgent.get('/admin');
    expect(resBn.text).toContain(esc(bn.admin_nav_security));
  });

  test('ড্যাশবোর্ডের প্রায়োরিটি কিউ ভাষা অনুযায়ী বদলায়', async () => {
    const resEn = await enAgent.get('/admin');
    expect(resEn.text).toContain(en.admin_dash_needs_attention);
    expect(resEn.text).not.toContain(bn.admin_dash_needs_attention);
  });

  test('বন্ধ ফিচারের বার্তা ইউজারের ভাষায় যায়', async () => {
    const featureFlags = require('../../services/featureFlags');
    await pool.query("UPDATE feature_flags SET enabled=false WHERE key='lucky_wheel'");
    await featureFlags.invalidateCache();
    try {
      const { agent, token } = await getCsrfAgent('/register');
      await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
        .send({ username: uniqueUsername('locu'), phone: uniquePhone(), password: 'SecurePass123',
                confirmPassword: 'SecurePass123', _csrf: token });
      await agent.get('/lang/en');
      const res = await agent.get('/profile/wheel');
      expect(res.status).toBe(403);
      expect(res.text).toContain(en.feature_currently_disabled);
    } finally {
      await pool.query("UPDATE feature_flags SET enabled=true WHERE key='lucky_wheel'");
      await featureFlags.invalidateCache();
    }
  });
});

describe('নতুন অ্যাডমিন টেমপ্লেটে হার্ডকোড টেক্সট বাকি নেই', () => {
  // যেসব ফাইল Phase 10-এ লোকালাইজ করা হয়েছে — সেখানে যেন নতুন হার্ডকোড
  // বাংলা/ইংরেজি UI টেক্সট ফিরে না আসে।
  test('feature-flags.ejs-এ রেন্ডার হওয়া হার্ডকোড বাংলা নেই', () => {
    const src = fs.readFileSync(path.join(ROOT, 'views/admin/feature-flags.ejs'), 'utf8');
    // কমেন্ট বাদ দিয়ে যাচাই
    const withoutComments = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const bengali = withoutComments.match(/[\u0980-\u09FF]{3,}/g) || [];
    expect(bengali).toEqual([]);
  });
});
