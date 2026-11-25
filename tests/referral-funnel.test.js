// ==================== ক্লিক→সাইন-আপ→ডিপোজিট ফানেল (আসল Postgres) ====================
const { freshRequest, getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');
const { makeUser, link, makeDeposit, cleanup } = require('./helpers/referralDeposit');
const { visitorHash } = require('../services/referralClicks');

const PASSWORD = 'ReferralPass123';
const created = [];
const UA2 = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';

async function signup() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('fn');
  await agent.post('/register').type('form')
    .send({ username, phone: uniquePhone(), password: PASSWORD, confirmPassword: PASSWORD, _csrf: token });
  const row = (await pool.query('SELECT id, referral_code FROM users WHERE username = $1', [username])).rows[0];
  created.push(row.id);
  return { agent, username, id: row.id, code: row.referral_code };
}
const rows = async (id) => (await pool.query('SELECT * FROM referral_clicks WHERE referrer_user_id = $1', [id])).rows;
const click = (code, ip, ua) => freshRequest(ip).get(`/register?ref=${encodeURIComponent(code)}`).set('User-Agent', ua || REALISTIC_UA);
const val = (html, id) => Number((new RegExp(`id="ref-funnel-${id}">([\\d,]+)<`).exec(html) || [])[1].replace(/,/g, ''));

afterAll(async () => {
  await pool.query('DELETE FROM referral_clicks WHERE referrer_user_id = ANY($1::int[])', [created]).catch(() => {});
  await cleanup(created);
});

describe('referral_clicks', () => {
  test('একই দর্শক+দিনে ডুপ্লিকেট ক্লিক একটাই; ভিন্ন দর্শক আলাদা', async () => {
    const R = await signup();
    const ip = '198.51.100.10';
    for (let i = 0; i < 3; i++) expect((await click(R.code, ip)).status).toBe(200);
    expect(await rows(R.id)).toHaveLength(1);
    await click(R.code, ip, UA2);
    await click(R.code, '198.51.100.11');
    expect(await rows(R.id)).toHaveLength(3);
  });

  test('concurrent ক্লিকেও একটাই', async () => {
    const R = await signup();
    const rs = await Promise.all(Array.from({ length: 12 }, () => click(R.code, '198.51.100.20')));
    rs.forEach(r => expect(r.status).toBe(200));
    expect(await rows(R.id)).toHaveLength(1);
  });

  test('ক্রলার/বট UA, নিজের লিংক, অবৈধ ও অজানা কোড বাদ', async () => {
    const R = await signup();
    await click(R.code, '198.51.100.30', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
    await click(R.code, '198.51.100.31', 'facebookexternalhit/1.1');
    await click(R.code, '198.51.100.32', 'WhatsApp/2.23 bot preview');
    expect(await rows(R.id)).toHaveLength(0);
    // লগইন-করা নিজের লিংক
    const own = await R.agent.get(`/register?ref=${encodeURIComponent(R.code)}`);
    expect(own.status).toBeLessThan(500);
    expect(await rows(R.id)).toHaveLength(0);
    // অবৈধ / অজানা
    const before = (await pool.query('SELECT COUNT(*)::int AS c FROM referral_clicks')).rows[0].c;
    for (const bad of ['"><script>alert(1)</script>', "x'; DROP TABLE users;--", 'NOSUCHCODE999', 'a'.repeat(200)]) {
      expect((await click(bad, '198.51.100.33')).status).toBe(200);
    }
    expect((await pool.query('SELECT COUNT(*)::int AS c FROM referral_clicks')).rows[0].c).toBe(before);
  });

  test('কাঁচা IP/UA DB-তে নেই; hash = HMAC(IP+UA)', async () => {
    const R = await signup();
    const ip = '203.0.113.77';
    await click(R.code, ip, UA2);
    const r = await rows(R.id);
    expect(r).toHaveLength(1);
    const dump = JSON.stringify(r[0]);
    expect(dump).not.toContain(ip);
    expect(dump).not.toContain('Pixel');
    expect(r[0].visitor_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r[0].visitor_hash).toBe(visitorHash(ip, UA2));
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='referral_clicks'`)).rows.map(x => x.column_name).sort();
    expect(cols).toEqual(['click_day', 'created_at', 'id', 'referrer_user_id', 'visitor_hash']);
    const all = (await pool.query(`SELECT COUNT(*)::int AS c FROM referral_clicks WHERE visitor_hash::text LIKE '%203.0.113.77%'`)).rows[0].c;
    expect(all).toBe(0);
  });

  test('click_day = বাংলাদেশ (Asia/Dhaka) দিন', async () => {
    const R = await signup();
    await click(R.code, '198.51.100.40');
    const r = (await pool.query(
      `SELECT to_char(click_day,'YYYY-MM-DD') AS d, to_char(NOW() AT TIME ZONE 'Asia/Dhaka','YYYY-MM-DD') AS dhaka FROM referral_clicks WHERE referrer_user_id = $1`, [R.id])).rows[0];
    expect(r.d).toBe(r.dhaka);
  });

  test('ক্লিক রেকর্ডে ব্যর্থ হলেও পেজ লোড হয়', async () => {
    const R = await signup();
    const orig = pool.query.bind(pool);
    const spy = jest.spyOn(pool, 'query').mockImplementation((sql, ...a) =>
      (typeof sql === 'string' && sql.includes('INSERT INTO referral_clicks')) ? Promise.reject(new Error('boom')) : orig(sql, ...a));
    try {
      const res = await click(R.code, '198.51.100.50');
      expect(res.status).toBe(200);
    } finally { spy.mockRestore(); }
    expect(await rows(R.id)).toHaveLength(0);
  });
});

describe('ফানেল সংখ্যা (referral পাতা)', () => {
  test('ক্লিক / সাইন-আপ / approved-ডিপোজিট ঠিক; অন্যের ডেটা দেখা যায় না', async () => {
    const A = await signup();
    const B = await signup();
    for (let i = 0; i < 3; i++) await click(A.code, `198.51.100.${60 + i}`);
    for (let i = 0; i < 5; i++) await click(B.code, `198.51.100.${70 + i}`);
    const f1 = await makeUser('fr'); const f2 = await makeUser('fr'); const f3 = await makeUser('fr'); const fb = await makeUser('fr');
    created.push(f1, f2, f3, fb);
    await link(A.id, f1); await link(A.id, f2); await link(A.id, f3);
    await link(B.id, fb);
    await makeDeposit(f1, 600, { status: 'approved' });
    await makeDeposit(f1, 700, { status: 'approved' });   // একই ইউজার — একবারই গোনা
    await makeDeposit(f2, 800, { status: 'pending' });    // approved নয়
    await makeDeposit(fb, 900, { status: 'approved' });   // অন্য রেফারারের
    await A.agent.get('/lang/en');
    let html = (await A.agent.get('/profile/referral')).text;
    expect(val(html, 'clicks')).toBe(3);
    expect(val(html, 'signups')).toBe(3);
    expect(val(html, 'deposits')).toBe(1);
    await B.agent.get('/lang/en');
    html = (await B.agent.get('/profile/referral')).text;
    expect(val(html, 'clicks')).toBe(5);
    expect(val(html, 'signups')).toBe(1);
    expect(val(html, 'deposits')).toBe(1);
  });

  test('পাতায় ফ্রি বেট/রেফার-করা ইউজারের বোনাসের কথা নেই (নতুন ব্লকে)', async () => {
    const R = await signup();
    await R.agent.get('/lang/en');
    const html = (await R.agent.get('/profile/referral')).text;
    const blk = html.slice(html.indexOf('id="ref-funnel"'), html.indexOf('id="ref-total"'));
    expect(blk).not.toMatch(/free\s*bet|bonus|ফ্রি|বোনাস/i);
  });

  test('দূষিত referral_code-এ escape ঠিক', async () => {
    const R = await signup();
    const evil = '"><img src=x o=1>';
    await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [evil, R.id]);
    const html = (await R.agent.get('/profile/referral')).text;
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(encodeURIComponent(evil));
    expect(html).toContain('id="ref-funnel"');
  });
});
