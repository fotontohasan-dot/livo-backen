// ==================== বাজির ওপর ৩-ধাপ রেফারেল কমিশন: সম্পূর্ণ বন্ধ (আসল Postgres) ====================
// সিদ্ধান্ত: বাজি ধরলে কোনো ধাপে (টিয়ার ১/২/৩) কোনো কমিশন নেই — রেফারারের ব্যালেন্স অপরিবর্তিত,
// referral_commissions/coin_transactions-এ কোনো সারি নেই।
const { pool } = require('../../db');
const settings = require('../../services/settings');
const { distributeCommission, getCommissionRates, DEFAULT_COMMISSION_RATES } = require('../../services/referral');
const accumulator = require('../../services/accumulator');
const { makeUser, link, coins, cleanup } = require('../helpers/referralDeposit');

const KEYS = [
  'referral_commission_tier1_percent', 'referral_commission_tier2_percent', 'referral_commission_tier3_percent',
  'referral_bet_commission_enabled'
];
const DEPTH = { A: { name: 'Alpha', back: 2.0, lay: 2.5 }, B: { name: 'Beta', back: 3.0, lay: 3.4 } };

async function setSetting(key, value) {
  if (value === null) await pool.query('DELETE FROM site_settings WHERE key = $1', [key]);
  else await pool.query(
    `INSERT INTO site_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value]);
}
async function applySettings(map) {
  for (const [k, v] of Object.entries(map)) await setSetting(k, v);
  await settings.invalidateSettingsCache();
}
async function commissionRows(ids) {
  const rc = await pool.query('SELECT COUNT(*)::int AS n FROM referral_commissions WHERE earner_id = ANY($1::int[]) AND reason = \'commission\'', [ids]);
  const ct = await pool.query('SELECT COUNT(*)::int AS n FROM coin_transactions WHERE user_id = ANY($1::int[]) AND type = \'referral_commission\'', [ids]);
  return { rc: rc.rows[0].n, ct: ct.rows[0].n };
}
async function makeMarket() {
  const m = await pool.query(
    `INSERT INTO matches (title, team_a, team_b, sport, status, provider, synced_at)
     VALUES ('CommissionOffTest','Alpha','Beta','cricket','live',NULL,NULL) RETURNING id`);
  const mk = await pool.query(
    `INSERT INTO markets (match_id, type, name, odds, depth, status) VALUES ($1,'bookmaker','Bookmaker',$2,$3,'open') RETURNING id`,
    [m.rows[0].id, JSON.stringify({ A: 2.0, B: 3.0 }), JSON.stringify(DEPTH)]);
  return { matchId: m.rows[0].id, marketId: mk.rows[0].id };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('বাজির ওপর ৩-ধাপ রেফারেল কমিশন বন্ধ', () => {
  jest.setTimeout(60000);
  let saved = {};
  let top; let mid; let direct; let bettor; let all;

  beforeAll(async () => {
    const r = await pool.query('SELECT key, value FROM site_settings WHERE key = ANY($1::text[])', [KEYS]);
    saved = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  });
  afterAll(async () => {
    for (const k of KEYS) await setSetting(k, Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : null);
    await settings.invalidateSettingsCache();
    await pool.query("UPDATE matches SET status = 'finished' WHERE title = 'CommissionOffTest'");
  });
  beforeEach(async () => {
    // শৃঙ্খল: top ← mid ← direct ← bettor (bettor-এর টিয়ার১=direct, টিয়ার২=mid, টিয়ার৩=top)
    top = await makeUser('t3'); mid = await makeUser('t2'); direct = await makeUser('t1');
    bettor = await makeUser('bt', { coins: 5000 });
    await link(top, mid); await link(mid, direct); await link(direct, bettor);
    all = [top, mid, direct];
  });
  afterEach(async () => { await cleanup([top, mid, direct, bettor]); });

  test('ডিফল্ট: নতুন DB-র সিড ও কোড-ডিফল্ট দুটোই ০', async () => {
    expect(DEFAULT_COMMISSION_RATES).toEqual([0, 0, 0]);
    // সিড করা সারি (নতুন DB) থাকলে ০
    const seeded = await pool.query(
      "SELECT key, value FROM site_settings WHERE key LIKE 'referral_commission_tier%_percent' ORDER BY key");
    for (const row of seeded.rows) expect(Number(row.value)).toBe(0);
    // সারি না থাকলেও settings.js-এর DEFAULTS থেকে ০
    await applySettings({ referral_commission_tier1_percent: null, referral_commission_tier2_percent: null, referral_commission_tier3_percent: null });
    expect(await getCommissionRates()).toEqual([0, 0, 0]);
  });

  test('মাস্টার সুইচ চালু + হার ০/০/০: distributeCommission কিছুই যোগ করে না', async () => {
    await applySettings({
      referral_bet_commission_enabled: 'true',
      referral_commission_tier1_percent: '0', referral_commission_tier2_percent: '0', referral_commission_tier3_percent: '0'
    });
    const before = await Promise.all(all.map(coins));
    await distributeCommission(bettor, 10000);
    expect(await Promise.all(all.map(coins))).toEqual(before);
    expect(await commissionRows(all)).toEqual({ rc: 0, ct: 0 });
  });

  test('মাস্টার সুইচ চালু + হার সেটিং অনুপস্থিত (DEFAULTS): কিছুই যোগ হয় না', async () => {
    await applySettings({
      referral_bet_commission_enabled: 'true',
      referral_commission_tier1_percent: null, referral_commission_tier2_percent: null, referral_commission_tier3_percent: null
    });
    const before = await Promise.all(all.map(coins));
    await distributeCommission(bettor, 10000);
    expect(await Promise.all(all.map(coins))).toEqual(before);
    expect(await commissionRows(all)).toEqual({ rc: 0, ct: 0 });
  });

  test('আসল বাজি (placeAccumulator) ধরলে রেফারারদের ব্যালেন্স অপরিবর্তিত, কমিশন-সারি নেই', async () => {
    await applySettings({
      referral_bet_commission_enabled: 'true',
      referral_commission_tier1_percent: '0', referral_commission_tier2_percent: '0', referral_commission_tier3_percent: '0'
    });
    const a = await makeMarket(); const b = await makeMarket();
    const before = await Promise.all(all.map(coins));
    const r = await accumulator.placeAccumulator(bettor, 1000, [
      { match_id: a.matchId, market_id: a.marketId, runner: 'A' },
      { match_id: b.matchId, market_id: b.marketId, runner: 'A' }
    ], 'en');
    expect(r.success).toBe(true);
    expect(await coins(bettor)).toBe(4000); // বাজি সত্যিই ধরা হয়েছে
    await sleep(1500); // distributeCommission fire-and-forget — শেষ হওয়ার সময় দেওয়া
    expect(await Promise.all(all.map(coins))).toEqual(before);
    expect(await commissionRows(all)).toEqual({ rc: 0, ct: 0 });
  });

  test('নিয়ন্ত্রণ (টেস্ট ফাঁকা নয়): হার >০ ও সুইচ চালু হলে মেশিনারি কমিশন দেয়', async () => {
    await applySettings({
      referral_bet_commission_enabled: 'true',
      referral_commission_tier1_percent: '2.5', referral_commission_tier2_percent: '1.5', referral_commission_tier3_percent: '0.8'
    });
    await distributeCommission(bettor, 10000);
    expect(await coins(direct)).toBe(250);
    expect(await coins(mid)).toBe(150);
    expect(await coins(top)).toBe(80);
  });

  test('মাস্টার সুইচ বন্ধ (ডিফল্ট) হলে হার >০ হলেও কমিশন নেই', async () => {
    await applySettings({
      referral_bet_commission_enabled: 'false',
      referral_commission_tier1_percent: '2.5', referral_commission_tier2_percent: '1.5', referral_commission_tier3_percent: '0.8'
    });
    await distributeCommission(bettor, 10000);
    expect(await Promise.all(all.map(coins))).toEqual([0, 0, 0]);
    expect(await commissionRows(all)).toEqual({ rc: 0, ct: 0 });
  });
});
