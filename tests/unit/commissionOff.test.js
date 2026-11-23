'use strict';
// বাজির ওপর ৩-ধাপ রেফারেল কমিশন ডিফল্টে বন্ধ; হার দিলে চালু (নিয়ন্ত্রণ)।
// টার্নওভার ডিফল্ট ৫ — খালি DB-তে ৫, বিদ্যমান সেভ-করা মান অক্ষত।
const { pool } = require('../../db');
const settings = require('../../services/settings');
const referral = require('../../services/referral');

const KEYS = ['referral_commission_tier1_percent', 'referral_commission_tier2_percent', 'referral_commission_tier3_percent'];
let seq = 0;
const mk = async (tag) => {
  const u = `co${Date.now()}${++seq}${tag}`;
  const r = await pool.query(
    `INSERT INTO users (username, password, coins) VALUES ($1,'x',1000) RETURNING id`, [u]);
  return r.rows[0].id;
};
const snap = async (ids) => {
  const coins = (await pool.query('SELECT id, coins FROM users WHERE id = ANY($1) ORDER BY id', [ids])).rows;
  const comm = Number((await pool.query('SELECT COUNT(*) FROM referral_commissions WHERE earner_id = ANY($1)', [ids])).rows[0].count);
  const tx = Number((await pool.query(`SELECT COUNT(*) FROM coin_transactions WHERE user_id = ANY($1) AND type='referral_commission'`, [ids])).rows[0].count);
  return { coins, comm, tx };
};
let saved;
beforeAll(async () => {
  saved = (await pool.query('SELECT key, value FROM site_settings WHERE key = ANY($1)', [[...KEYS, 'turnover_multiplier']])).rows;
});
afterAll(async () => {
  await pool.query('DELETE FROM site_settings WHERE key = ANY($1)', [[...KEYS, 'turnover_multiplier']]);
  for (const r of saved) await pool.query('INSERT INTO site_settings (key, value) VALUES ($1,$2)', [r.key, r.value]);
  await settings.invalidateSettingsCache();
});

describe('৩-ধাপ কমিশন বন্ধ', () => {
  let a, b, c, d;
  beforeEach(async () => {
    a = await mk('a'); b = await mk('b'); c = await mk('c'); d = await mk('d');
    await pool.query('INSERT INTO referrals (referrer_id, referred_id) VALUES ($1,$2),($2,$3),($3,$4)', [a, b, c, d]);
  });

  test('ডিফল্ট (সারি নেই): বাজি ধরলে কারও ব্যালেন্স/কমিশন-সারি বদলায় না, ট্রানজ্যাকশনও খোলে না', async () => {
    await pool.query('DELETE FROM site_settings WHERE key = ANY($1)', [KEYS]);
    await settings.invalidateSettingsCache();
    expect(await referral.getCommissionRates()).toEqual([0, 0, 0]); // সেটিং ক্যাশে গরম
    const before = await snap([a, b, c, d]);
    const connect = jest.spyOn(pool, 'connect');
    await referral.distributeCommission(d, 1000);
    const calls = connect.mock.calls.length;
    connect.mockRestore();
    expect(calls).toBe(0); // কোনো connection/ট্রানজ্যাকশন খোলেনি
    expect(await snap([a, b, c, d])).toEqual(before);
  });

  test('নিয়ন্ত্রণ: হার দিলে কমিশন যায় (২.৫/১.৫/০.৮%)', async () => {
    for (const [k, v] of [[KEYS[0], '2.5'], [KEYS[1], '1.5'], [KEYS[2], '0.8']]) {
      await pool.query(`INSERT INTO site_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, v]);
    }
    await settings.invalidateSettingsCache();
    const before = await snap([a, b, c]);
    await referral.distributeCommission(d, 1000);
    const after = await snap([a, b, c]);
    expect(after.comm - before.comm).toBe(3);
    const got = Object.fromEntries(after.coins.map((r, i) => [r.id, Number(r.coins) - Number(before.coins[i].coins)]));
    expect(got[c]).toBe(25); expect(got[b]).toBe(15); expect(got[a]).toBe(8);
  });
});

describe('টার্নওভার ডিফল্ট ৫', () => {
  test('খালি DB-তে (সারি নেই) ডিফল্ট ৫', async () => {
    await pool.query(`DELETE FROM site_settings WHERE key='turnover_multiplier'`);
    await settings.invalidateSettingsCache();
    expect(String(await settings.getSetting('turnover_multiplier'))).toBe('5');
  });
  test('বিদ্যমান সেভ-করা মান (৩) অক্ষত', async () => {
    await pool.query(`INSERT INTO site_settings (key, value) VALUES ('turnover_multiplier','3') ON CONFLICT (key) DO UPDATE SET value='3'`);
    await settings.invalidateSettingsCache();
    expect(String(await settings.getSetting('turnover_multiplier'))).toBe('3');
  });
  test('সিড SQL: সারি না থাকলে ৫ বসে, থাকলে ON CONFLICT DO NOTHING-এ অক্ষত', async () => {
    const sql = `INSERT INTO site_settings (key, value) VALUES ('turnover_multiplier','5') ON CONFLICT (key) DO NOTHING`;
    await pool.query(`DELETE FROM site_settings WHERE key='turnover_multiplier'`);
    await pool.query(sql);
    expect((await pool.query(`SELECT value FROM site_settings WHERE key='turnover_multiplier'`)).rows[0].value).toBe('5');
    await pool.query(`UPDATE site_settings SET value='3' WHERE key='turnover_multiplier'`);
    await pool.query(sql);
    expect((await pool.query(`SELECT value FROM site_settings WHERE key='turnover_multiplier'`)).rows[0].value).toBe('3');
  });
  test('migrations.js সিডে turnover_multiplier ৫', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'migrations.js'), 'utf8');
    expect(src).toMatch(/\('turnover_multiplier', '5'\)/);
    expect(src).not.toMatch(/\('turnover_multiplier', '3'\)/);
  });
});
