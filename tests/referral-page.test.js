// ==================== ইউজার রেফারেল পাতা (আসল Postgres) ====================
// পরের ধাপ (first/up/max), ফ্রি বেট/রেফার-করা ইউজারের বোনাস-কথা নেই, দূষিত referral_code-এ escape, শুধু নিজের ডেটা, শেয়ার-লিংক।
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');
const { makeUser, link, makeDeposit, cleanup } = require('./helpers/referralDeposit');
const { computeNextStep, buildShareLinks } = require('../services/referral');

const PASSWORD = 'ReferralPass123';
const created = [];

async function signup() {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername('rf');
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form')
    .send({ username, phone: uniquePhone(), password: PASSWORD, confirmPassword: PASSWORD, _csrf: token });
  const row = (await pool.query('SELECT id, referral_code FROM users WHERE username = $1', [username])).rows[0];
  created.push(row.id);
  return { agent, token, username, id: row.id, code: row.referral_code };
}

async function relogin(R) {
  const { agent, token } = await getCsrfAgent('/login');
  await agent.post('/login').type('form').send({ identifier: R.username, password: PASSWORD, _csrf: token });
  return agent;
}

async function friend(referrerId, deposit) {
  const id = await makeUser('fr');
  created.push(id);
  await link(referrerId, id);
  if (deposit) await makeDeposit(id, deposit, { status: 'approved' });
  return id;
}

const stepOf = (html) => (/id="ref-next-step" data-state="(\w+)"/.exec(html) || [])[1];

afterAll(async () => { await cleanup(created); });

describe('computeNextStep (খাঁটি ফাংশন)', () => {
  const slabs = [{ min: 500, amount: 75 }, { min: 1000, amount: 100 }, { min: 30000, amount: 1000 }];
  test('তিন অবস্থা: first / up / max', () => {
    expect(computeNextStep(0, slabs)).toEqual({ state: 'first', needDeposit: 500, bonus: 75 });
    expect(computeNextStep(499, slabs).state).toBe('first');
    expect(computeNextStep(500, slabs)).toEqual({ state: 'up', needDeposit: 1000, bonus: 100 });
    expect(computeNextStep(1000, slabs)).toEqual({ state: 'up', needDeposit: 30000, bonus: 1000 });
    expect(computeNextStep(30000, slabs)).toEqual({ state: 'max', needDeposit: null, bonus: 1000 });
    expect(computeNextStep(99999, slabs).state).toBe('max');
  });
});

describe('ইউজার রেফারেল পাতা', () => {
  test('পরের ধাপ: বন্ধুর সর্বোচ্চ যোগ্য ডিপোজিট থেকে তিন অবস্থা', async () => {
    const R = await signup();
    let html = (await R.agent.get('/profile/referral')).text;
    expect(stepOf(html)).toBe('first');
    expect(html).toContain('৫০০');

    const f = await friend(R.id, 500);
    await makeDeposit(f, 300, { status: 'approved' });                 // ছোট ডিপোজিট সর্বোচ্চ বদলায় না
    await makeDeposit(f, 99999, { status: 'pending' });                // pending গণ্য নয়
    html = (await R.agent.get('/profile/referral')).text;
    expect(stepOf(html)).toBe('up');
    expect(html).toContain('১,০০০');                                   // পরের ধাপের ন্যূনতম ডিপোজিট

    await friend(R.id, 30000);
    html = (await R.agent.get('/profile/referral')).text;
    expect(stepOf(html)).toBe('max');
  });

  test('ফ্রি বেট ও রেফার-করা ইউজারের বোনাসের কথা পাতায় নেই (bn ও en)', async () => {
    const R = await signup();
    await friend(R.id, 1000);
    for (const lang of ['bn', 'en']) {
      await R.agent.get(`/lang/${lang}`);
      const html = (await R.agent.get('/profile/referral')).text;
      expect(html).not.toMatch(/ফ্রি বেট|free\s*bet|freebet/i);
      expect(html).not.toMatch(/First Deposit Bonus|সাইন-আপে কোনো রেফারেল বোনাস|no referral bonus at sign-up/i);
      expect(html).toMatch(lang === 'en' ? /earn 0\.8% for life/ : /আজীবন ০\.৮%/);
    }
  });

  test('দূষিত referral_code-এ সর্বত্র escape; শেয়ার href percent-encoded, javascript: নেই', async () => {
    const R = await signup();
    const evil = '"><b onx=1>&\'<s>'; // referral_code VARCHAR(20)-এ আঁটে
    await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [evil, R.id]);
    const agent = await relogin(R);
    const res = await agent.get('/profile/referral');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<b onx=1>');
    expect(res.text).not.toContain('"><b');
    expect(res.text).not.toContain('<s>');
    expect(res.text).not.toMatch(/href="javascript:/i);
    const hrefs = [...res.text.matchAll(/id="ref-share-\w+" href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(4);
    for (const h of hrefs) {
      expect(h).not.toMatch(/[<>"' ]/);
      expect(h).toMatch(/^(https:\/\/(wa\.me|t\.me|www\.facebook\.com)\/|fb-messenger:\/\/share)/);
    }
    expect(res.text).toContain('%3Cb%20onx%3D1%3E');
  });

  test('চার শেয়ার বাটন (WhatsApp/Telegram/Facebook/Messenger) + বিদ্যমান share/copy অ্যাকশন', async () => {
    const R = await signup();
    const html = (await R.agent.get('/profile/referral')).text;
    expect(html).toMatch(/id="ref-share-whatsapp" href="https:\/\/wa\.me\/\?text=/);
    expect(html).toMatch(/id="ref-share-telegram" href="https:\/\/t\.me\/share\/url\?url=/);
    expect(html).toMatch(/id="ref-share-facebook" href="https:\/\/www\.facebook\.com\/sharer\/sharer\.php\?u=/);
    expect(html).toMatch(/id="ref-share-messenger" href="fb-messenger:\/\/share\/\?link=/);
    expect(html).toContain('data-referral-action="share"');
    expect(html).toContain('data-referral-action="copy"');
    expect(html).toContain(encodeURIComponent(`/register?ref=${R.code}`));
    const s = buildShareLinks('https://x.test', 'A B&C', 'hi there');
    expect(s.link).toBe('https://x.test/register?ref=A%20B%26C');
    expect(buildShareLinks('https://x.test', null, 'x')).toBeNull();
  });

  test('শুধু নিজের ডেটা: অন্যের বন্ধু/আয় দেখা যায় না; সংখ্যা ভাষা অনুযায়ী', async () => {
    const A = await signup();
    const B = await signup();
    const fa = await friend(A.id, 1000);
    const fb = await friend(B.id, 2000);
    await pool.query(`INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason) VALUES ($1,$2,1,1234,'loss')`, [A.id, fa]);
    await pool.query(`INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason) VALUES ($1,$2,1,777,'loss')`, [B.id, fb]);
    const fbName = (await pool.query('SELECT username FROM users WHERE id = $1', [fb])).rows[0].username;

    let html = (await A.agent.get('/profile/referral')).text;
    expect(html).not.toContain(fbName);
    expect(html).not.toContain('777');
    expect(html).toMatch(/id="ref-total">১</);
    expect(html).toMatch(/id="ref-earnings">১,২৩৪</);
    expect(html).toContain(encodeURIComponent(`ref=${A.code}`));
    expect(html).not.toContain(encodeURIComponent(`ref=${B.code}`));

    await A.agent.get('/lang/en');
    html = (await A.agent.get('/profile/referral')).text;
    expect(html).toMatch(/id="ref-earnings">1,234</);
    expect(html).toMatch(/id="ref-total">1</);
  });
});
