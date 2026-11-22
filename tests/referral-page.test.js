// ==================== ইউজার রেফারেল পাতা (আসল Postgres) ====================
// নিজের ডেটা মাত্র, শেয়ার-লিংক escape, ক্লিক→সাইন-আপ→ডিপোজিট গণনা, ডুপ্লিকেট/বট ক্লিক বাদ, পরের ধাপ।
const { getCsrfAgent, uniqueUsername, uniquePhone, REALISTIC_UA } = require('./helpers/app');
const { pool } = require('../db');
const { makeDeposit, cleanup } = require('./helpers/referralDeposit');
const { getReferralStats, computeNextStep } = require('../services/referral');
const { recordReferralClick, visitorHash } = require('../services/referralClicks');

const created = [];
const UA2 = REALISTIC_UA.replace(/Chrome\/\d+/, 'Chrome/99');

async function signup(refCode) {
  const { agent, token } = await getCsrfAgent('/register');
  const username = uniqueUsername();
  await agent.post('/register').set('User-Agent', REALISTIC_UA).type('form').send({
    username, phone: uniquePhone(), password: 'SecurePass123', confirmPassword: 'SecurePass123',
    referralCode: refCode || '', _csrf: token
  });
  const row = (await pool.query('SELECT id, referral_code FROM users WHERE username=$1', [username])).rows[0];
  created.push(row.id);
  return { agent, username, id: row.id, code: row.referral_code };
}
const page = async (u, lang) => {
  if (lang) await u.agent.get('/lang/' + lang);
  const r = await u.agent.get('/profile/referral');
  expect(r.status).toBe(200);
  return r.text;
};
const clicks = async (id) => Number((await pool.query('SELECT COUNT(*) FROM referral_clicks WHERE referrer_id=$1', [id])).rows[0].count);
async function waitClicks(id, n) {
  for (let i = 0; i < 40; i++) { if ((await clicks(id)) >= n) return; await new Promise((r) => setTimeout(r, 50)); }
}

describe('ইউজার রেফারেল পাতা', () => {
  jest.setTimeout(120000);
  afterAll(async () => { await cleanup(created); });

  test('শুধু নিজের ডেটা: সংখ্যা, আয়, বন্ধুর নাম — অন্যের নয়', async () => {
    const A = await signup();
    const B = await signup();
    const a1 = await signup(A.code);
    const a2 = await signup(A.code);
    const b1 = await signup(B.code);
    // A: a1 সফল (পেআউট ১০০), a2 অপেক্ষমাণ; আয় ৪৩২১। B: আয় ৮৭৬৫
    const dep = await makeDeposit(a1.id, 600, { status: 'approved' });
    await pool.query(
      `INSERT INTO referral_rewards (referred_user_id, referrer_id, status, tier, amount, qualifying_deposit_id, paid_at)
       VALUES ($1,$2,'paid',1,75,$3,NOW())`, [a1.id, A.id, dep]);
    await pool.query(`INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason) VALUES ($1,$2,1,4321,'commission')`, [A.id, a1.id]);
    await pool.query(`INSERT INTO referral_commissions (earner_id, from_user_id, level, amount, reason) VALUES ($1,$2,1,8765,'commission')`, [B.id, b1.id]);

    const st = await getReferralStats(A.id);
    expect([st.totalReferrals, st.successfulReferrals, st.pendingReferrals, st.totalEarnings]).toEqual([2, 1, 1, 4321]);
    expect(st.funnel.signups).toBe(2);
    expect(st.funnel.deposits).toBe(1);

    const html = await page(A, 'en');
    expect(html).toContain('4,321');
    expect(html).toContain(a1.username);
    expect(html).toContain(a2.username);
    expect(html).toContain(`ref=${A.code}`);
    expect(html).not.toContain('8,765');
    expect(html).not.toContain(b1.username);
    expect(html).not.toContain(B.code);
    const htmlB = await page(B, 'en');
    expect(htmlB).toContain('8,765');
    expect(htmlB).not.toContain('4,321');
    expect(htmlB).not.toContain(a1.username);
  });

  test('কমিশনের সরল বাক্য (আসল রেট) ও কোনো ফ্রি বেট/রেফার-করা ইউজারের জন্য বোনাস-কথা নেই', async () => {
    const U = await signup();
    for (const lang of ['en', 'bn']) {
      const html = await page(U, lang);
      expect(html).toContain('0.8%'.replace('0.8', lang === 'en' ? '0.8' : '0.8')); // রেট সংখ্যা
      expect(html).toMatch(/2\.5%/);
      expect(html).not.toMatch(/free\s*bet|ফ্রি\s*বেট/i);
    }
    const bn = await page(U, 'bn');
    expect(bn).toContain('আজীবন কমিশন');
    // রেফার-করা ইউজারের সাইন-আপ পাতা রেফারারের বোনাসের কথা বলে না
    const reg = await U.agent.get(`/register?ref=${U.code}`).set('User-Agent', UA2);
    expect(reg.text).not.toMatch(/referred friend makes their first deposit|আপনার রেফার করা বন্ধু প্রথম ডিপোজিট/);
    expect(reg.text).not.toMatch(/free\s*bet|ফ্রি\s*বেট/i);
  });

  test('শেয়ার বাটন: WhatsApp/Telegram/Facebook/Messenger, URL-escaped, javascript: নেই; কোডে HTML থাকলেও escape', async () => {
    const U = await signup();
    const evil = '"><img src=x>&a=1\'';  // ≤২০ অক্ষর (referral_code varchar(20))
    await pool.query('UPDATE users SET referral_code=$1 WHERE id=$2', [evil, U.id]);
    const html = await page(U, 'en');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toMatch(/href="\s*javascript:/i);
    const hrefs = [...html.matchAll(/class="rf-share-btn[^"]*" href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    expect(hrefs.length).toBe(4);
    expect(hrefs[0]).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(hrefs[1]).toMatch(/^https:\/\/t\.me\/share\/url\?url=/);
    expect(hrefs[2]).toMatch(/^https:\/\/www\.facebook\.com\/sharer\/sharer\.php\?u=/);
    expect(hrefs[3]).toMatch(/^fb-messenger:\/\/share\/\?link=/);
    const strict = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    hrefs.forEach((h) => { expect(h).not.toMatch(/[<>"' ]/); expect(h).toContain(strict(strict(evil))); });
    expect(html).not.toContain('&#39;&gt;'); // কোড একবারও কাঁচা আকারে href-এ নেই
  });

  test('ক্লিক গণনা: ডুপ্লিকেট একবার, ভিন্ন দর্শক আলাদা, বট/প্রিভিউ/অবৈধ কোড/নিজের লিংক বাদ; কাঁচা IP নেই', async () => {
    const R = await signup();
    const g = (ua) => R.agent.constructor && require('supertest')(require('../app')).get(`/register?ref=${R.code}`).set('User-Agent', ua);
    await g(REALISTIC_UA); await waitClicks(R.id, 1);
    await g(REALISTIC_UA); await g(REALISTIC_UA);
    await new Promise((r) => setTimeout(r, 400));
    expect(await clicks(R.id)).toBe(1);
    await g(UA2); await waitClicks(R.id, 2);
    expect(await clicks(R.id)).toBe(2);
    await g('WhatsApp/2.23 A'); await g('facebookexternalhit/1.1'); await g('TelegramBot (like TwitterBot)');
    await require('supertest')(require('../app')).get('/register?ref=NOPE-NO-SUCH').set('User-Agent', UA2);
    await new Promise((r) => setTimeout(r, 400));
    expect(await clicks(R.id)).toBe(2);
    // সার্ভিস-স্তরে: নিজের লিংক, ডুপ্লিকেট
    expect(await recordReferralClick({ code: R.code, ip: '9.9.9.9', userAgent: UA2, viewerId: R.id })).toBe(false);
    expect(await recordReferralClick({ code: R.code, ip: '9.9.9.9', userAgent: UA2 })).toBe(true);
    expect(await recordReferralClick({ code: R.code, ip: '9.9.9.9', userAgent: UA2 })).toBe(false);
    const rows = (await pool.query('SELECT visitor_hash FROM referral_clicks WHERE referrer_id=$1', [R.id])).rows;
    rows.forEach((r) => expect(r.visitor_hash).toMatch(/^[0-9a-f]{64}$/));
    expect(rows.map((r) => r.visitor_hash)).toContain(visitorHash('9.9.9.9', UA2));
    expect(JSON.stringify(rows)).not.toContain('9.9.9.9');
  });

  test('ফানেল: ক্লিক → সাইন-আপ → ডিপোজিট (শুধু নিজের)', async () => {
    const R = await signup();
    const other = await signup();
    await recordReferralClick({ code: R.code, ip: '1.1.1.1', userAgent: REALISTIC_UA });
    await recordReferralClick({ code: R.code, ip: '1.1.1.2', userAgent: REALISTIC_UA });
    await recordReferralClick({ code: other.code, ip: '1.1.1.3', userAgent: REALISTIC_UA });
    const f1 = await signup(R.code);
    await signup(R.code);
    await makeDeposit(f1.id, 700, { status: 'approved' });
    await makeDeposit(f1.id, 300, { status: 'approved' }); // একই ইউজার দুবার ডিপোজিট করলেও ১ গোনা
    const st = await getReferralStats(R.id);
    expect(st.funnel).toEqual({ clicks: 2, signups: 2, deposits: 1 });
    const html = await page(R, 'en');
    expect(html).toContain('From link to deposit');
    expect((await getReferralStats(other.id)).funnel).toEqual({ clicks: 1, signups: 0, deposits: 0 });
  });

  test('পরের ধাপ: প্রথম / উপরে ওঠা / সর্বোচ্চ', () => {
    const info = { mode: 'slab', slabs: [{ min: 500, amount: 75 }, { min: 1000, amount: 100 }, { min: 5000, amount: 300 }] };
    expect(computeNextStep(info, null)).toEqual({ kind: 'first', min: 500, amount: 75 });
    expect(computeNextStep(info, 600)).toEqual({ kind: 'up', deposit: 600, min: 1000, amount: 100, delta: 400 });
    expect(computeNextStep(info, 300)).toEqual({ kind: 'up', deposit: 300, min: 500, amount: 75, delta: 200 });
    expect(computeNextStep(info, 7000)).toEqual({ kind: 'top' });
    expect(computeNextStep({ mode: 'tier', slabs: [] }, 600)).toBeNull();
  });
});
